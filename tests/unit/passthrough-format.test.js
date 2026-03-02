import test from "node:test";
import assert from "node:assert/strict";
import { format_passthrough_result, format_value, humanize_key } from "../../services/slackbot/src/passthrough_format.js";

// ---------------------------------------------------------------------------
// humanize_key
// ---------------------------------------------------------------------------
test("humanize_key converts snake_case to Title Case", () => {
  assert.equal(humanize_key("artist_name"), "Artist Name");
  assert.equal(humanize_key("eid"), "EID");
  assert.equal(humanize_key("event_id"), "Event ID");
  assert.equal(humanize_key("image_url"), "Image URL");
});

// ---------------------------------------------------------------------------
// format_value
// ---------------------------------------------------------------------------
test("format_value handles null/undefined as N/A", () => {
  assert.equal(format_value(null), "_N/A_");
  assert.equal(format_value(undefined), "_N/A_");
});

test("format_value formats booleans", () => {
  assert.equal(format_value(true), "Yes");
  assert.equal(format_value(false), "No");
});

test("format_value formats numbers with locale", () => {
  assert.equal(format_value(1234), "1,234");
  assert.equal(format_value(0), "0");
});

test("format_value shows empty string marker", () => {
  assert.equal(format_value(""), "_empty_");
});

test("format_value passes through regular strings", () => {
  assert.equal(format_value("hello"), "hello");
});

test("format_value formats plain objects instead of [object Object]", () => {
  assert.equal(format_value({ sold: 10, pending: 5 }), "Sold: 10, Pending: 5");
  assert.equal(format_value({}), "_empty_");
});

test("format_value formats arrays as item count", () => {
  assert.equal(format_value([1, 2, 3]), "3 items");
  assert.equal(format_value([]), "0 items");
});

// ---------------------------------------------------------------------------
// format_passthrough_result — error handling
// ---------------------------------------------------------------------------
test("formats error responses", () => {
  const result = format_passthrough_result("lookup_event", { error: "Event not found" });
  assert.match(result, /error/i);
  assert.match(result, /Event not found/);
});

test("handles null result", () => {
  const result = format_passthrough_result("lookup_event", null);
  assert.match(result, /no data/i);
});

// ---------------------------------------------------------------------------
// format_passthrough_result — array results
// ---------------------------------------------------------------------------
test("formats array results with count metadata", () => {
  const raw = {
    result: {
      events: [
        { eid: "AB4001", city: "Toronto", status: "upcoming" },
        { eid: "AB4002", city: "Sydney", status: "upcoming" }
      ],
      count: 2
    }
  };
  const result = format_passthrough_result("lookup_event", raw);
  assert.match(result, /AB4001/);
  assert.match(result, /AB4002/);
  assert.match(result, /Toronto/);
  assert.match(result, /Sydney/);
  assert.match(result, /Count: 2/);
});

test("formats empty array", () => {
  const raw = { result: { events: [], count: 0 } };
  const result = format_passthrough_result("lookup_event", raw);
  assert.match(result, /no events/i);
});

// ---------------------------------------------------------------------------
// format_passthrough_result — flat object (single record)
// ---------------------------------------------------------------------------
test("formats flat object result", () => {
  const raw = {
    result: {
      eid: "AB4003",
      city: "Bangkok",
      venue: "Central World",
      is_public: true,
      notes: null
    }
  };
  const result = format_passthrough_result("lookup_event", raw);
  assert.match(result, /AB4003/);
  assert.match(result, /Bangkok/);
  assert.match(result, /Central World/);
  assert.match(result, /Yes/); // is_public
  assert.match(result, /_N\/A_/); // notes null
});

// ---------------------------------------------------------------------------
// format_passthrough_result — nested objects
// ---------------------------------------------------------------------------
test("formats nested objects with sub-keys", () => {
  const raw = {
    result: {
      eid: "AB4003",
      venue: {
        name: "Central World",
        capacity: 500
      }
    }
  };
  const result = format_passthrough_result("lookup_event", raw);
  assert.match(result, /Central World/);
  assert.match(result, /500/);
});

// ---------------------------------------------------------------------------
// format_passthrough_result — array item labelling
// ---------------------------------------------------------------------------
test("uses name field as array item label when available", () => {
  const raw = {
    result: {
      artists: [
        { name: "Jane Doe", country: "CA" },
        { name: "John Smith", country: "US" }
      ]
    }
  };
  const result = format_passthrough_result("lookup_artist_profile", raw);
  assert.match(result, /\*Jane Doe\*/);
  assert.match(result, /\*John Smith\*/);
});

// ---------------------------------------------------------------------------
// Truncation for large arrays
// ---------------------------------------------------------------------------
test("truncates arrays longer than 25 items", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ name: `Artist ${i}` }));
  const raw = { result: { artists: items } };
  const result = format_passthrough_result("lookup_artist_profile", raw);
  assert.match(result, /and 5 more/);
  assert.match(result, /30 total/);
});
