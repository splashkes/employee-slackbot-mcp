# Slack App Setup

## 1. Create the Slack App

1. Go to https://api.slack.com/apps and click **Create New App**.
2. Choose **From scratch**.
3. Name the app (e.g. `ArtBattle Bot`) and select the target workspace.

## 2. Bot Token Scopes

Navigate to **OAuth & Permissions** and add these **Bot Token Scopes**:

| Scope | Purpose |
|---|---|
| `app_mentions:read` | Listen for @mentions |
| `chat:write` | Send messages |
| `commands` | Register slash commands |

## 3. Enable Socket Mode

Socket Mode lets the bot receive events over a WebSocket instead of requiring a public URL.

1. Go to **Settings > Socket Mode** and toggle it **on**.
2. When prompted, create an app-level token with the `connections:write` scope.
3. Copy the token — this is your `SLACK_APP_TOKEN` (starts with `xapp-`).

## 4. Install to Workspace

1. Go to **Install App** and click **Install to Workspace**.
2. Authorize the requested scopes.
3. Copy the **Bot User OAuth Token** — this is your `SLACK_BOT_TOKEN` (starts with `xoxb-`).

## 5. Create the Slash Command

1. Go to **Slash Commands** and click **Create New Command**.
2. Set the command to `/ab`.
3. Set the request URL to `https://your-domain.com/slack/events` (ignored when using Socket Mode).
4. Add a short description (e.g. `Query ArtBattle tools`).
5. Save.

## 6. Subscribe to Events

1. Go to **Event Subscriptions** and toggle **Enable Events** on.
2. Under **Subscribe to bot events**, add `app_mention`.
3. Save.

## 7. Copy the Signing Secret

1. Go to **Settings > Basic Information**.
2. Copy the **Signing Secret** — this is your `SLACK_SIGNING_SECRET`.

## 8. Required Environment Variables

| Variable | Source |
|---|---|
| `SLACK_BOT_TOKEN` | Step 4 — Bot User OAuth Token |
| `SLACK_APP_TOKEN` | Step 3 — App-Level Token |
| `SLACK_SIGNING_SECRET` | Step 7 — Basic Information |
| `SLACK_USE_SOCKET_MODE` | Set to `true` |

## 9. Verify

After deploying, test in Slack:

```
/ab get event details for AB4001
```

Or mention the bot:

```
@ArtBattle Bot what is the voting status for AB4001?
```
