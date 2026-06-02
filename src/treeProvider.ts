import * as vscode from "vscode";
import { NotificationItem, SubscriptionManager, TopicState, TopicStatus } from "./subscriptionManager";

export interface TopicNode {
  kind: "topic";
  status: TopicStatus;
  count: number;
}

interface EmptyNode {
  kind: "empty";
  label: string;
}

export interface NotificationNode {
  kind: "notification";
  item: NotificationItem;
}

type SubNode = TopicNode | EmptyNode;
type NotifNode = NotificationNode | EmptyNode;

/** Tree for the "Subscriptions" panel: one checkbox-bearing item per topic. */
export class SubscriptionsTreeProvider implements vscode.TreeDataProvider<SubNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly manager: SubscriptionManager) {
    manager.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(node: SubNode): vscode.TreeItem {
    if (node.kind === "empty") {
      return emptyItem(node.label);
    }
    const { status, count } = node;
    const item = new vscode.TreeItem(status.topic, vscode.TreeItemCollapsibleState.None);
    item.id = `topic:${status.topic}`;
    item.contextValue = "ntfyTopic";
    item.description = count > 0 ? `${describe(status.state)} · ${count}` : describe(status.state);
    item.iconPath = iconForState(status.state);
    item.checkboxState = status.enabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.tooltip = new vscode.MarkdownString(
      `**${status.topic}**\n\nStatus: ${describe(status.state)}\n\nMessages: ${count}\n\n_Toggle the checkbox to ${
        status.enabled ? "disable" : "enable"
      } this topic._`
    );
    return item;
  }

  getChildren(): SubNode[] {
    const counts = countByTopic(this.manager);
    const topics = this.manager.getStatuses();
    if (topics.length === 0) {
      return [{ kind: "empty", label: "No topics — click + to subscribe" }];
    }
    return topics.map((status) => ({
      kind: "topic",
      status,
      count: counts.get(status.topic) ?? 0
    }));
  }
}

/** Tree for the "Notifications" panel: the received-message history. */
export class NotificationsTreeProvider implements vscode.TreeDataProvider<NotifNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly manager: SubscriptionManager) {
    manager.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(node: NotifNode): vscode.TreeItem {
    if (node.kind === "empty") {
      return emptyItem(node.label);
    }
    const n = node.item;
    const item = new vscode.TreeItem(n.title, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "ntfyNotification";
    item.description = `${n.topic} · ${formatTime(n.time)}`;
    item.iconPath = iconForPriority(n.priority);

    const tags = n.tags?.length ? `\n\nTags: ${n.tags.map((t) => `\`${t}\``).join(" ")}` : "";
    const link = n.click || n.attachmentUrl;
    const linkLine = link ? `\n\n[Open ${n.click ? "link" : "attachment"}](${link})` : "";
    const tooltip = new vscode.MarkdownString(
      `**${escapeMd(n.title)}**\n\n${escapeMd(n.message)}\n\n${n.topic} — ${new Date(
        n.time
      ).toLocaleString()}${tags}${linkLine}`
    );
    tooltip.isTrusted = true;
    item.tooltip = tooltip;

    item.command = {
      command: "ntfysh.openNotification",
      title: "Open notification",
      arguments: [n]
    };
    return item;
  }

  getChildren(): NotifNode[] {
    const history = this.manager.getHistory();
    if (history.length === 0) {
      return [{ kind: "empty", label: "No notifications yet" }];
    }
    return history.map((item) => ({ kind: "notification", item }));
  }
}

function countByTopic(manager: SubscriptionManager): Map<string, number> {
  const map = new Map<string, number>();
  for (const n of manager.getHistory()) {
    map.set(n.topic, (map.get(n.topic) ?? 0) + 1);
  }
  return map;
}

function emptyItem(label: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.contextValue = "ntfyEmpty";
  return item;
}

function describe(state: TopicState): string {
  switch (state) {
    case "connected":
      return "connected";
    case "connecting":
      return "connecting…";
    case "reconnecting":
      return "reconnecting…";
    case "closed":
      return "disconnected";
    case "disabled":
      return "disabled";
  }
}

function iconForState(state: TopicState): vscode.ThemeIcon {
  switch (state) {
    case "connected":
      return new vscode.ThemeIcon("bell", new vscode.ThemeColor("charts.green"));
    case "connecting":
    case "reconnecting":
      return new vscode.ThemeIcon("sync~spin");
    case "disabled":
      return new vscode.ThemeIcon("bell-slash", new vscode.ThemeColor("disabledForeground"));
    case "closed":
      return new vscode.ThemeIcon("bell-slash", new vscode.ThemeColor("charts.red"));
  }
}

function iconForPriority(priority: number): vscode.ThemeIcon {
  if (priority >= 5) {
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
  }
  if (priority === 4) {
    return new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
  }
  return new vscode.ThemeIcon("comment");
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString()
    : d.toLocaleString();
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1");
}
