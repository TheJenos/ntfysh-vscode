import * as vscode from "vscode";
import { ConnectionMethod, ConnectionState, NtfyClient, NtfyMessage } from "./ntfyClient";

export type TopicState = ConnectionState | "disabled";

/**
 * Overall state of the extension's single connection. `"idle"` means there are
 * no enabled topics, so no connection is being maintained.
 */
export type OverallState = ConnectionState | "idle";

export interface TopicStatus {
  topic: string;
  state: TopicState;
  enabled: boolean;
}

export interface NotificationItem {
  id: string;
  /**
   * Identifier shared by all messages in an update sequence. Defaults to the
   * first message's id when the server does not assign a custom one. Used to
   * update, clear, or delete an existing notification.
   */
  sequenceId: string;
  topic: string;
  title: string;
  message: string;
  priority: number;
  time: number;
  tags: string[];
  click?: string;
  attachmentUrl?: string;
  /** Cleared notifications have been marked as read and dismissed. */
  cleared?: boolean;
}

const HISTORY_KEY = "ntfysh.history";
const MAX_HISTORY = 200;

/**
 * Maintains a single NtfyClient that multiplexes every *enabled* subscribed
 * topic over one connection, persists the topic list and a notification
 * history in settings/global state, and turns incoming messages into VS Code
 * notifications.
 */
export class SubscriptionManager implements vscode.Disposable {
  private client?: NtfyClient;
  /** The set of topics the current client is subscribed to (sorted). */
  private subscribedTopics: string[] = [];
  private server = "";
  private token = "";
  private method: ConnectionMethod = "http";
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private history: NotificationItem[];
  private statusBar: vscode.StatusBarItem;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly state: vscode.Memento
  ) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.statusBar.command = "ntfyshNotifications.focus";
    this.history = this.state
      .get<NotificationItem[]>(HISTORY_KEY, [])
      .map((item) => ({ ...item, sequenceId: item.sequenceId || item.id }));
  }

  /**
   * (Re)build the single multiplexed client from the current settings, honoring
   * disabled topics. The client is only torn down and recreated when the set of
   * enabled topics, the server, or the token actually changes.
   */
  syncFromConfig(): void {
    const config = vscode.workspace.getConfiguration("ntfysh");
    const topics = this.normalize(config.get<string[]>("topics", []));
    const disabled = new Set(this.normalize(config.get<string[]>("disabledTopics", [])));
    const enabled = topics.filter((t) => !disabled.has(t)).sort((a, b) => a.localeCompare(b));
    const server = config.get<string>("server", "https://ntfy.sh");
    const token = config.get<string>("token", "");
    const method = this.readMethod(config);

    const sameTopics =
      enabled.length === this.subscribedTopics.length &&
      enabled.every((t, i) => t === this.subscribedTopics[i]);
    const unchanged =
      sameTopics && server === this.server && token === this.token && method === this.method;

    if (!unchanged) {
      this.client?.dispose();
      this.client = undefined;
      this.subscribedTopics = enabled;
      this.server = server;
      this.token = token;
      this.method = method;
      if (enabled.length > 0) {
        this.createClient(enabled);
      }
    }

    this._onDidChange.fire();
  }

  getStatuses(): TopicStatus[] {
    const config = vscode.workspace.getConfiguration("ntfysh");
    const topics = this.normalize(config.get<string[]>("topics", []));
    const disabled = new Set(this.normalize(config.get<string[]>("disabledTopics", [])));
    return topics
      .map((topic) => {
        const isDisabled = disabled.has(topic);
        const state: TopicState = isDisabled
          ? "disabled"
          : this.client?.state ?? "connecting";
        return { topic, state, enabled: !isDisabled };
      })
      .sort((a, b) => a.topic.localeCompare(b.topic));
  }

  /**
   * The single connection state shared by every enabled topic. Returns `"idle"`
   * when no topics are enabled and therefore no connection exists.
   */
  getConnectionState(): OverallState {
    if (this.subscribedTopics.length === 0) {
      return "idle";
    }
    return this.client?.state ?? "connecting";
  }

  /** Number of topics currently multiplexed over the connection. */
  getConnectedTopicCount(): number {
    return this.subscribedTopics.length;
  }

  getHistory(): NotificationItem[] {
    return this.history;
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    await this.state.update(HISTORY_KEY, this.history);
    this._onDidChange.fire();
  }

  async subscribe(rawTopic: string): Promise<void> {
    const topic = rawTopic.trim();
    if (!topic) {
      return;
    }
    const config = vscode.workspace.getConfiguration("ntfysh");
    const topics = this.normalize(config.get<string[]>("topics", []));
    if (topics.includes(topic)) {
      vscode.window.showInformationMessage(`Already subscribed to "${topic}".`);
      return;
    }
    topics.push(topic);
    await config.update("topics", topics, vscode.ConfigurationTarget.Global);
    this.syncFromConfig();
  }

  async unsubscribe(topic: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("ntfysh");
    const topics = this.normalize(config.get<string[]>("topics", [])).filter((t) => t !== topic);
    const disabled = this.normalize(config.get<string[]>("disabledTopics", [])).filter(
      (t) => t !== topic
    );
    await config.update("topics", topics, vscode.ConfigurationTarget.Global);
    await config.update("disabledTopics", disabled, vscode.ConfigurationTarget.Global);
    this.syncFromConfig();
  }

  /** Enable or disable a topic without unsubscribing from it. */
  async setEnabled(topic: string, enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration("ntfysh");
    const disabledSet = new Set(this.normalize(config.get<string[]>("disabledTopics", [])));
    if (enabled) {
      disabledSet.delete(topic);
    } else {
      disabledSet.add(topic);
    }
    await config.update("disabledTopics", [...disabledSet], vscode.ConfigurationTarget.Global);
    this.syncFromConfig();
  }

  /**
   * Force an immediate reconnect. Because every topic shares one connection,
   * the `topic` argument is accepted for compatibility but reconnecting always
   * affects the single multiplexed connection.
   */
  reconnect(_topic?: string): void {
    this.client?.reconnect();
    this._onDidChange.fire();
  }

  dispose(): void {
    this.client?.dispose();
    this.client = undefined;
    this.statusBar.dispose();
    this._onDidChange.dispose();
  }

  private readMethod(config: vscode.WorkspaceConfiguration): ConnectionMethod {
    return config.get<string>("connectionMethod", "http") === "websocket"
      ? "websocket"
      : "http";
  }

  private normalize(topics: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const t of topics) {
      const trimmed = (t ?? "").trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
    return result;
  }

  private createClient(topics: string[]): void {
    const config = vscode.workspace.getConfiguration("ntfysh");
    const server = config.get<string>("server", "https://ntfy.sh");
    const token = config.get<string>("token", "") || undefined;
    const method = this.readMethod(config);
    const label = topics.join(", ");

    const client = new NtfyClient(
      { server, topics, token, method },
      {
        onMessage: (msg) => this.handleMessage(msg),
        onStateChange: (state) => {
          this.log(`[${label}] ${state}`);
          if (state === "connected" && config.get<boolean>("notifyOnConnect", false)) {
            const summary =
              topics.length === 1
                ? `topic "${topics[0]}"`
                : `${topics.length} topics`;
            vscode.window.showInformationMessage(`Connected to ntfy ${summary}.`);
          }
          this._onDidChange.fire();
        },
        onError: (error) => this.log(`[${label}] error: ${error}`)
      }
    );
    client.start();
    this.client = client;
  }

  private handleMessage(msg: NtfyMessage): void {
    if (msg.event === "message_clear") {
      this.clearItem(msg.topic, msg.sequence_id);
      return;
    }
    if (msg.event === "message_delete") {
      this.deleteItem(msg.topic, msg.sequence_id);
      return;
    }

    const config = vscode.workspace.getConfiguration("ntfysh");
    const priority = msg.priority ?? 3;
    const title = msg.title?.trim() || `ntfy: ${msg.topic}`;
    const body = msg.message?.trim() || "(empty message)";
    const tags = msg.tags ?? [];
    const id = msg.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // A message without an explicit sequence_id starts its own sequence keyed
    // by its message id; subsequent updates reference that id.
    const sequenceId = msg.sequence_id || id;
    const isUpdate = Boolean(msg.sequence_id) && this.hasSequence(msg.topic, sequenceId);

    this.log(
      `[${msg.topic}] ${isUpdate ? "update" : "message"} (p${priority}): ${title} / ${body}`
    );
    this.upsert({
      id,
      sequenceId,
      topic: msg.topic,
      title,
      message: body,
      priority,
      time: msg.time ? msg.time * 1000 : Date.now(),
      tags,
      click: msg.click,
      attachmentUrl: msg.attachment?.url
    });

    const tagSuffix = tags.length ? ` [${tags.join(", ")}]` : "";
    const fullText = `${title} — ${body}${tagSuffix}`;

    if (priority <= 2 && config.get<boolean>("showLowPriorityAsStatusBar", false)) {
      this.flashStatusBar(`$(bell) ${title}: ${body}`);
      return;
    }

    const actions: string[] = [];
    if (msg.click) {
      actions.push("Open Link");
    }
    if (msg.attachment?.url) {
      actions.push("Open Attachment");
    }

    const show =
      priority >= 5
        ? vscode.window.showErrorMessage
        : priority === 4
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;

    show(fullText, ...actions).then((choice) => {
      if (choice === "Open Link" && msg.click) {
        vscode.env.openExternal(vscode.Uri.parse(msg.click));
      } else if (choice === "Open Attachment" && msg.attachment?.url) {
        vscode.env.openExternal(vscode.Uri.parse(msg.attachment.url));
      }
    });
  }

  private hasSequence(topic: string, sequenceId: string): boolean {
    return this.history.some(
      (item) => item.topic === topic && item.sequenceId === sequenceId
    );
  }

  /**
   * Insert a new notification, or replace the content of an existing one when a
   * message reuses its sequence ID (an update). Updated notifications keep their
   * position in the list so they don't jump around as they change.
   */
  private upsert(item: NotificationItem): void {
    const index = this.history.findIndex(
      (existing) => existing.topic === item.topic && existing.sequenceId === item.sequenceId
    );
    if (index !== -1) {
      // Preserve the original cleared flag only if no new content arrived; a
      // fresh update revives a cleared notification.
      this.history[index] = { ...item, cleared: false };
    } else {
      this.history.unshift(item);
      if (this.history.length > MAX_HISTORY) {
        this.history.length = MAX_HISTORY;
      }
    }
    void this.state.update(HISTORY_KEY, this.history);
    this._onDidChange.fire();
  }

  /** Mark a notification (by sequence ID) as read/dismissed. */
  private clearItem(topic: string, sequenceId?: string): void {
    if (!sequenceId) {
      return;
    }
    let changed = false;
    for (const item of this.history) {
      if (item.topic === topic && item.sequenceId === sequenceId && !item.cleared) {
        item.cleared = true;
        changed = true;
      }
    }
    if (changed) {
      this.log(`[${topic}] cleared sequence ${sequenceId}`);
      void this.state.update(HISTORY_KEY, this.history);
      this._onDidChange.fire();
    }
  }

  /** Remove a notification (by sequence ID) from the history entirely. */
  private deleteItem(topic: string, sequenceId?: string): void {
    if (!sequenceId) {
      return;
    }
    const before = this.history.length;
    this.history = this.history.filter(
      (item) => !(item.topic === topic && item.sequenceId === sequenceId)
    );
    if (this.history.length !== before) {
      this.log(`[${topic}] deleted sequence ${sequenceId}`);
      void this.state.update(HISTORY_KEY, this.history);
      this._onDidChange.fire();
    }
  }

  private flashStatusBar(text: string): void {
    this.statusBar.text = text;
    this.statusBar.show();
    setTimeout(() => this.statusBar.hide(), 8000);
  }

  private log(message: string): void {
    const ts = new Date().toISOString();
    this.output.appendLine(`${ts} ${message}`);
  }
}
