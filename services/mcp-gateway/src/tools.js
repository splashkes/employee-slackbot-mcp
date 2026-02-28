export {
  build_tool_index,
  get_tool_definition_by_name,
  is_tool_allowed_for_role,
  load_allowed_tools_manifest
} from "@abcodex/shared/tool_manifest.js";

function validate_value_against_schema(value, schema, path_label) {
  const errors = [];
  const schema_type = schema?.type;

  if (!schema_type) {
    return errors;
  }

  if (schema_type === "object") {
    const is_plain_object =
      value !== null && typeof value === "object" && !Array.isArray(value);

    if (!is_plain_object) {
      errors.push(`${path_label} must be an object`);
      return errors;
    }

    const properties = schema.properties || {};
    const required_fields = Array.isArray(schema.required) ? schema.required : [];

    for (const required_field of required_fields) {
      if (!(required_field in value)) {
        errors.push(`${path_label}.${required_field} is required`);
      }
    }

    const additional_properties = schema.additionalProperties;
    if (additional_properties === false) {
      for (const key_name of Object.keys(value)) {
        if (!(key_name in properties)) {
          errors.push(`${path_label}.${key_name} is not allowed`);
        }
      }
    }

    for (const [property_name, property_schema] of Object.entries(properties)) {
      if (!(property_name in value)) {
        continue;
      }

      errors.push(
        ...validate_value_against_schema(
          value[property_name],
          property_schema,
          `${path_label}.${property_name}`
        )
      );
    }

    return errors;
  }

  if (schema_type === "string") {
    if (typeof value !== "string") {
      errors.push(`${path_label} must be a string`);
      return errors;
    }

    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path_label} must be at least ${schema.minLength} characters`);
    }

    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path_label} must be at most ${schema.maxLength} characters`);
    }

    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      errors.push(`${path_label} must be one of: ${schema.enum.join(", ")}`);
    }

    return errors;
  }

  if (schema_type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${path_label} must be a number`);
      return errors;
    }

    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path_label} must be >= ${schema.minimum}`);
    }

    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path_label} must be <= ${schema.maximum}`);
    }

    return errors;
  }

  if (schema_type === "integer") {
    if (!Number.isInteger(value)) {
      errors.push(`${path_label} must be an integer`);
      return errors;
    }

    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path_label} must be >= ${schema.minimum}`);
    }

    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path_label} must be <= ${schema.maximum}`);
    }

    return errors;
  }

  if (schema_type === "boolean") {
    if (typeof value !== "boolean") {
      errors.push(`${path_label} must be a boolean`);
    }

    return errors;
  }

  return errors;
}

function validate_tool_arguments(tool_definition, arguments_payload) {
  const schema = tool_definition?.parameters_schema;

  if (!schema || typeof schema !== "object") {
    return {
      valid: true,
      errors: []
    };
  }

  const errors = validate_value_against_schema(arguments_payload, schema, "arguments");
  return {
    valid: errors.length === 0,
    errors
  };
}

async function execute_tool_by_name(tool_name, arguments_payload, service_config) {
  if (tool_name === "get_event_details") {
    return {
      eid: arguments_payload.eid,
      name: `Event ${arguments_payload.eid}`,
      event_start_datetime: "2026-03-14T19:00:00Z",
      venue: "TBD",
      currency: "USD",
      source: "stub"
    };
  }

  if (tool_name === "get_live_voting_status") {
    return {
      eid: arguments_payload.eid,
      round: arguments_payload.round || 1,
      raw_vote_count: 0,
      weighted_vote_total: 0,
      source: "stub"
    };
  }

  if (tool_name === "get_auction_status") {
    return {
      eid: arguments_payload.eid,
      total_artworks: 0,
      active_auctions: 0,
      closed_auctions: 0,
      source: "stub"
    };
  }

  if (tool_name === "get_payment_summary") {
    return {
      eid: arguments_payload.eid,
      payments_pending: 0,
      payments_processing: 0,
      payments_paid: 0,
      source: "stub"
    };
  }

  if (tool_name === "process_artist_payment") {
    if (!service_config.gateway.enable_mutating_tools) {
      throw new Error("Mutating tools are disabled by policy");
    }

    return {
      eid: arguments_payload.eid,
      artist_profile_id: arguments_payload.artist_profile_id,
      amount: arguments_payload.amount,
      currency: arguments_payload.currency,
      status: "queued",
      source: "stub"
    };
  }

  throw new Error(`Unknown tool: ${tool_name}`);
}

export {
  execute_tool_by_name,
  validate_tool_arguments
};
