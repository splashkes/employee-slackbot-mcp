"""
Download, decrypt, and extract RAG index artifact from DO Spaces.
Runs once at startup before the service accepts queries.
"""

import hashlib
import json
import logging
import subprocess
import tarfile
import tempfile
from pathlib import Path

import boto3

from . import config

logger = logging.getLogger("rag-query.artifact_loader")

# Global readiness flag — set after artifact is loaded and verified
_ready = False


def is_ready() -> bool:
    return _ready


def load_artifact() -> None:
    """Download, decrypt, extract, and verify the RAG index artifact."""
    global _ready

    index_dir = config.RAG_INDEX_DIR
    index_dir.mkdir(parents=True, exist_ok=True)

    # Skip download if index already present (e.g. local dev with mounted volume)
    if (config.QDRANT_PATH).exists() and (config.STATE_DB_PATH).exists():
        logger.info("Index already present at %s — skipping download", index_dir)
        _ready = True
        return

    if not config.DO_SPACES_ACCESS_KEY or not config.DO_SPACES_SECRET_KEY:
        raise RuntimeError(
            "DO_SPACES_ACCESS_KEY and DO_SPACES_SECRET_KEY are required for artifact download"
        )

    if not config.RAG_ARTIFACT_ENCRYPTION_KEY:
        raise RuntimeError("RAG_ARTIFACT_ENCRYPTION_KEY is required for decryption")

    s3 = boto3.client(
        "s3",
        endpoint_url=config.DO_SPACES_ENDPOINT,
        region_name=config.DO_SPACES_REGION,
        aws_access_key_id=config.DO_SPACES_ACCESS_KEY,
        aws_secret_access_key=config.DO_SPACES_SECRET_KEY,
    )
    bucket = config.DO_SPACES_BUCKET

    # Resolve version
    version = config.RAG_ARTIFACT_VERSION
    if version == "latest":
        logger.info("Resolving latest artifact version...")
        latest_obj = s3.get_object(Bucket=bucket, Key="latest-manifest.json")
        latest = json.loads(latest_obj["Body"].read().decode("utf-8"))
        version = latest["latest_version"]
        artifact_file = latest["artifact_file"]
        manifest_file = latest["manifest_file"]
    else:
        artifact_file = f"rag-index-v{version}.tar.gz.enc"
        manifest_file = f"rag-index-v{version}-manifest.json"

    logger.info("Loading artifact version: %s", version)

    # Download manifest
    manifest_obj = s3.get_object(Bucket=bucket, Key=manifest_file)
    manifest = json.loads(manifest_obj["Body"].read().decode("utf-8"))
    expected_sha256 = manifest.get("sha256_plaintext", "")

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        encrypted_path = tmp / artifact_file
        decrypted_path = tmp / artifact_file.replace(".enc", "")

        # Download encrypted tarball
        logger.info("Downloading %s (%s)...", artifact_file, bucket)
        s3.download_file(bucket, artifact_file, str(encrypted_path))
        logger.info("Downloaded %d bytes", encrypted_path.stat().st_size)

        # Decrypt
        logger.info("Decrypting...")
        result = subprocess.run(
            [
                "openssl",
                "enc",
                "-d",
                "-aes-256-cbc",
                "-salt",
                "-pbkdf2",
                "-iter",
                "100000",
                "-in",
                str(encrypted_path),
                "-out",
                str(decrypted_path),
                "-pass",
                f"pass:{config.RAG_ARTIFACT_ENCRYPTION_KEY}",
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Decryption failed: {result.stderr}")

        # Verify SHA-256
        if expected_sha256:
            logger.info("Verifying SHA-256 checksum...")
            sha256 = hashlib.sha256()
            with open(decrypted_path, "rb") as f:
                for chunk in iter(lambda: f.read(8192), b""):
                    sha256.update(chunk)
            actual_sha256 = sha256.hexdigest()
            if actual_sha256 != expected_sha256:
                raise RuntimeError(
                    f"Checksum mismatch: expected {expected_sha256}, got {actual_sha256}"
                )
            logger.info("Checksum verified OK")

        # Extract
        logger.info("Extracting to %s...", index_dir)
        with tarfile.open(decrypted_path, "r:gz") as tar:
            tar.extractall(path=str(index_dir))

    # Verify extraction
    if not config.QDRANT_PATH.exists():
        raise RuntimeError(f"Expected {config.QDRANT_PATH} after extraction — not found")
    if not config.STATE_DB_PATH.exists():
        raise RuntimeError(f"Expected {config.STATE_DB_PATH} after extraction — not found")

    logger.info(
        "Artifact loaded: version=%s, qdrant=%s, state_db=%s",
        version,
        config.QDRANT_PATH,
        config.STATE_DB_PATH,
    )
    _ready = True
