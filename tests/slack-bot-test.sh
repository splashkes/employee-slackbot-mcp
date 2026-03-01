#!/usr/bin/env bash
# Lightweight employee bot tester
#
# Two modes:
#   SEND MODE  — send a prompt as a user, then poll for bot reply
#     ./tests/slack-bot-test.sh send "look up event AB4023"
#
#   POLL MODE  — just poll for a bot reply after a given timestamp
#     ./tests/slack-bot-test.sh poll <after_ts> [pattern]
#
#   SUITE MODE — run all tests end-to-end (needs SLACK_USER_TOKEN)
#     ./tests/slack-bot-test.sh suite
#
# Tokens:
#   SLACK_USER_TOKEN  — xoxp-* or xoxb-* for a DIFFERENT identity than the bot
#                       (used to send prompts so the bot actually responds)
#   SLACK_BOT_TOKEN   — the bot's own token (used to poll channel history)
#                       auto-pulled from k8s if not set
#
# Requires: kubectl (for token), curl, jq

set -euo pipefail

CHANNEL="${SLACK_TEST_CHANNEL:-C0AHDAZTL4X}"
BOT_UID="${SLACK_BOT_UID:-U0AJKE5MRL0}"
DELAYS=(2 5 8 10 15)

# Pull bot token from k8s if not set (for reading channel history)
if [[ -z "${SLACK_BOT_TOKEN:-}" ]]; then
  SLACK_BOT_TOKEN=$(kubectl get secret orchestration-secrets -n artbattle-orchestration \
    -o jsonpath='{.data.SLACK_BOT_TOKEN}' | base64 -d)
fi

# ── helpers ──────────────────────────────────────────────────────────────────

slack_post_as_user() {
  local text="$1"
  local token="${SLACK_USER_TOKEN:?SLACK_USER_TOKEN required to send as a user}"
  curl -s -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg ch "$CHANNEL" --arg txt "<@${BOT_UID}> $text" \
         '{channel: $ch, text: $txt}')" | jq -r '.ts // .error'
}

slack_get_bot_reply_after() {
  local after_ts="$1"
  curl -s "https://slack.com/api/conversations.history?channel=${CHANNEL}&oldest=${after_ts}&limit=5" \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" | \
    jq -r --arg bot "$BOT_UID" \
      '[.messages[] | select(.user == $bot)] | sort_by(.ts) | first | .text // empty'
}

poll_for_reply() {
  local after_ts="$1"
  local cumulative=0
  for delay in "${DELAYS[@]}"; do
    sleep "$delay"
    cumulative=$((cumulative + delay))
    local reply
    reply=$(slack_get_bot_reply_after "$after_ts")
    if [[ -n "$reply" ]]; then
      echo "$reply"
      echo "  (responded in ~${cumulative}s)" >&2
      return 0
    fi
    echo "  ... no reply yet (${cumulative}s total)" >&2
  done
  echo "  TIMEOUT — no bot reply after ${cumulative}s" >&2
  return 1
}

check_reply() {
  local reply="$1"
  local pattern="${2:-}"

  # Truncate for display
  local preview="${reply:0:400}"
  [[ ${#reply} -gt 400 ]] && preview="${preview}..."
  echo "REPLY (${#reply} chars):"
  echo "$preview"
  echo ""

  if [[ -n "$pattern" ]]; then
    if echo "$reply" | grep -qiE "$pattern"; then
      echo "PASS — matched: $pattern"
    else
      echo "FAIL — expected pattern: $pattern"
    fi
  else
    echo "PASS — got reply"
  fi
}

run_test() {
  local label="$1"
  local prompt="$2"
  local check_pattern="${3:-}"

  echo ""
  echo "================================================================"
  echo "TEST: $label"
  echo "PROMPT: $prompt"
  echo "================================================================"

  local msg_ts
  msg_ts=$(slack_post_as_user "$prompt")
  if [[ "$msg_ts" == "not_authed" || "$msg_ts" == "invalid_auth" || "$msg_ts" == "null" ]]; then
    echo "FAIL — could not post: $msg_ts"
    return 1
  fi
  echo "  Sent (ts=$msg_ts), polling..." >&2

  local reply
  if reply=$(poll_for_reply "$msg_ts"); then
    check_reply "$reply" "$check_pattern"
  else
    echo "FAIL — no reply"
  fi
}

# ── modes ────────────────────────────────────────────────────────────────────

cmd="${1:-help}"

case "$cmd" in

  poll)
    # Poll-only: ./tests/slack-bot-test.sh poll <after_ts> [pattern]
    after_ts="${2:?Usage: $0 poll <after_ts> [pattern]}"
    pattern="${3:-}"
    reply=$(poll_for_reply "$after_ts") && check_reply "$reply" "$pattern" || echo "FAIL — no reply"
    ;;

  send)
    # Send + poll: ./tests/slack-bot-test.sh send "prompt text" [pattern]
    shift
    prompt="${1:?Usage: $0 send <prompt> [pattern]}"
    pattern="${2:-}"
    run_test "Ad-hoc" "$prompt" "$pattern"
    ;;

  suite)
    echo "Employee Bot Test Suite — channel $CHANNEL, bot $BOT_UID"
    echo ""

    run_test "Passthrough: single event lookup" \
      "look up event AB4023" \
      "AB4023|Ottawa|Canadian War Museum"

    run_test "Analysis override: forces GPT review" \
      "analyze the setup for event AB4023" \
      "AB4023"

    run_test "Passthrough: city search (array)" \
      "list upcoming events in Toronto" \
      "Toronto|event"

    run_test "Passthrough: exchange rates" \
      "what are the current exchange rates for USD to CAD" \
      "USD|CAD|rate|exchange"

    run_test "Multi-tool: event + revenue" \
      "how much revenue did AB4023 generate" \
      "AB4023|revenue|\\\$"

    run_test "Non-passthrough: event health check" \
      "run a health check on AB4023" \
      "AB4023|check|pass|fail|warn"

    run_test "Bot sessions: recent activity" \
      "show me the last 5 bot sessions" \
      "session|completed"

    echo ""
    echo "================================================================"
    echo "TEST SUITE COMPLETE"
    echo "================================================================"
    ;;

  *)
    echo "Usage:"
    echo "  $0 poll <after_ts> [pattern]    — poll for bot reply after timestamp"
    echo "  $0 send <prompt> [pattern]      — send prompt as user, poll for reply"
    echo "  $0 suite                        — run full test suite"
    echo ""
    echo "Environment:"
    echo "  SLACK_USER_TOKEN   — required for send/suite (must be a DIFFERENT identity than the bot)"
    echo "  SLACK_BOT_TOKEN    — for polling (auto-pulled from k8s if not set)"
    echo "  SLACK_TEST_CHANNEL — channel to test in (default: $CHANNEL)"
    echo "  SLACK_BOT_UID      — bot user ID (default: $BOT_UID)"
    ;;
esac
