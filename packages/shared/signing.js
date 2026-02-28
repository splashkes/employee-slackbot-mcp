import crypto from "node:crypto";

function build_canonical_payload({ timestamp_sec, method, pathname, body_text }) {
  return [String(timestamp_sec), method.toUpperCase(), pathname, body_text].join("\n");
}

function compute_signature(secret, canonical_payload) {
  return crypto.createHmac("sha256", secret).update(canonical_payload).digest("hex");
}

function hash_json_payload(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload || {}))
    .digest("hex");
}

export { build_canonical_payload, compute_signature, hash_json_payload };
