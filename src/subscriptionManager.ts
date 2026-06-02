import * as vscode from "vscode";
import { ConnectionState, NtfyClient, NtfyMessage } from "./ntfyClient";

export type TopicState = ConnectionState | "disabled";

export interface TopicStatus {
  topic: string;
  state: TopicState;
  enabled: boolean;
}

export interface NotificationItem {
  id: string;
  topic: string;
  title: string;
  message: string;
  priority: number;
  time: number;
  tags: string[];
  click?: string;
  attachmentUrl?: string;
}

const HISTORY_KEY = "ntfysh.history";
const MAX_HISTORY = 200;

/**
 * Owns one NtfyClient per *enabled* subscribed topic, persists the topic list
 * and a notification history in settings/global state, and turns incoming
 * messages into VS Code notifications.
 */
export class SubscriptionManager implements vscode.Disposable {
  private readonly clients = new Map<string, NtfyClient>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private history: NotificationItem[];
  private statusBar: vscode.StatusBarItem;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly state: vscode.Memento
  ) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.statusBar.command = "ntfyshPanel.focus";
    this.history = this.state.get<NotificationItem[]>(HISTORY_KEY, []);
  }

  /** (Re)build clients from the current settings, honoring disabled topics. */
  syncFromConfig(): void {
    const config = vscode.workspace.getConfiguration("ntfysh");
    const topics = this.normalize(config.get<string[]>("topics", []));
    const disabled = new Set(this.normalize(config.get<string[]>("disabledTopics", [])));
    const enabled = topics.filter((t) => !disabled.has(t));

    for (const [topic, client] of this.clients) {
      if (!enabled.includes(topic)) {
        client.dispose();
        this.clients.delete(topic);
      }
    }

    for (const topic of enabled) {
      if (!this.clients.has(topic)) {
        this.createClient(topic);
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
          : this.clients.get(topic)?.state ?? "connecting";
        return { topic, state, enabled: !isDisabled };
      })
      .sort((a, b) => a.topic.localeCompare(b.topic));
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

  reconnect(topic?: string): void {
    if (topic) {
      this.clients.get(topic)?.reconnect();
    } else {
      for (const client of this.clients.values()) {
        client.reconnect();
      }
    }
    this._onDidChange.fire();
  }

  dispose(): void {
    for (const client of this.clients.values()) {
      client.dispose();
    }
    this.clients.clear();
    this.statusBar.dispose();
    this._onDidChange.dispose();
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

  private createClient(topic: string): void {
    const config = vscode.workspace.getConfiguration("ntfysh");
    const server = config.get<string>("server", "https://ntfy.sh");
    const token = config.get<string>("token", "") || undefined;

    const client = new NtfyClient(
      { server, topic, token },
      {
        onMessage: (msg) => this.handleMessage(msg),
        onStateChange: (state) => {
          this.log(`[${topic}] ${state}`);
          if (state === "connected" && config.get<boolean>("notifyOnConnect", false)) {
            vscode.window.showInformationMessage(`Connected to ntfy topic "${topic}".`);
          }
          this._onDidChange.fire();
        },
        onError: (error) => this.log(`[${topic}] error: ${error}`)
      }
    );
    client.start();
    this.clients.set(topic, client);
  }

  private handleMessage(msg: NtfyMessage): void {
    const config = vscode.workspace.getConfiguration("ntfysh");
    const priority = msg.priority ?? 3;
    const title = msg.title?.trim() || `ntfy: ${msg.topic}`;
    const body = msg.message?.trim() || "(empty message)";
    const tags = msg.tags ?? [];

    this.log(`[${msg.topic}] message (p${priority}): ${title} / ${body}`);
    this.record({
      id: msg.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  private record(item: NotificationItem): void {
    this.history.unshift(item);
    if (this.history.length > MAX_HISTORY) {
      this.history.length = MAX_HISTORY;
    }
    void this.state.update(HISTORY_KEY, this.history);
    this._onDidChange.fire();
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
