import { build_canonical_payload, compute_signature } from "@abcodex/shared/signing.js";

function create_mcp_client({ gateway_url, gateway_auth_token, request_signing_secret, timeout_ms }) {
  const base_url = gateway_url.replace(/\/$/, "");

  async function call_tool({ tool_name, arguments_payload, request_context }) {
    const controller = new AbortController();
    const timeout_handle = setTimeout(() => controller.abort(), timeout_ms);

    const encoded_tool_name = encodeURIComponent(tool_name);
    const request_url = `${base_url}/v1/tools/${encoded_tool_name}`;
    const request_pathname = `/v1/tools/${encoded_tool_name}`;
    const request_body_text = JSON.stringify({
      arguments: arguments_payload,
      request_context
    });

    const timestamp_sec = Math.floor(Date.now() / 1000);
    const canonical_payload = build_canonical_payload({
      timestamp_sec,
      method: "POST",
      pathname: request_pathname,
      body_text: request_body_text
    });
    const signature_hex = compute_signature(request_signing_secret, canonical_payload);

    try {
      const response = await fetch(request_url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${gateway_auth_token}`,
          "x-mcp-signature": signature_hex,
          "x-mcp-timestamp": String(timestamp_sec),
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

  return { call_tool };
}

export { create_mcp_client };
