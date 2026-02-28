# Slack App Setup

## 1. Create the Slack App

1. Go to https://api.slack.com/apps and click **Create New App**.
2. Choose **From scratch**.
3. Name the app (e.g. `Arthur Bot`) and select the target workspace.

## 2. Bot Token Scopes

Navigate to **OAuth & Permissions** and add these **Bot Token Scopes**:

| Scope | Purpose |
|---|---|
| `app_mentions:read` | Listen for @mentions |
| `chat:write` | Send messages and thread replies |
| `commands` | Register slash commands |
| `channels:history` | Read thread context for follow-up questions |
| `assistant:write` | Show native typing/status indicator while processing |
| `reactions:read` | Read reactions (future use) |
| `reactions:write` | Add emoji reactions |

## 3. Enable Socket Mode

Socket Mode lets the bot receive events over a WebSocket instead of requiring a public URL.

1. Go to **Settings > Socket Mode** and toggle it **on**.
2. When prompted, create an app-level token with the `connections:write` scope.
3. Copy the token — this is your `SLACK_APP_TOKEN` (starts with `xapp-`).

## 4. Enable Interactivity

Required for the Confirm/Cancel buttons on non-low-risk tool actions.

1. Go to **Interactivity & Shortcuts** and toggle **on**.
2. Set the request URL to any placeholder (Socket Mode handles it — e.g. `https://placeholder.example.com/slack/events`).

## 5. Install to Workspace

1. Go to **Install App** and click **Install to Workspace**.
2. Authorize the requested scopes.
3. Copy the **Bot User OAuth Token** — this is your `SLACK_BOT_TOKEN` (starts with `xoxb-`).

## 6. Create the Slash Command

1. Go to **Slash Commands** and click **Create New Command**.
2. Set the command to `/ab`.
3. Set the request URL to `https://placeholder.example.com/slack/events` (ignored when using Socket Mode).
4. Add a short description (e.g. `Query ArtBattle tools`).
5. Save.

## 7. Subscribe to Events

1. Go to **Event Subscriptions** and toggle **Enable Events** on.
2. Under **Subscribe to bot events**, add `app_mention`.
3. Save.

## 8. Copy the Signing Secret

1. Go to **Settings > Basic Information**.
2. Copy the **Signing Secret** — this is your `SLACK_SIGNING_SECRET`.

## 9. Required Environment Variables

| Variable | Source | Format |
|---|---|---|
| `SLACK_BOT_TOKEN` | Step 5 — Bot User OAuth Token | `xoxb-...` |
| `SLACK_APP_TOKEN` | Step 3 — App-Level Token | `xapp-...` |
| `SLACK_SIGNING_SECRET` | Step 8 — Basic Information | hex string |
| `SLACK_USE_SOCKET_MODE` | Set to `true` | boolean |

These are stored in the `orchestration-secrets` Kubernetes secret and injected via `envFrom`.

## 10. Verify

After deploying, test in Slack:

```
/ab get event details for AB4001
```

Or mention the bot:

```
@Arthur Bot what is the voting status for AB4001?
```

Thread follow-ups work too:
```
@Arthur Bot what about the bid history?   (in a thread)
```

## 11. Adding Scopes Later

If you need to add a scope after initial install:

1. Go to **OAuth & Permissions** → **Bot Token Scopes** → **Add an OAuth Scope**
2. Click **Reinstall App** (banner appears at top of page)
3. Authorize — the bot token stays the same, no k8s secret update needed
4. Restart the bot pod to reconnect: `kubectl rollout restart deployment/orchestration-api -n artbattle-orchestration`
