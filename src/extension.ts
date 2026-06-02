import * as http from "http";
import * as https from "https";
import { URL } from "url";
import * as vscode from "vscode";
import { NotificationItem, SubscriptionManager } from "./subscriptionManager";
import {
  NotificationsTreeProvider,
  SubscriptionsTreeProvider,
  TopicNode
} from "./treeProvider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("ntfy.sh");
  const manager = new SubscriptionManager(output, context.globalState);

  const subsProvider = new SubscriptionsTreeProvider(manager);
  const subsView = vscode.window.createTreeView("ntfyshSubscriptions", {
    treeDataProvider: subsProvider,
    showCollapseAll: false
  });

  const notifProvider = new NotificationsTreeProvider(manager);
  const notifView = vscode.window.createTreeView("ntfyshNotifications", {
    treeDataProvider: notifProvider,
    showCollapseAll: false
  });

  context.subscriptions.push(output, manager, subsView, notifView);

  // Native checkbox toggles enable/disable per topic.
  context.subscriptions.push(
    subsView.onDidChangeCheckboxState((e) => {
      for (const [node, state] of e.items) {
        if (node.kind === "topic") {
          void manager.setEnabled(
            node.status.topic,
            state === vscode.TreeItemCheckboxState.Checked
          );
        }
      }
    })
  );

  // Keep the Notifications panel badge in sync with the total message count.
  const updateBadge = () => {
    const total = manager.getHistory().length;
    notifView.badge = total > 0
      ? { value: total, tooltip: `${total} ntfy notification${total === 1 ? "" : "s"}` }
      : undefined;
  };
  updateBadge();
  context.subscriptions.push(manager.onDidChange(updateBadge));

  // Start from persisted settings.
  manager.syncFromConfig();

  // Rebuild clients when relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("ntfysh.topics") ||
        e.affectsConfiguration("ntfysh.server") ||
        e.affectsConfiguration("ntfysh.token")
      ) {
        manager.syncFromConfig();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ntfysh.subscribe", async () => {
      const topic = await vscode.window.showInputBox({
        title: "Subscribe to ntfy topic",
        prompt: "Enter the topic name to subscribe to",
        placeHolder: "e.g. my-alerts",
        validateInput: (value) =>
          value.trim().length === 0 ? "Topic cannot be empty." : undefined
      });
      if (topic) {
        await manager.subscribe(topic);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ntfysh.unsubscribe", async () => {
      const topics = manager.getStatuses().map((s) => s.topic);
      if (topics.length === 0) {
        vscode.window.showInformationMessage("You are not subscribed to any topics.");
        return;
      }
      const picked = await vscode.window.showQuickPick(topics, {
        title: "Unsubscribe from ntfy topic",
        placeHolder: "Select a topic to unsubscribe from"
      });
      if (picked) {
        await manager.unsubscribe(picked);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ntfysh.reconnect", () => {
      manager.reconnect();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ntfysh.reconnectItem", (node?: TopicNode) => {
      if (node?.status.topic) {
        manager.reconnect(node.status.topic);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ntfysh.unsubscribeItem", async (node?: TopicNode) => {
      const topic = node?.status.topic;
      if (!topic) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Unsubscribe from "${topic}"?`,
        { modal: true },
        "Unsubscribe"
      );
      if (choice === "Unsubscribe") {
        await manager.unsubscribe(topic);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ntfysh.openNotification", async (item?: NotificationItem) => {
      if (!item) {
        return;
      }
      const link = item.click || item.attachmentUrl;
      if (link) {
        await vscode.env.openExternal(vscode.Uri.parse(link));
        return;
      }
      const actions = ["Copy Message"];
      const choice = await vscode.window.showInformationMessage(
        `${item.title} — ${item.message}`,
        ...actions
      );
      if (choice === "Copy Message") {
        await vscode.env.clipboard.writeText(item.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ntfysh.clearHistory", async () => {
      await manager.clearHistory();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ntfysh.publish", async () => {
      const topics = manager.getStatuses().map((s) => s.topic);
      const topic =
        topics.length > 0
          ? await vscode.window.showQuickPick(topics, {
              title: "Publish test message",
              placeHolder: "Select the topic to publish to"
            })
          : await vscode.window.showInputBox({
              title: "Publish test message",
              prompt: "Enter a topic to publish to"
            });
      if (!topic) {
        return;
      }
      const message = await vscode.window.showInputBox({
        title: "Publish test message",
        prompt: `Message to send to "${topic}"`,
        value: "Hello from VS Code"
      });
      if (message === undefined) {
        return;
      }
      try {
        await publishMessage(topic, message);
        vscode.window.setStatusBarMessage(`$(send) Published to ntfy topic "${topic}"`, 4000);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to publish: ${String(err)}`);
      }
    })
  );
}

export function deactivate(): void {
  // Disposables registered on the context handle cleanup.
}

function publishMessage(topic: string, message: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("ntfysh");
  const server = config.get<string>("server", "https://ntfy.sh").replace(/\/+$/, "");
  const token = config.get<string>("token", "") || undefined;
  const url = new URL(`${server}/${encodeURIComponent(topic)}`);
  const transport = url.protocol === "http:" ? http : https;
  const payload = Buffer.from(message, "utf8");

  return new Promise<void>((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": payload.length
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const req = transport.request(url, { method: "POST", headers }, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
      } else {
        resolve();
      }
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
