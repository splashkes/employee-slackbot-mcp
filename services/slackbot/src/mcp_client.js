import crypto from "node:crypto";

function build_signed_headers({
  request_signing_secret,
  request_pathname,
  request_body_text
}) {
  const timestamp_sec = Math.floor(Date.now() / 1000);
  const canonical_payload = [
    String(timestamp_sec),
    "POST",
    request_pathname,
    request_body_text
  ].join("\n");

  const signature_hex = crypto
    .createHmac("sha256", request_signing_secret)
    .update(canonical_payload)
    .digest("hex");

  return {
    timestamp_sec,
    signature_hex
  };
}

async function call_mcp_tool({
  gateway_url,
  gateway_auth_token,
  request_signing_secret,
  timeout_ms,
  tool_name,
  arguments_payload,
  request_context
}) {
  const controller = new AbortController();
  const timeout_handle = setTimeout(() => controller.abort(), timeout_ms);

  const request_url = `${gateway_url.replace(/\/$/, "")}/v1/tools/${encodeURIComponent(tool_name)}`;
  const request_pathname = new URL(request_url).pathname;
  const request_body_text = JSON.stringify({
    arguments: arguments_payload,
    request_context
  });
  const signed_headers = build_signed_headers({
    request_signing_secret,
    request_pathname,
    request_body_text
  });

  try {
    const response = await fetch(request_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gateway_auth_token}`,
        "x-mcp-signature": signed_headers.signature_hex,
        "x-mcp-timestamp": String(signed_headers.timestamp_sec),
        "x-mcp-signature-version": "v1"
      },
      body: request_body_text,
      signal: controller.signal
    });

    const response_text = await response.text();
    let response_json = {};

    try {
      response_json = response_text ? JSON.parse(response_text) : {};
    } catch (_error) {
      response_json = {
        ok: false,
        error: "invalid_json_response",
        raw: response_text
      };
    }

    if (!response.ok || response_json.ok === false) {
      throw new Error(
        response_json.error || `MCP gateway request failed with status ${response.status}`
      );
    }

    return response_json;
  } finally {
    clearTimeout(timeout_handle);
  }
}

export { call_mcp_tool };
