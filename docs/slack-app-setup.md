# Slack App Setup

Last Updated: 2026-03-01
Owner: Platform Engineering

## 1. Create the Slack App

1. Go to https://api.slack.com/apps and click **Create New App**.
2. Choose **From scratch**.
3. Name the app (e.g. `Arthur Bot`) and select the target workspace.

## 2. Bot Token Scopes

Navigate to **OAuth & Permissions** and add these **Bot Token Scopes**:

### Core (required for basic operation)

| Scope | Purpose |
|---|---|
| `app_mentions:read` | Listen for @mentions in channels |
| `chat:write` | Send messages and thread replies |
| `commands` | Register `/ab` slash command |
| `channels:history` | Read thread context for follow-up questions |
| `reactions:write` | Add hourglass typing indicator |

### DM Support (Tier 1)

| Scope | Purpose |
|---|---|
| `im:history` | Read message history in DMs (thread context) |
| `im:read` | View DM channel metadata |
| `im:write` | Send DM messages |
| `mpim:history` | Read message history in group DMs |
| `mpim:read` | View group DM channel metadata |
| `mpim:write` | Send group DM messages |

### Assistant Framework (Tier 2)

| Scope | Purpose |
|---|---|
| `assistant:write` | Enable Agents & AI Apps UI (top-bar icon, split pane, suggested prompts, loading states) |

### Reaction Feedback (Tier 3)

| Scope | Purpose |
|---|---|
| `reactions:read` | Read emoji reactions for implicit quality feedback |

### Granted but unused

| Scope | Notes |
|---|---|
| `im:write.topic` | Setting DM descriptions — no current use case |
| `mpim:write.topic` | Setting group DM descriptions — no current use case |
| `search:read.im` | Live DM search — deferred (requires user tokens) |
| `search:read.mpim` | Live group DM search — deferred (requires user tokens) |

## 3. Enable Socket Mode

Socket Mode lets the bot receive events over a WebSocket instead of requiring a public URL.

1. Go to **Settings > Socket Mode** and toggle it **on**.
2. When prompted, create an app-level token with the `connections:write` scope.
3. Copy the token — this is your `SLACK_APP_TOKEN` (starts with `xapp-`).

## 4. Enable Interactivity

Required for the Confirm/Cancel buttons on non-low-risk tool actions.

1. Go to **Interactivity & Shortcuts** and toggle **on**.
2. Set the request URL to any placeholder (Socket Mode handles it — e.g. `https://placeholder.example.com/slack/events`).

## 5. Enable Agents & AI Apps

This activates the Slack Assistant framework — gives the bot a dedicated icon in the Slack top bar.

1. Go to **Features > Agents & AI Apps** and toggle **on**.
2. This automatically subscribes to `assistant_thread_started` and `assistant_thread_context_changed` events.

## 6. Configure App Home

1. Go to **App Home** → **Show Tabs**.
2. Enable **Messages Tab**.
3. Check **"Allow users to send Slash commands and messages from the messages tab"**.
4. Optionally enable **Home Tab** (currently shows default placeholder).

Without the Messages Tab enabled, users will see "Sending messages to this app has been turned off" when trying to DM the bot.

## 7. Subscribe to Events

1. Go to **Event Subscriptions** and toggle **Enable Events** on.
2. Under **Subscribe to bot events**, add:

| Event | Purpose |
|---|---|
| `app_mention` | Respond to @mentions in channels |
| `message.im` | Receive DM messages (Tier 1) |
| `message.mpim` | Receive group DM messages (Tier 1) |
| `assistant_thread_started` | Initialize assistant threads with suggested prompts (Tier 2, auto-added by Agents & AI Apps) |
| `assistant_thread_context_changed` | Track which channel user is viewing in assistant (Tier 2, auto-added) |
| `reaction_added` | Capture emoji reactions for feedback (Tier 3) |

3. Save changes.

## 8. Install to Workspace

1. Go to **Install App** and click **Install to Workspace**.
2. Authorize the requested scopes.
3. Copy the **Bot User OAuth Token** — this is your `SLACK_BOT_TOKEN` (starts with `xoxb-`).

**Note:** A **User OAuth Token** (`xoxp-`) may also appear. This is not used by the bot and can be ignored.

## 9. Create the Slash Command

1. Go to **Slash Commands** and click **Create New Command**.
2. Set the command to `/ab`.
3. Set the request URL to `https://placeholder.example.com/slack/events` (ignored when using Socket Mode).
4. Add a short description (e.g. `Query ArtBattle tools`).
5. Save.

## 10. Copy the Signing Secret

1. Go to **Settings > Basic Information**.
2. Copy the **Signing Secret** — this is your `SLACK_SIGNING_SECRET`.

## 11. Required Environment Variables

| Variable | Source | Format |
|---|---|---|
| `SLACK_BOT_TOKEN` | Step 8 — Bot User OAuth Token | `xoxb-...` |
| `SLACK_APP_TOKEN` | Step 3 — App-Level Token | `xapp-...` |
| `SLACK_SIGNING_SECRET` | Step 10 — Basic Information | hex string |
| `SLACK_USE_SOCKET_MODE` | Set to `true` | boolean |

These are stored in the `orchestration-secrets` Kubernetes secret and injected via `envFrom`.

## 12. Interaction Modes

After setup, users can interact with the bot in 5 ways:

### Channel @mention
Mention the bot in any channel where it's a member:
```
@Arthur Bot what is the voting status for AB4001?
```
Thread follow-ups carry context:
```
@Arthur Bot what about the bid history?   (in a thread)
```

### Slash command
```
/ab get event details for AB4001
```

### Direct message (Tier 1)
Open a DM with the bot and type naturally — no @mention needed:
```
What's the payment balance for John Smith?
```
Thread follow-ups work in DMs too.

### Group DM (Tier 1)
Add the bot to a group DM. It responds to all messages (no @mention needed).

### Assistant panel (Tier 2)
Click the bot's icon in the Slack top bar (next to search). Features:
- **Split-pane view** — bot panel on the right, channels on the left
- **Suggested prompts** — 4 clickable buttons on first open
- **Loading states** — tool-specific messages ("Looking up event...", "Generating chart...")
- **Thread titles** — auto-set from user query
- **Chat + History tabs** — revisit past conversations

### Reaction feedback (Tier 3)
React to any bot message with emoji for implicit feedback:
- :thumbsup: :white_check_mark: :100: :tada: :heart: :star: → positive
- :thumbsdown: :x: :confused: :disappointed: → negative
- :bug: → bug report

Feedback is logged to `esbmcp_reaction_feedback` for quality tracking.

## 13. Display Settings

To change the bot's display image, name, or description:

1. Go to **Settings > Basic Information** → **Display Information**.
2. Update the app icon, name, description, and background color.
3. Changes apply immediately — no reinstall needed.

## 14. Adding Scopes Later

If you need to add a scope after initial install:

1. Go to **OAuth & Permissions** → **Bot Token Scopes** → **Add an OAuth Scope**
2. Click **Reinstall App** (banner appears at top of page)
3. Authorize — the bot token usually stays the same, no k8s secret update needed
4. Verify token: compare last 5 chars in app settings vs `kubectl get secret orchestration-secrets -n artbattle-orchestration -o jsonpath='{.data.SLACK_BOT_TOKEN}' | base64 -d | tail -c5`
5. Restart the bot pod to reconnect: `kubectl rollout restart deployment/orchestration-api -n artbattle-orchestration`

## 15. Troubleshooting

### "Sending messages to this app has been turned off"
The **Messages Tab** is not enabled in App Home settings. Go to **App Home** → **Show Tabs** → enable **Messages Tab** and check "Allow users to send Slash commands and messages from the messages tab". Reinstall after.

### DMs not responding
The `message.im` event is not subscribed. Go to **Event Subscriptions** → **Subscribe to bot events** → add `message.im`. Save and reinstall.

### Assistant icon not appearing
**Agents & AI Apps** is not enabled. Go to **Features > Agents & AI Apps** → toggle on. Reinstall.

### Bot not responding after reinstall
The bot token may have rotated. Compare tokens:
```bash
kubectl get secret orchestration-secrets -n artbattle-orchestration \
  -o jsonpath='{.data.SLACK_BOT_TOKEN}' | base64 -d | tail -c5
```
If the ending doesn't match the token in app settings, update the secret and restart.
