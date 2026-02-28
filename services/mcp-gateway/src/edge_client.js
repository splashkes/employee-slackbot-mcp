import { Logger } from "./logger.js";

const logger = new Logger(process.env.LOG_LEVEL || "info");

function create_edge_client({ supabase_url, service_role_key }) {
  if (!supabase_url || !service_role_key) {
    logger.warn("edge_client_skipped", { reason: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    return null;
  }

  const base_url = supabase_url.replace(/\/$/, "");

  async function invoke(function_name, payload = {}) {
    const url = `${base_url}/functions/v1/${function_name}`;

    logger.info("edge_function_invoke", { function_name });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${service_role_key}`,
        "apikey": service_role_key
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000)
    });

    const response_text = await response.text();

    let response_data;
    try {
      response_data = JSON.parse(response_text);
    } catch {
      response_data = { raw: response_text };
    }

    if (!response.ok) {
      const error = new Error(`Edge function ${function_name} returned ${response.status}`);
      error.status = response.status;
      error.response_data = response_data;
      throw error;
    }

    return response_data;
  }

  return { invoke };
}

export { create_edge_client };
