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

  async function upload_file({ channel, image_buffer, filename, title, initial_comment }) {
    // Step 1: get upload URL
    const url_res = await fetch(
      `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${image_buffer.length}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${bot_token}` },
        signal: AbortSignal.timeout(10_000)
      }
    );
    const url_data = await url_res.json();
    if (!url_data.ok) {
      throw new Error(`Slack getUploadURL error: ${url_data.error}`);
    }

    // Step 2: upload the file bytes
    const upload_res = await fetch(url_data.upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: image_buffer,
      signal: AbortSignal.timeout(15_000)
    });
    if (!upload_res.ok) {
      throw new Error(`Slack file upload failed: ${upload_res.status}`);
    }

    // Step 3: complete upload and share to channel
    const complete_res = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bot_token}`
      },
      body: JSON.stringify({
        files: [{ id: url_data.file_id, title: title || filename }],
        channel_id: channel,
        initial_comment: initial_comment || ""
      }),
      signal: AbortSignal.timeout(10_000)
    });
    const complete_data = await complete_res.json();
    if (!complete_data.ok) {
      throw new Error(`Slack completeUpload error: ${complete_data.error}`);
    }

    return {
      file_id: url_data.file_id,
      channel
    };
  }

  return { post_message, upload_file };
}

export { create_slack_poster };
