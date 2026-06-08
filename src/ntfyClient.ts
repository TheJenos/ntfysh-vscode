import * as http from "http";
import * as https from "https";
import { URL } from "url";
import WebSocket from "ws";

/** A single message as delivered by the ntfy JSON stream. */
export interface NtfyMessage {
  id: string;
  time: number;
  event:
    | "open"
    | "keepalive"
    | "message"
    | "poll_request"
    | "message_clear"
    | "message_delete";
  topic: string;
  /**
   * Set when this message updates/clears/deletes a previous one. Notifications
   * sharing a sequence ID are linked together so clients can replace, mark as
   * read, or remove an existing notification.
   */
  sequence_id?: string;
  message?: string;
  title?: string;
  priority?: number;
  tags?: string[];
  click?: string;
  attachment?: { name: string; url: string };
}

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

/**
 * Transport used to receive messages: the long-lived HTTP JSON stream
 * (`/json`) or a WebSocket connection (`/ws`). Both multiplex every topic over
 * a single connection.
 */
export type ConnectionMethod = "http" | "websocket";

export interface NtfyClientOptions {
  server: string;
  /**
   * One or more topics multiplexed over a single connection. ntfy supports
   * subscribing to several topics in one HTTP call via a comma-separated list
   * in the URL (`<server>/topic1,topic2/json`).
   */
  topics: string[];
  token?: string;
  /** Transport used to receive messages. Defaults to `"http"`. */
  method?: ConnectionMethod;
}

export interface NtfyClientHandlers {
  onMessage: (msg: NtfyMessage) => void;
  onStateChange?: (state: ConnectionState) => void;
  onError?: (error: string) => void;
}

const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;

/** Network error codes that are usually worth retrying. */
const TRANSIENT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED"
]);

/**
 * Connection options that enable Node's "Happy Eyeballs" so a host with a dead
 * IPv6 route (common on servers) falls back to a working IPv4 address quickly
 * instead of failing. Older Node versions ignore the extra fields harmlessly.
 */
export const happyEyeballsOptions: {
  autoSelectFamily: boolean;
  autoSelectFamilyAttemptTimeout: number;
} = {
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 2000
};

/** Whether an error (including the legs of an AggregateError) looks transient. */
export function isTransientError(err: unknown): boolean {
  if (err && typeof err === "object") {
    if ("errors" in err && Array.isArray((err as { errors: unknown[] }).errors)) {
      return (err as { errors: unknown[] }).errors.some(isTransientError);
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code && TRANSIENT_CODES.has(code)) {
      return true;
    }
    const message = (err as Error).message;
    if (typeof message === "string" && /timed out|timeout/i.test(message)) {
      return true;
    }
  }
  return false;
}

/**
 * Produce a human-readable description of an unknown error. Unwraps
 * `AggregateError` (whose own `message` is usually empty) by joining the
 * descriptions of its inner errors, so failures like
 * `connect ECONNREFUSED ::1:443; connect ECONNREFUSED 127.0.0.1:443` surface
 * instead of a bare "AggregateError".
 */
export function describeError(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "errors" in err &&
    Array.isArray((err as { errors: unknown[] }).errors)
  ) {
    const agg = err as { errors: unknown[]; message?: string };
    const inner = agg.errors
      .map((e) => describeError(e))
      .filter(Boolean)
      .join("; ");
    return inner || agg.message || "multiple connection errors";
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return err.message || code || err.name || "connection error";
  }
  return String(err);
}

/**
 * Connects to one or more ntfy topics over a single connection — either the
 * newline-delimited HTTP JSON stream (`<server>/<topics>/json`) or a WebSocket
 * (`<server>/<topics>/ws`) — and automatically reconnects with exponential
 * backoff. A single connection multiplexes every topic, so only one connection
 * per server is maintained.
 */
export class NtfyClient {
  private request?: http.ClientRequest;
  private socket?: WebSocket;
  private buffer = "";
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer?: NodeJS.Timeout;
  private disposed = false;
  private _state: ConnectionState = "connecting";

  constructor(
    private readonly options: NtfyClientOptions,
    private readonly handlers: NtfyClientHandlers
  ) {}

  get topics(): string[] {
    return this.options.topics;
  }

  private get method(): ConnectionMethod {
    return this.options.method ?? "http";
  }

  /** Human-readable label for the multiplexed topics, e.g. `a, b, c`. */
  get label(): string {
    return this.options.topics.join(", ");
  }

  get state(): ConnectionState {
    return this._state;
  }

  start(): void {
    this.disposed = false;
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.closeConnection();
    this.setState("closed");
  }

  /** Force an immediate reconnect, resetting backoff. */
  reconnect(): void {
    this.closeConnection();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.backoff = INITIAL_BACKOFF_MS;
    this.connect();
  }

  /** Tear down whichever transport is currently active. */
  private closeConnection(): void {
    if (this.request) {
      this.request.destroy();
      this.request = undefined;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.terminate();
      this.socket = undefined;
    }
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) {
      return;
    }
    this._state = state;
    this.handlers.onStateChange?.(state);
  }

  private buildUrl(): URL {
    const base = this.options.server.replace(/\/+$/, "");
    // Encode each topic individually, then join with commas (the separator
    // ntfy expects between topics in a multi-topic subscription URL).
    const topics = this.options.topics.map((t) => encodeURIComponent(t)).join(",");
    if (this.method === "websocket") {
      // ntfy serves WebSocket subscriptions at `/ws`; map http(s) → ws(s).
      const wsBase = base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
      return new URL(`${wsBase}/${topics}/ws`);
    }
    return new URL(`${base}/${topics}/json`);
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "User-Agent": "ntfysh-vscode" };
    if (this.options.token) {
      headers["Authorization"] = `Bearer ${this.options.token}`;
    }
    return headers;
  }

  private connect(): void {
    if (this.disposed) {
      return;
    }
    this.setState(this._state === "closed" || this._state === "connecting" ? "connecting" : "reconnecting");
    this.buffer = "";

    let url: URL;
    try {
      url = this.buildUrl();
    } catch (err) {
      this.handlers.onError?.(`Invalid server URL: ${String(err)}`);
      return;
    }

    if (this.method === "websocket") {
      this.connectWebSocket(url);
    } else {
      this.connectHttp(url);
    }
  }

  private connectHttp(url: URL): void {
    const transport = url.protocol === "http:" ? http : https;
    const headers: http.OutgoingHttpHeaders = {
      Accept: "application/x-ndjson",
      ...this.authHeaders()
    };

    const req = transport.request(
      url,
      { method: "GET", headers, ...happyEyeballsOptions },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          this.handlers.onError?.(
            `Topics "${this.label}" returned HTTP ${res.statusCode}.`
          );
          res.resume();
          this.scheduleReconnect();
          return;
        }

        this.backoff = INITIAL_BACKOFF_MS;
        this.setState("connected");
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => this.consume(chunk));
        res.on("end", () => this.scheduleReconnect());
        res.on("close", () => this.scheduleReconnect());
        res.on("error", () => this.scheduleReconnect());
      }
    );

    req.on("error", (err) => {
      if (this.disposed) {
        return;
      }
      this.handlers.onError?.(describeError(err));
      this.scheduleReconnect();
    });

    req.end();
    this.request = req;
  }

  private connectWebSocket(url: URL): void {
    const socket = new WebSocket(url.toString(), {
      headers: this.authHeaders(),
      ...happyEyeballsOptions
    });
    this.socket = socket;

    socket.on("open", () => {
      this.backoff = INITIAL_BACKOFF_MS;
      this.setState("connected");
    });
    // Each frame carries one JSON message; reuse the line handler.
    socket.on("message", (data: WebSocket.RawData) => this.handleLine(data.toString()));
    socket.on("unexpected-response", (_req, res) => {
      this.handlers.onError?.(
        `Topics "${this.label}" returned HTTP ${res.statusCode}.`
      );
      this.scheduleReconnect();
    });
    socket.on("error", (err) => {
      if (this.disposed) {
        return;
      }
      this.handlers.onError?.(describeError(err));
      this.scheduleReconnect();
    });
    socket.on("close", () => this.scheduleReconnect());
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: NtfyMessage;
    try {
      msg = JSON.parse(line) as NtfyMessage;
    } catch {
      return;
    }
    if (
      msg.event === "message" ||
      msg.event === "message_clear" ||
      msg.event === "message_delete"
    ) {
      this.handlers.onMessage(msg);
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    this.request = undefined;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket = undefined;
    }
    this.setState("reconnecting");
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}
