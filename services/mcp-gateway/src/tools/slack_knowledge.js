// slack_knowledge domain — 2 tools for querying the Slack archive RAG index.
// Calls the rag-query sidecar service via HTTP.

async function search_slack_knowledge(args, sql, edge, config, request_context) {
  const url = `${config.rag.query_url}/query`;

  const body = {
    query: args.query,
    limit: args.limit || 10,
    ...(args.channel ? { channel: args.channel } : {}),
    ...(args.user ? { user: args.user } : {}),
    ...(args.start_date ? { start_date: args.start_date } : {}),
    ...(args.end_date ? { end_date: args.end_date } : {}),
    include_thread_context: args.include_thread_context !== false
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`rag-query returned ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();

  if (!data.ok) {
    return { error: "RAG query service not ready", results: [] };
  }

  return {
    query: data.query,
    count: data.count,
    results: (data.results || []).map((r) => ({
      score: Math.round(r.score * 1000) / 1000,
      channel: r.channel,
      date: r.date,
      ts: r.ts,
      thread_ts: r.thread_ts,
      user_name: r.user_name,
      text: r.text,
      permalink: r.permalink,
      context: r.context || [],
      thread_preview: (r.thread_preview || []).slice(0, 8)
    }))
  };
}

async function get_slack_knowledge_stats(args, sql, edge, config) {
  const url = `${config.rag.query_url}/stats`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`rag-query returned ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

const slack_knowledge_tools = {
  search_slack_knowledge,
  get_slack_knowledge_stats
};

export { slack_knowledge_tools };
