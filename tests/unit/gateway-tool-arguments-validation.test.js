import test from "node:test";
import assert from "node:assert/strict";
import { validate_tool_arguments } from "../../services/mcp-gateway/src/tools.js";

const payment_tool_definition = {
  parameters_schema: {
    type: "object",
    properties: {
      eid: { type: "string" },
      artist_profile_id: { type: "string" },
      amount: { type: "number", minimum: 0.01 },
      currency: { type: "string" }
    },
    required: ["eid", "artist_profile_id", "amount", "currency"],
    additionalProperties: false
  }
};

test("validate_tool_arguments accepts valid payload", () => {
  const validation_result = validate_tool_arguments(payment_tool_definition, {
    eid: "AB4001",
    artist_profile_id: "c8717c5f-4b5f-4dbe-996d-a1889f4e8ae1",
    amount: 25.5,
    currency: "USD"
  });

  assert.equal(validation_result.valid, true);
  assert.deepEqual(validation_result.errors, []);
});

test("validate_tool_arguments rejects missing required fields", () => {
  const validation_result = validate_tool_arguments(payment_tool_definition, {
    eid: "AB4001",
    amount: 25.5
  });

  assert.equal(validation_result.valid, false);
  assert.equal(
    validation_result.errors.includes("arguments.artist_profile_id is required"),
    true
  );
  assert.equal(validation_result.errors.includes("arguments.currency is required"), true);
});

test("validate_tool_arguments rejects additional properties", () => {
  const validation_result = validate_tool_arguments(payment_tool_definition, {
    eid: "AB4001",
    artist_profile_id: "artist-1",
    amount: 20,
    currency: "USD",
    note: "extra"
  });

  assert.equal(validation_result.valid, false);
  assert.equal(validation_result.errors.includes("arguments.note is not allowed"), true);
});

test("validate_tool_arguments rejects invalid primitive types", () => {
  const validation_result = validate_tool_arguments(payment_tool_definition, {
    eid: "AB4001",
    artist_profile_id: "artist-1",
    amount: "20",
    currency: "USD"
  });

  assert.equal(validation_result.valid, false);
  assert.equal(validation_result.errors.includes("arguments.amount must be a number"), true);
});
