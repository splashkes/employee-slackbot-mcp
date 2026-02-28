import OpenAI from "openai";
import crypto from "node:crypto";

function create_openai_client(api_key) {
  return new OpenAI({ apiKey: api_key });
}

function build_openai_tools(tool_definitions) {
  return tool_definitions.map((tool_definition) => ({
    type: "function",
    function: {
      name: tool_definition.tool_name,
      description: tool_definition.description || tool_definition.tool_name,
      parameters: tool_definition.parameters_schema || {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  }));
}

function parse_tool_arguments(arguments_text) {
  if (!arguments_text) {
    return {};
  }

  try {
    return JSON.parse(arguments_text);
  } catch (_error) {
    return {};
  }
}

function extract_text_from_message(message_content) {
  if (!message_content) {
    return "";
  }

  if (typeof message_content === "string") {
    return message_content;
  }

  if (Array.isArray(message_content)) {
    return message_content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item?.type === "text") {
          return item.text || "";
        }

        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

function summarize_arguments_payload(arguments_payload) {
  const normalized_payload =
    arguments_payload && typeof arguments_payload === "object" ? arguments_payload : {};

  return {
    arguments_hash: crypto
      .createHash("sha256")
      .update(JSON.stringify(normalized_payload))
      .digest("hex"),
    argument_keys: Object.keys(normalized_payload).sort()
  };
}

async function run_openai_tool_routing({
  openai_client,
  model_name,
  user_prompt_text,
  tool_definitions,
  max_tool_calls,
  max_output_tokens,
  tool_executor,
  logger
}) {
  const system_prompt = [
    "You are an internal operations assistant.",
    "Only use the provided tools when they are needed.",
    "Be concise and clear.",
    "Do not fabricate tool results."
  ].join(" ");

  const messages = [
    {
      role: "system",
      content: system_prompt
    },
    {
      role: "user",
      content: user_prompt_text
    }
  ];

  const openai_tools = build_openai_tools(tool_definitions);

  const first_response = await openai_client.chat.completions.create({
    model: model_name,
    messages,
    tools: openai_tools,
    tool_choice: "auto",
    max_tokens: max_output_tokens
  });

  const first_message = first_response.choices?.[0]?.message;
  const first_text = extract_text_from_message(first_message?.content);
  const tool_calls = Array.isArray(first_message?.tool_calls) ? first_message.tool_calls : [];

  if (tool_calls.length === 0) {
    return {
      response_text: first_text || "No action was required.",
      executed_tool_calls: []
    };
  }

  const bounded_tool_calls = tool_calls.slice(0, Math.max(max_tool_calls, 1));

  const tool_call_results = await Promise.all(
    bounded_tool_calls.map(async (tool_call) => {
      const tool_name = tool_call?.function?.name;
      const arguments_payload = parse_tool_arguments(tool_call?.function?.arguments);
      const argument_summary = summarize_arguments_payload(arguments_payload);

      logger.info("executing_tool_call", {
        tool_name,
        ...argument_summary
      });

      const tool_result = await tool_executor({
        tool_name,
        arguments_payload
      });

      return {
        tool_call_id: tool_call.id,
        tool_name,
        argument_summary,
        tool_result
      };
    })
  );

  const tool_result_messages = tool_call_results.map((item) => ({
    role: "tool",
    tool_call_id: item.tool_call_id,
    content: JSON.stringify(item.tool_result)
  }));

  const executed_tool_calls = tool_call_results.map((item) => ({
    tool_name: item.tool_name,
    ...item.argument_summary
  }));

  const followup_response = await openai_client.chat.completions.create({
    model: model_name,
    messages: [
      ...messages,
      {
        role: "assistant",
        content: first_message?.content || "",
        tool_calls: bounded_tool_calls
      },
      ...tool_result_messages
    ],
    max_tokens: max_output_tokens
  });

  const followup_message = followup_response.choices?.[0]?.message;
  const followup_text = extract_text_from_message(followup_message?.content);

  return {
    response_text: followup_text || "Tool execution completed.",
    executed_tool_calls
  };
}

export { create_openai_client, run_openai_tool_routing };
