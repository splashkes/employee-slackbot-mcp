import test from "node:test";
import assert from "node:assert/strict";
import { redact_text } from "../../services/slackbot/src/policy.js";

test("redact_text applies default email and phone masking", () => {
  const redacted = redact_text("Contact john.doe@example.com or +1 (416) 555-0199");

  assert.equal(redacted.includes("j***@example.com"), true);
  assert.equal(redacted.includes("***99"), true);
});

test("redact_text applies mask_card_data when requested", () => {
  const redacted = redact_text(
    "Payment card 4242 4242 4242 4242 for jane@example.com",
    ["mask_card_data"]
  );

  assert.equal(redacted.includes("**** **** **** 4242"), true);
  assert.equal(redacted.includes("jane@example.com"), true);
});

test("redact_text ignores unknown redaction rules", () => {
  const original = "No changes expected";
  const redacted = redact_text(original, ["unknown_rule"]);

  assert.equal(redacted, original);
});
