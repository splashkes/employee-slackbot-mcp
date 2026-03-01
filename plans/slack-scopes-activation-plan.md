# Plan: Slack Scopes Activation

## Current State

The Arthur Bot Slack app has 18 bot token scopes granted. Only 5 are actively used by the codebase. This plan covers activating the remaining 13 scopes across 4 capability tiers.

### Scope Audit

| Scope | Status | Used By |
|-------|--------|---------|
| `app_mentions:read` | **Active** | `index.js` — core event handler |
| `chat:write` | **Active** | `index.js` — thread replies |
| `commands` | **Active** | `index.js` — `/ab` slash command |
| `channels:history` | **Active** | `index.js` — thread context fetch |
| `reactions:write` | **Active** | `index.js` — hourglass typing indicator |
| `im:history` | Granted, unused | — |
| `im:read` | Granted, unused | — |
| `im:write` | Granted, unused | — |
| `im:write.topic` | Granted, unused | — |
| `mpim:history` | Granted, unused | — |
| `mpim:read` | Granted, unused | — |
| `mpim:write` | Granted, unused | — |
| `mpim:write.topic` | Granted, unused | — |
| `reactions:read` | Granted, unused | — |
| `search:read.im` | Granted, unused | — |
| `search:read.mpim` | Granted, unused | — |
| `assistant:write` | Granted, unused | — |

---

## Tier 1: DM Support (im:history, im:read, im:write)

**Effort:** Small — event subscription + minor handler changes
**Impact:** High — users can talk to the bot privately without cluttering channels

### What It Enables

Users DM the bot directly instead of @mentioning in a channel. Private conversations for sensitive queries (payment lookups, personnel questions, etc.).

### Implementation

**1. Subscribe to `message.im` event** in Slack app settings (Event Subscriptions → Subscribe to bot events). With Socket Mode this just requires the subscription toggle.

**2. Add `message.im` handler** in `services/slackbot/src/index.js`:

```js
app.event("message", async ({ event, client, say }) => {
  // Only handle DMs (channel type "im"), ignore channel messages
  if (event.channel_type !== "im") return;
  // Ignore bot's own messages, message_changed, etc.
  if (event.subtype) return;
  // Ignore if already handled by app_mention
  if (event.text?.includes(`<@${bot_user_id}>`)) return;

  // Reuse existing handle_and_reply() — same flow as app_mention
  // but no need to strip the @mention from the text
  const identity_context = {
    team_id: event.team,
    channel_id: event.channel,
    user_id: event.user,
    username: null  // resolve in handler
  };

  await handle_and_reply({
    user_text: event.text,
    thread_ts: event.thread_ts || event.ts,
    identity_context,
    client,
    say,
    event
  });
});
```

**3. Thread context in DMs** — `channels:history` doesn't cover DMs, but `im:history` does. The existing `conversations.replies` call should already work since `im:history` grants access. Verify.

**4. Proactive DMs** (`im:write`) — enables the bot to initiate conversations. Useful for:
- Scheduled report delivery to specific users
- Chart autopost notifications sent as DM instead of channel post
- Alert escalation ("payment flagged — please review")

Hold proactive DMs for Tier 3 — just enabling receive-and-reply for now.

### Files Changed

| File | Change |
|------|--------|
| `services/slackbot/src/index.js` | Add `message` event handler for DMs |
| Slack App Settings | Subscribe to `message.im` bot event |

---

## Tier 2: Slack Assistant Framework (assistant:write)

**Effort:** Medium — new Assistant handler class + suggested prompts
**Impact:** Very high — bot gets a dedicated top-bar icon and split-pane UI in Slack

### What It Enables

- Persistent **top-bar icon** in Slack (next to search) — users click it to open the bot
- **Split-pane view** — bot panel on the right, channels on the left (users can work while chatting)
- **Suggested prompts** — up to 4 clickable buttons shown on first open ("Show upcoming events", "Check my balance", etc.)
- **Loading states** — rotating status messages ("Searching events...", "Generating chart...") instead of just an hourglass reaction
- **Context awareness** — bot knows which channel the user is currently viewing
- **Chat + History tabs** — users can revisit past conversations

### Implementation

**1. Enable "Agents & AI Apps"** in Slack app settings (Features → Agents & AI Apps → toggle on). This activates the `assistant:write` scope.

**2. Subscribe to events:**
- `assistant_thread_started`
- `assistant_thread_context_changed`
- `message.im` (already added in Tier 1)

**3. Create `services/slackbot/src/assistant.js`** — Assistant handler:

```js
import { Assistant } from "@slack/bolt";

export function create_assistant({ handle_and_reply, resolve_role }) {
  return new Assistant({
    threadStarted: async ({ event, say, setSuggestedPrompts, saveThreadContext }) => {
      await saveThreadContext();

      const context = event.assistant_thread.context;
      const channel_id = context?.channel_id;

      // Tailor greeting based on which channel user is viewing
      await say("Hey! I can look up events, check payments, search Slack history, generate charts, and more. What do you need?");

      await setSuggestedPrompts({
        prompts: [
          { title: "Upcoming events", message: "Show me upcoming events in the next 30 days" },
          { title: "Search Slack", message: "What was discussed about " },
          { title: "Ticket chart", message: "Generate a ticket sales chart for " },
          { title: "Check balance", message: "What's the artist payment balance for " }
        ]
      });
    },

    threadContextChanged: async ({ saveThreadContext }) => {
      await saveThreadContext();
    },

    userMessage: async ({ event, say, setTitle, setStatus, getThreadContext }) => {
      const thread_context = await getThreadContext();

      await setStatus("Thinking...");

      // Route through existing handle_and_reply
      // setStatus can be called again mid-flight for tool-specific messages:
      // "Searching events...", "Generating chart...", "Querying Slack archive..."
      await handle_and_reply({
        user_text: event.text,
        thread_ts: event.thread_ts || event.ts,
        identity_context: {
          team_id: thread_context?.team_id || event.team,
          channel_id: event.channel,
          user_id: event.user,
          username: null
        },
        say,
        event,
        set_status: setStatus,  // pass through for tool-level status updates
        set_title: setTitle
      });
    }
  });
}
```

**4. Register in `index.js`:**

```js
import { create_assistant } from "./assistant.js";

const assistant = create_assistant({ handle_and_reply, resolve_role });
app.assistant(assistant);
```

**5. Enhance `openai_router.js`** — pass `set_status` callback so tool execution can update the loading message:

```js
// Before calling each tool:
if (set_status) {
  const tool_labels = {
    lookup_event: "Looking up event...",
    generate_chart: "Generating chart...",
    search_slack_knowledge: "Searching Slack archive...",
    get_payment_balance: "Checking payment balance..."
  };
  await set_status(tool_labels[tool_name] || "Working...");
}
```

**6. Auto-set thread title** after first response:

```js
if (set_title && tools_called.length > 0) {
  // Summarize from the tools used
  await set_title(user_text.slice(0, 60));
}
```

### Files Changed

| File | Change |
|------|--------|
| `services/slackbot/src/assistant.js` | **New** — Assistant handler |
| `services/slackbot/src/index.js` | Register `app.assistant()` |
| `services/slackbot/src/openai_router.js` | Accept `set_status` callback, emit tool-level loading messages |
| `services/slackbot/src/handle_and_reply.js` | Pass `set_status`/`set_title` through to router |
| Slack App Settings | Enable Agents & AI Apps, subscribe to assistant events |

### UX Before vs After

**Before:** User goes to a channel, types `@Arthur Bot show me upcoming events`, waits for a threaded reply visible to everyone.

**After:** User clicks the bot icon in the top bar, sees 4 suggested prompts, clicks "Upcoming events", sees "Looking up events..." loading state, gets a private response in a split pane while continuing to read channels.

---

## Tier 3: Reactions-Based Feedback (reactions:read)

**Effort:** Small — new event handler + DB write
**Impact:** Medium — automatic quality signals without users filing explicit feedback

### What It Enables

Track quality of bot responses by reading emoji reactions. Users already react naturally — this captures that signal.

| Reaction | Meaning | Action |
|----------|---------|--------|
| :thumbsup: :white_check_mark: :100: | Positive | Log as positive feedback to `esbmcp_feedback` |
| :thumbsdown: :x: :confused: | Negative | Log as negative feedback, flag for review |
| :bug: | Bug report | Auto-create entry in `esbmcp_bug_reports` |

### Implementation

**1. Subscribe to `reaction_added` event.**

**2. Add handler** — when a reaction is added to a bot message, look up the session by thread_ts and log feedback:

```js
app.event("reaction_added", async ({ event, client }) => {
  // Only care about reactions on bot's own messages
  if (event.item.type !== "message") return;

  const positive = ["thumbsup", "+1", "white_check_mark", "100", "tada"];
  const negative = ["thumbsdown", "-1", "x", "confused", "disappointed"];
  const bug = ["bug"];

  const reaction = event.reaction;
  let sentiment = null;

  if (positive.includes(reaction)) sentiment = "positive";
  else if (negative.includes(reaction)) sentiment = "negative";
  else if (bug.includes(reaction)) sentiment = "bug";
  else return;  // ignore unrecognized reactions

  // Write to esbmcp_feedback
  await sql`
    INSERT INTO esbmcp_feedback (
      session_thread_ts, slack_user_id, slack_channel_id,
      reaction, sentiment, created_at
    ) VALUES (
      ${event.item.ts}, ${event.user}, ${event.item.channel},
      ${reaction}, ${sentiment}, NOW()
    )
  `;
});
```

### Files Changed

| File | Change |
|------|--------|
| `services/slackbot/src/index.js` | Add `reaction_added` event handler |
| `sql/001_create_esbmcp_tables.sql` | Add `reaction` + `sentiment` columns to `esbmcp_feedback` (or create if schema differs) |
| Slack App Settings | Subscribe to `reaction_added` bot event |

---

## Tier 4: Real-Time Search (search:read.im, search:read.mpim)

**Effort:** Medium — new MCP tool + Slack API integration
**Impact:** Medium — complements the RAG index with live Slack search

### What It Enables

Search **live** Slack content (DMs and group DMs) on behalf of users — complements the offline RAG index which only covers archived channel history.

**Key constraint:** These scopes require **user tokens** (`xoxp-`), not bot tokens. Each user must individually consent. This means:
- Needs OAuth user token flow (not just bot installation)
- Search results are scoped to what the consenting user can see
- Users can revoke consent at any time

### Implementation

**Option A: Defer** — The RAG index already covers channel history. Live search of DMs adds complexity (user token management, consent flows) for limited gain. Most operational questions are in channels, not DMs.

**Option B: Implement as premium tool** — Add `search_slack_live` tool that calls `assistant.search.context` API with the user's token. Requires:
1. OAuth consent flow for user tokens
2. Token storage (encrypted in DB)
3. New MCP tool that proxies search requests
4. Clear UX for consent ("I need permission to search your DMs — click here to authorize")

**Recommendation:** Defer to Option A. The offline RAG index + assistant framework covers 95% of use cases. Revisit if users explicitly request DM search.

---

## Group DMs (mpim:history, mpim:read, mpim:write)

These work identically to the `im:*` scopes but for multi-person DMs. Once Tier 1 (DM support) is implemented, extending to group DMs is trivial — add `message.mpim` event subscription and handle `channel_type === "mpim"` in the same handler.

---

## Unused Scopes to Drop

These scopes are granted but have no clear use case. Consider removing to minimize attack surface:

| Scope | Reason to Drop |
|-------|---------------|
| `im:write.topic` | Setting DM descriptions has no operational value |
| `mpim:write.topic` | Same — group DM descriptions unused |

---

## Implementation Order

```
Tier 1: DM Support                     ← ~2 hours, unblocks private queries
  └── im:history, im:read, im:write
  └── mpim:history, mpim:read, mpim:write (extend handler)

Tier 2: Assistant Framework             ← ~4 hours, transforms UX
  └── assistant:write
  └── Depends on Tier 1 (message.im event)

Tier 3: Reaction Feedback              ← ~1 hour, passive quality tracking
  └── reactions:read

Tier 4: Live Search                    ← Deferred, revisit on demand
  └── search:read.im, search:read.mpim
```

### Priority Recommendation

**Ship Tier 1 + 2 together.** The Assistant framework is the highest-impact change — it gives the bot a first-class presence in Slack instead of being a @mention afterthought. Tier 1 is a prerequisite (the Assistant framework uses `message.im` under the hood). Tier 3 is a quick follow-up. Tier 4 is deferred.

---

## Verification

| Tier | Test |
|------|------|
| 1 | DM the bot directly — should respond without @mention |
| 2 | Click bot icon in top bar → split pane opens → suggested prompts appear → click one → loading state → response |
| 2 | Navigate to different channel while panel open → context changes (verify via logs) |
| 3 | React :thumbsup: on a bot reply → check `esbmcp_feedback` table |
| 3 | React :bug: on a bot reply → check `esbmcp_bug_reports` table |

## Security Notes

- DM conversations follow the same RBAC rules as channel conversations — role is resolved per user, not per channel
- Assistant framework conversations are private to the user (not visible to channel members)
- Reaction feedback only captures the emoji and thread reference — no message content stored in feedback table
- Live search (if implemented) is scoped to user's own access — bot cannot see content the user cannot see
