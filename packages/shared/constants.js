const RISK_LEVELS = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high"
};

const AUDIT_EVENTS = {
  REQUEST_DENIED_IDENTITY: "request_denied_identity",
  REQUEST_DENIED_RATE_LIMIT: "request_denied_rate_limit",
  REQUEST_DENIED_ROLE: "request_denied_role",
  REQUEST_DENIED_NO_TOOLS: "request_denied_no_tools",
  REQUEST_COMPLETED: "request_completed"
};

const MCP_ERROR_CODES = {
  CONFIRMATION_REQUIRED: "confirmation_required",
  TOOL_NOT_ALLOWED_FOR_ROLE: "tool_not_allowed_for_role",
  INVALID_ARGUMENTS: "invalid_arguments",
  TOOL_NOT_FOUND: "tool_not_found",
  MISSING_ROLE: "missing_role",
  INVALID_REQUEST_SIGNATURE: "invalid_request_signature",
  REQUEST_BODY_TOO_LARGE: "request_body_too_large",
  INVALID_JSON_BODY: "invalid_json_body",
  INTERNAL_ERROR: "internal_error",
  ROUTE_NOT_FOUND: "route_not_found",
  UNAUTHORIZED: "unauthorized"
};

export { RISK_LEVELS, AUDIT_EVENTS, MCP_ERROR_CODES };
