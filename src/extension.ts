import * as http from "http";
import * as https from "https";
import { URL } from "url";
import * as vscode from "vscode";
import { NtfyPanelProvider } from "./panelProvider";
import { SubscriptionManager } from "./subscriptionManager";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("ntfy.sh");
  const manager = new SubscriptionManager(output, context.globalState);
  const panelProvider = new NtfyPanelProvider(context.extensionUri, manager);

  context.subscriptions.push(
    output,
    manager,
    vscode.window.registerWebviewViewProvider(NtfyPanelProvider.viewType, panelProvider)
  );

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
