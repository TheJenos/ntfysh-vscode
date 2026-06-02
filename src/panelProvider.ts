import * as vscode from "vscode";
import { SubscriptionManager } from "./subscriptionManager";

interface InboundMessage {
  type:
    | "ready"
    | "subscribe"
    | "unsubscribe"
    | "toggle"
    | "reconnect"
    | "clearHistory"
    | "openLink";
  topic?: string;
  enabled?: boolean;
  url?: string;
}

/**
 * Renders the ntfy.sh side panel: the list of subscribed topics with
 * enable/disable toggles and connection status, plus a scrollable history of
 * received notifications.
 */
export class NtfyPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ntfyshPanel";

  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: SubscriptionManager
  ) {
    this.manager.onDidChange(() => this.postState());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: InboundMessage) => this.handleMessage(msg));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postState();
      }
    });
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postState();
        break;
      case "subscribe":
        await vscode.commands.executeCommand("ntfysh.subscribe");
        break;
      case "unsubscribe":
        if (msg.topic) {
          const choice = await vscode.window.showWarningMessage(
            `Unsubscribe from "${msg.topic}"?`,
            { modal: true },
            "Unsubscribe"
          );
          if (choice === "Unsubscribe") {
            await this.manager.unsubscribe(msg.topic);
          }
        }
        break;
      case "toggle":
        if (msg.topic !== undefined && msg.enabled !== undefined) {
          await this.manager.setEnabled(msg.topic, msg.enabled);
        }
        break;
      case "reconnect":
        this.manager.reconnect(msg.topic);
        break;
      case "clearHistory":
        await this.manager.clearHistory();
        break;
      case "openLink":
        if (msg.url) {
          vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        break;
    }
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    const history = this.manager.getHistory();
    const total = history.length;
    this.view.badge =
      total > 0
        ? { value: total, tooltip: `${total} ntfy notification${total === 1 ? "" : "s"}` }
        : undefined;
    this.view.webview.postMessage({
      type: "state",
      topics: this.manager.getStatuses(),
      history
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  html, body { background: transparent; }
  body {
    margin: 0;
    padding: 0 8px 12px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  h3 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.75;
    margin: 14px 2px 6px;
  }
  .section-actions button { margin-left: 4px; }
  button {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 11px;
  }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button:hover { filter: brightness(1.1); }
  .link-btn {
    background: none; border: none; padding: 0; margin: 0;
    color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px;
  }
  .empty { opacity: 0.6; padding: 8px 2px; font-style: italic; }
  .topic {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 6px;
    border-radius: 5px;
  }
  .topic:hover { background: var(--vscode-list-hoverBackground); }
  .topic .meta { flex: 1; min-width: 0; }
  .topic .name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .topic .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .topic .status { font-size: 10px; opacity: 0.7; }
  .count {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px; padding: 0 6px; min-width: 8px;
    font-size: 10px; line-height: 16px; text-align: center; flex: 0 0 auto;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
  .dot.connected { background: #3fb950; }
  .dot.connecting, .dot.reconnecting { background: #d29922; }
  .dot.disabled, .dot.closed { background: #f85149; }
  .icon-btn {
    background: none; border: none; cursor: pointer; opacity: 0.65;
    color: var(--vscode-foreground); padding: 2px; font-size: 13px; line-height: 1;
  }
  .icon-btn:hover { opacity: 1; }

  /* toggle switch */
  .switch { position: relative; display: inline-block; width: 30px; height: 16px; flex: 0 0 auto; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; inset: 0; cursor: pointer; border-radius: 16px;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #888));
    transition: 0.15s;
  }
  .slider:before {
    content: ""; position: absolute; height: 10px; width: 10px; left: 2px; top: 2px;
    background: var(--vscode-foreground); border-radius: 50%; transition: 0.15s;
  }
  input:checked + .slider { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  input:checked + .slider:before { transform: translateX(14px); background: var(--vscode-button-foreground); }

  .notif {
    padding: 6px 8px; border-radius: 5px; margin-bottom: 4px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    border-left: 3px solid var(--vscode-panel-border, #888);
    background: transparent;
  }
  .notif.p4 { border-left-color: #d29922; }
  .notif.p5 { border-left-color: #f85149; }
  .notif .title { font-weight: 600; }
  .notif .body { white-space: pre-wrap; word-break: break-word; margin: 2px 0; }
  .notif .sub { font-size: 10px; opacity: 0.65; display: flex; gap: 8px; flex-wrap: wrap; }
  .notif .tags { font-size: 10px; opacity: 0.8; }
  .notif .open { margin-top: 4px; }
</style>
</head>
<body>
  <h3>
    <span>Subscriptions</span>
    <span class="section-actions">
      <button class="primary" id="addBtn" title="Subscribe to a topic">+ Add</button>
    </span>
  </h3>
  <div id="topics"></div>

  <h3>
    <span>Notifications</span>
    <span class="section-actions">
      <button id="clearBtn" title="Clear notification history">Clear</button>
    </span>
  </h3>
  <div id="history"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const topicsEl = document.getElementById("topics");
  const historyEl = document.getElementById("history");

  document.getElementById("addBtn").addEventListener("click", () => post({ type: "subscribe" }));
  document.getElementById("clearBtn").addEventListener("click", () => post({ type: "clearHistory" }));

  function post(msg) { vscode.postMessage(msg); }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtTime(ms) {
    const d = new Date(ms);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
  }

  function renderTopics(topics, counts) {
    topicsEl.innerHTML = "";
    if (!topics.length) {
      topicsEl.innerHTML = '<div class="empty">No topics yet. Click + Add to subscribe.</div>';
      return;
    }
    for (const t of topics) {
      const row = document.createElement("div");
      row.className = "topic";

      const dot = document.createElement("span");
      dot.className = "dot " + t.state;

      const count = counts[t.topic] || 0;
      const badge = count > 0
        ? '<span class="count" title="' + count + ' message' + (count === 1 ? "" : "s") + '">' + count + '</span>'
        : '';

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = '<div class="name-row"><span class="name">' + esc(t.topic) + '</span>' + badge + '</div>' +
        '<div class="status">' + esc(t.state) + '</div>';

      const sw = document.createElement("label");
      sw.className = "switch";
      sw.title = t.enabled ? "Disable" : "Enable";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = t.enabled;
      cb.addEventListener("change", () => post({ type: "toggle", topic: t.topic, enabled: cb.checked }));
      const sl = document.createElement("span");
      sl.className = "slider";
      sw.appendChild(cb);
      sw.appendChild(sl);

      const reconnect = document.createElement("button");
      reconnect.className = "icon-btn";
      reconnect.textContent = "\u21BB";
      reconnect.title = "Reconnect";
      reconnect.addEventListener("click", () => post({ type: "reconnect", topic: t.topic }));

      const remove = document.createElement("button");
      remove.className = "icon-btn";
      remove.textContent = "\u2715";
      remove.title = "Unsubscribe";
      remove.addEventListener("click", () => post({ type: "unsubscribe", topic: t.topic }));

      row.appendChild(dot);
      row.appendChild(meta);
      row.appendChild(sw);
      row.appendChild(reconnect);
      row.appendChild(remove);
      topicsEl.appendChild(row);
    }
  }

  function renderHistory(history) {
    historyEl.innerHTML = "";
    if (!history.length) {
      historyEl.innerHTML = '<div class="empty">No notifications received yet.</div>';
      return;
    }
    for (const n of history) {
      const item = document.createElement("div");
      item.className = "notif p" + (n.priority || 3);

      let html = '<div class="title">' + esc(n.title) + '</div>';
      html += '<div class="body">' + esc(n.message) + '</div>';
      if (n.tags && n.tags.length) {
        html += '<div class="tags">#' + n.tags.map(esc).join(" #") + '</div>';
      }
      html += '<div class="sub"><span>' + esc(n.topic) + '</span><span>' + esc(fmtTime(n.time)) + '</span></div>';
      item.innerHTML = html;

      const link = n.click || n.attachmentUrl;
      if (link) {
        const open = document.createElement("button");
        open.className = "link-btn open";
        open.textContent = n.click ? "Open link" : "Open attachment";
        open.addEventListener("click", () => post({ type: "openLink", url: link }));
        item.appendChild(open);
      }
      historyEl.appendChild(item);
    }
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "state") {
      const history = msg.history || [];
      const counts = {};
      for (const n of history) {
        counts[n.topic] = (counts[n.topic] || 0) + 1;
      }
      renderTopics(msg.topics || [], counts);
      renderHistory(history);
    }
  });

  post({ type: "ready" });
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
