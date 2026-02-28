#!/usr/bin/env bash
# package-and-upload.sh — Package, encrypt, and upload RAG index artifacts to DO Spaces
#
# Prerequisites:
#   - aws cli configured with DO Spaces credentials (or s3cmd)
#   - openssl
#   - RAG_ARTIFACT_ENCRYPTION_KEY env var set
#   - DO_SPACES_ENDPOINT, DO_SPACES_BUCKET env vars set
#
# Usage:
#   RAG_ARTIFACT_ENCRYPTION_KEY=... DO_SPACES_ENDPOINT=tor1.digitaloceanspaces.com \
#     DO_SPACES_BUCKET=esbmcp-rag-artifacts ./package-and-upload.sh

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
RAG_ROOT="${RAG_ROOT:-$HOME/.ab-slack-librarian}"
ENCRYPTION_KEY="${RAG_ARTIFACT_ENCRYPTION_KEY:?RAG_ARTIFACT_ENCRYPTION_KEY is required}"
SPACES_ENDPOINT="${DO_SPACES_ENDPOINT:-tor1.digitaloceanspaces.com}"
SPACES_BUCKET="${DO_SPACES_BUCKET:-esbmcp-rag-artifacts}"
RETAIN_VERSIONS="${RETAIN_VERSIONS:-3}"

VERSION="$(date -u +%Y%m%d-%H%M%S)"
ARTIFACT_NAME="rag-index-v${VERSION}"
WORK_DIR="$(mktemp -d)"

trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Packaging RAG index artifact: ${ARTIFACT_NAME}"
echo "    Source: ${RAG_ROOT}"
echo "    Bucket: s3://${SPACES_BUCKET}"

# ── Validate source ────────────────────────────────────────────────────────
if [ ! -d "${RAG_ROOT}/qdrant" ]; then
  echo "ERROR: ${RAG_ROOT}/qdrant directory not found" >&2
  exit 1
fi

if [ ! -f "${RAG_ROOT}/state.db" ]; then
  echo "ERROR: ${RAG_ROOT}/state.db not found" >&2
  exit 1
fi

# ── Tar ─────────────────────────────────────────────────────────────────────
TARBALL="${WORK_DIR}/${ARTIFACT_NAME}.tar.gz"
echo "==> Creating tarball..."
tar -czf "$TARBALL" -C "$RAG_ROOT" qdrant state.db

TARBALL_SIZE=$(stat -f%z "$TARBALL" 2>/dev/null || stat --printf="%s" "$TARBALL")
TARBALL_SHA256=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
echo "    Size: ${TARBALL_SIZE} bytes"
echo "    SHA-256: ${TARBALL_SHA256}"

# ── Collect stats ───────────────────────────────────────────────────────────
QDRANT_DIR_SIZE=$(du -sb "${RAG_ROOT}/qdrant" 2>/dev/null | awk '{print $1}' || echo "0")
STATE_DB_SIZE=$(stat -f%z "${RAG_ROOT}/state.db" 2>/dev/null || stat --printf="%s" "${RAG_ROOT}/state.db")

# ── Generate manifest ──────────────────────────────────────────────────────
MANIFEST="${WORK_DIR}/${ARTIFACT_NAME}-manifest.json"
cat > "$MANIFEST" <<MANIFEST_EOF
{
  "version": "${VERSION}",
  "artifact_name": "${ARTIFACT_NAME}",
  "embedding_model": "qwen3-embedding",
  "embedding_dim": 4096,
  "sha256_plaintext": "${TARBALL_SHA256}",
  "tarball_size_bytes": ${TARBALL_SIZE},
  "qdrant_dir_size_bytes": ${QDRANT_DIR_SIZE},
  "state_db_size_bytes": ${STATE_DB_SIZE},
  "packaged_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_path": "${RAG_ROOT}"
}
MANIFEST_EOF

echo "==> Manifest:"
cat "$MANIFEST"

# ── Encrypt ─────────────────────────────────────────────────────────────────
ENCRYPTED="${TARBALL}.enc"
echo "==> Encrypting with AES-256-CBC..."
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 \
  -in "$TARBALL" \
  -out "$ENCRYPTED" \
  -pass "pass:${ENCRYPTION_KEY}"

ENCRYPTED_SIZE=$(stat -f%z "$ENCRYPTED" 2>/dev/null || stat --printf="%s" "$ENCRYPTED")
echo "    Encrypted size: ${ENCRYPTED_SIZE} bytes"

# ── Upload ──────────────────────────────────────────────────────────────────
S3_URL="https://${SPACES_ENDPOINT}"

echo "==> Uploading encrypted tarball..."
aws s3 cp "$ENCRYPTED" "s3://${SPACES_BUCKET}/${ARTIFACT_NAME}.tar.gz.enc" \
  --endpoint-url "$S3_URL"

echo "==> Uploading manifest..."
aws s3 cp "$MANIFEST" "s3://${SPACES_BUCKET}/${ARTIFACT_NAME}-manifest.json" \
  --endpoint-url "$S3_URL" \
  --content-type "application/json"

# ── Update latest pointer ──────────────────────────────────────────────────
LATEST_MANIFEST="${WORK_DIR}/latest-manifest.json"
cat > "$LATEST_MANIFEST" <<LATEST_EOF
{
  "latest_version": "${VERSION}",
  "artifact_file": "${ARTIFACT_NAME}.tar.gz.enc",
  "manifest_file": "${ARTIFACT_NAME}-manifest.json",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
LATEST_EOF

aws s3 cp "$LATEST_MANIFEST" "s3://${SPACES_BUCKET}/latest-manifest.json" \
  --endpoint-url "$S3_URL" \
  --content-type "application/json"

echo "==> Updated latest-manifest.json"

# ── Retention: keep last N versions ────────────────────────────────────────
echo "==> Pruning old versions (keeping last ${RETAIN_VERSIONS})..."
MANIFESTS=$(aws s3 ls "s3://${SPACES_BUCKET}/" \
  --endpoint-url "$S3_URL" \
  | grep 'rag-index-v.*-manifest\.json$' \
  | grep -v 'latest-manifest' \
  | sort -k4 \
  | awk '{print $4}')

COUNT=$(echo "$MANIFESTS" | grep -c . || true)
if [ "$COUNT" -gt "$RETAIN_VERSIONS" ]; then
  DELETE_COUNT=$((COUNT - RETAIN_VERSIONS))
  echo "    Deleting ${DELETE_COUNT} old version(s)..."

  echo "$MANIFESTS" | head -n "$DELETE_COUNT" | while read -r manifest_file; do
    version_prefix="${manifest_file%-manifest.json}"
    echo "    Removing ${version_prefix}..."
    aws s3 rm "s3://${SPACES_BUCKET}/${version_prefix}.tar.gz.enc" --endpoint-url "$S3_URL" 2>/dev/null || true
    aws s3 rm "s3://${SPACES_BUCKET}/${manifest_file}" --endpoint-url "$S3_URL" 2>/dev/null || true
  done
fi

echo "==> Done! Artifact ${ARTIFACT_NAME} uploaded to s3://${SPACES_BUCKET}/"
