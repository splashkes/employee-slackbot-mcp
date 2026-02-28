export {
  build_tool_index,
  get_tool_definition_by_name,
  is_tool_allowed_for_role,
  load_allowed_tools_manifest
} from "@abcodex/shared/tool_manifest.js";

import { data_read_tools } from "./tools/data_read.js";
import { profile_integrity_tools } from "./tools/profile_integrity.js";
import { payments_tools } from "./tools/payments.js";
import { growth_marketing_tools } from "./tools/growth_marketing.js";
import { platform_ops_tools } from "./tools/platform_ops.js";
import { eventbrite_charts_tools } from "./tools/eventbrite_charts.js";
import { memory_tools } from "./tools/memory.js";

// Unified tool registry — all domain modules merged into a single lookup map
const tool_registry = {
  ...data_read_tools,
  ...profile_integrity_tools,
  ...payments_tools,
  ...growth_marketing_tools,
  ...platform_ops_tools,
  ...eventbrite_charts_tools,
  ...memory_tools
};

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

async function execute_tool_by_name(tool_name, arguments_payload, service_config, { sql, edge } = {}, request_context = {}) {
  const handler = tool_registry[tool_name];

  if (!handler) {
    throw new Error(`Unknown tool: ${tool_name}`);
  }

  return handler(arguments_payload, sql, edge, service_config, request_context);
}

export {
  execute_tool_by_name,
  validate_tool_arguments
};
