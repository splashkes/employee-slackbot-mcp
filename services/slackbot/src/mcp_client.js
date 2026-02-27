async function call_mcp_tool({
  gateway_url,
  gateway_auth_token,
  timeout_ms,
  tool_name,
  arguments_payload,
  request_context
}) {
  const controller = new AbortController();
  const timeout_handle = setTimeout(() => controller.abort(), timeout_ms);

  const request_url = `${gateway_url.replace(/\/$/, "")}/v1/tools/${encodeURIComponent(tool_name)}`;

  try {
    const response = await fetch(request_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gateway_auth_token}`
      },
      body: JSON.stringify({
        arguments: arguments_payload,
        request_context
      }),
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
