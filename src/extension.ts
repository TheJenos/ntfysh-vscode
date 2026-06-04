import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as path from "path";
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
      await openNotificationMarkdown(item);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ntfysh.openTopic", (node?: TopicNode) => {
      const topic = node?.status.topic;
      if (!topic) {
        return;
      }
      const config = vscode.workspace.getConfiguration("ntfysh");
      const server = config.get<string>("server", "https://ntfy.sh").replace(/\/+$/, "");
      const url = `${server}/${encodeURIComponent(topic)}`;
      openTopicWebview(context, topic, url);
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

/**
 * Render a notification's (possibly markdown) body using VS Code's built-in
 * Markdown preview. Falls back to a plain info message if the preview command
 * is unavailable.
 */
async function openNotificationMarkdown(item: NotificationItem): Promise<void> {
  const markdown = buildNotificationMarkdown(item);
  try {
    const safeId = (item.id || `${item.time}`).replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(os.tmpdir(), `ntfy-${safeId}.md`);
    fs.writeFileSync(filePath, markdown, "utf8");
    await vscode.commands.executeCommand(
      "markdown.showPreview",
      vscode.Uri.file(filePath)
    );
  } catch {
    const actions = ["Copy Message"];
    const choice = await vscode.window.showInformationMessage(
      `${item.title} — ${item.message}`,
      ...actions
    );
    if (choice === "Copy Message") {
      await vscode.env.clipboard.writeText(item.message);
    }
  }
}

function buildNotificationMarkdown(item: NotificationItem): string {
  const parts: string[] = [`# ${item.title}`, "", item.message, "", "---", ""];

  const meta: string[] = [
    `**Topic:** ${item.topic}`,
    `**Time:** ${new Date(item.time).toLocaleString()}`,
    `**Priority:** ${item.priority}`
  ];
  if (item.tags?.length) {
    meta.push(`**Tags:** ${item.tags.map((t) => `\`${t}\``).join(" ")}`);
  }
  parts.push(meta.join("  \n"));

  const links: string[] = [];
  if (item.click) {
    links.push(`[Open link](${item.click})`);
  }
  if (item.attachmentUrl) {
    links.push(`[Open attachment](${item.attachmentUrl})`);
  }
  if (links.length) {
    parts.push("", links.join(" · "));
  }

  return parts.join("\n");
}

const topicPanels = new Map<string, vscode.WebviewPanel>();

function openTopicWebview(
  context: vscode.ExtensionContext,
  topic: string,
  url: string
): void {
  const existing = topicPanels.get(topic);
  if (existing) {
    existing.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "ntfyshTopic",
    topic,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  topicPanels.set(topic, panel);
  panel.webview.html = topicWebviewHtml(url);
  panel.webview.onDidReceiveMessage(
    (message) => {
      if (message?.command === "openExternal") {
        void vscode.env.openExternal(vscode.Uri.parse(url));
      }
    },
    null,
    context.subscriptions
  );
  panel.onDidDispose(
    () => {
      topicPanels.delete(topic);
    },
    null,
    context.subscriptions
  );
}

function topicWebviewHtml(url: string): string {
  const safeUrl = url.replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--vscode-editorWidget-background);
    border-bottom: 1px solid var(--vscode-editorWidget-border);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    box-sizing: border-box;
  }
  .toolbar .url {
    flex: 1;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .toolbar button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 4px 10px;
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
  }
  .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
  iframe { border: 0; height: calc(100vh - 34px); width: 100vw; display: block; }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="url">${safeUrl}</span>
    <button id="openExternal" title="Open this topic in your default browser">Open in Browser</button>
  </div>
  <iframe src="${safeUrl}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById("openExternal").addEventListener("click", () => {
      vscode.postMessage({ command: "openExternal" });
    });
  </script>
</body>
</html>`;
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
