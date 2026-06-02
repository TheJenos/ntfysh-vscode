# ntfy.sh Notifications for VS Code

Subscribe to [ntfy.sh](https://ntfy.sh) topics from inside VS Code and get every
published message as a native editor notification (popup).

## Features

- **Native side panels** — a dedicated **ntfy.sh** container in the Activity Bar
  (themes automatically with VS Code) with two independently collapsible panels.
  The **Subscriptions** panel shows every topic with a live status icon, message
  count, and a native **checkbox** to enable/disable a topic (pause its
  connection) without unsubscribing.
- **Notification history** — the **Notifications** panel lists past
  notifications (persisted across restarts) with topic, time, and a rich
  tooltip; clicking an item opens its link/attachment or shows the message.
  Clear it from the panel header.
- **Subscribe to any number of topics** — add topics from the panel or the
  Command Palette.
- **Live push notifications** — messages published to your topics pop up as
  VS Code notifications in real time.
- **Priority aware** — high‑priority messages (4–5) show as warning/error
  popups; normal messages show as info popups; low‑priority messages can
  optionally be routed to the status bar instead.
- **Clickable actions** — if a message includes a `click` link or an
  attachment, an **Open Link / Open Attachment** button is added to the popup.
- **Auto‑reconnect** — each topic streams over the ntfy JSON endpoint and
  reconnects automatically with exponential backoff if the connection drops.
- **Self‑hosted servers & auth** — point it at your own ntfy server and supply
  an access token for protected topics.
- **Publish test messages** — send a quick message to any topic to verify the
  setup.

## Getting started

1. Open this folder in VS Code and press <kbd>F5</kbd> to launch the
   **Extension Development Host** (or package it with `vsce package` and install
   the `.vsix`).
2. Click the **bell icon** in the Activity Bar to open the **ntfy.sh** view.
3. Click **＋ Subscribe to a topic** (or run **ntfy: Subscribe to Topic** from
   the Command Palette) and enter a topic name, e.g. `my-alerts`.
4. Publish a message to that topic from anywhere, for example:

   ```bash
   curl -d "Build finished " ntfy.sh/my-alerts
   ```

   …and it pops up inside VS Code.

You can also test end‑to‑end without leaving the editor via
**ntfy: Publish Test Message**.

## Commands

| Command | Description |
| --- | --- |
| `ntfy: Subscribe to Topic` | Subscribe to a new topic. |
| `ntfy: Unsubscribe from Topic` | Pick a topic to unsubscribe from. |
| `ntfy: Reconnect All Topics` | Force‑reconnect every subscription. |
| `ntfy: Publish Test Message` | Send a message to a topic. |
| `ntfy: Clear Notification History` | Empty the notification history. |

The view also offers a per‑topic **enable/disable checkbox** plus inline
**reconnect** and **unsubscribe** actions.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ntfysh.server` | `https://ntfy.sh` | Base URL of the ntfy server. |
| `ntfysh.topics` | `[]` | Subscribed topics (managed by the commands). |
| `ntfysh.disabledTopics` | `[]` | Subscribed topics that are toggled off. |
| `ntfysh.token` | `""` | Optional `Bearer` access token for protected topics. |
| `ntfysh.notifyOnConnect` | `false` | Notify each time a topic connects. |
| `ntfysh.showLowPriorityAsStatusBar` | `false` | Show priority 1–2 messages in the status bar instead of as popups. |

## How it works

For each enabled topic the extension opens a streaming `GET` request to
`<server>/<topic>/json`, which returns newline‑delimited JSON. Each `message`
event is parsed and turned into a `vscode.window.show*Message` notification and
recorded in history. Connection state per topic is shown live in the native
**Subscriptions** tree, and the total notification count is shown as a badge on
the Activity Bar icon.

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Press <kbd>F5</kbd> to run the extension in a new VS Code window.

## License

MIT
