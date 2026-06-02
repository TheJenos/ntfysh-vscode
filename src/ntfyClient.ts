import * as http from "http";
import * as https from "https";
import { URL } from "url";

/** A single message as delivered by the ntfy JSON stream. */
export interface NtfyMessage {
  id: string;
  time: number;
  event: "open" | "keepalive" | "message" | "poll_request";
  topic: string;
  message?: string;
  title?: string;
  priority?: number;
  tags?: string[];
  click?: string;
  attachment?: { name: string; url: string };
}

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

export interface NtfyClientOptions {
  server: string;
  topic: string;
  token?: string;
}

export interface NtfyClientHandlers {
  onMessage: (msg: NtfyMessage) => void;
  onStateChange?: (state: ConnectionState) => void;
  onError?: (error: string) => void;
}

const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return err.message || code || err.name || "connection error";
  }
  return String(err);
}

/**
 * Connects to a single ntfy topic over the newline-delimited JSON stream
 * (`<server>/<topic>/json`) and automatically reconnects with exponential
 * backoff. Each topic gets its own client instance.
 */
export class NtfyClient {
  private request?: http.ClientRequest;
  private buffer = "";
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer?: NodeJS.Timeout;
  private disposed = false;
  private _state: ConnectionState = "connecting";

  constructor(
    private readonly options: NtfyClientOptions,
    private readonly handlers: NtfyClientHandlers
  ) {}

  get topic(): string {
    return this.options.topic;
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
    if (this.request) {
      this.request.destroy();
      this.request = undefined;
    }
    this.setState("closed");
  }

  /** Force an immediate reconnect, resetting backoff. */
  reconnect(): void {
    if (this.request) {
      this.request.destroy();
      this.request = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.backoff = INITIAL_BACKOFF_MS;
    this.connect();
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
    const topic = encodeURIComponent(this.options.topic);
    return new URL(`${base}/${topic}/json`);
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

    const transport = url.protocol === "http:" ? http : https;
    const headers: http.OutgoingHttpHeaders = {
      Accept: "application/x-ndjson",
      "User-Agent": "ntfysh-vscode"
    };
    if (this.options.token) {
      headers["Authorization"] = `Bearer ${this.options.token}`;
    }

    const req = transport.request(
      url,
      { method: "GET", headers },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          this.handlers.onError?.(
            `Topic "${this.options.topic}" returned HTTP ${res.statusCode}.`
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
    if (msg.event === "message") {
      this.handlers.onMessage(msg);
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    this.request = undefined;
    this.setState("reconnecting");
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}
