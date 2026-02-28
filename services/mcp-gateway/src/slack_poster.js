// Minimal Slack Web API client for posting chart messages to channels.
// Uses Node 20 built-in fetch — no external dependencies.

function create_slack_poster(bot_token) {
  if (!bot_token) return null;

  async function post_message({ channel, text, blocks }) {
    const body = { channel, text };
    if (blocks) body.blocks = blocks;

    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bot_token}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }
    return { ts: data.ts, channel: data.channel };
  }

  return { post_message };
}

export { create_slack_poster };
