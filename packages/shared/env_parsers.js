function parse_boolean(raw_value, default_value) {
  if (raw_value === undefined || raw_value === "") {
    return default_value;
  }

  return ["1", "true", "yes", "on"].includes(String(raw_value).toLowerCase());
}

function parse_number(raw_value, default_value) {
  if (raw_value === undefined || raw_value === "") {
    return default_value;
  }

  const parsed_value = Number(raw_value);
  return Number.isFinite(parsed_value) ? parsed_value : default_value;
}

function parse_list(raw_value) {
  if (!raw_value) {
    return [];
  }

  return raw_value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parse_json_object(raw_value, default_value) {
  if (!raw_value) {
    return default_value;
  }

  try {
    const parsed_value = JSON.parse(raw_value);
    return parsed_value && typeof parsed_value === "object" ? parsed_value : default_value;
  } catch (_error) {
    return default_value;
  }
}

export { parse_boolean, parse_number, parse_list, parse_json_object };
