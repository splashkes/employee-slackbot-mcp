import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const base_dir = path.resolve(__dirname, "..", "..", "deploy", "k8s", "base");

function load_yaml_documents(file_name) {
  const file_path = path.join(base_dir, file_name);
  const raw_text = fs.readFileSync(file_path, "utf8");
  return raw_text.split(/^---$/m).map((s) => s.trim()).filter(Boolean);
}

test("kustomization.yaml exists and references all resource files", () => {
  const kustomization_text = fs.readFileSync(path.join(base_dir, "kustomization.yaml"), "utf8");
  const expected_resources = [
    "namespaces.yaml",
    "services.yaml",
    "orchestration-api-deployment.yaml",
    "orchestration-supervisor-deployment.yaml",
    "execution-runners-deployments.yaml",
    "networkpolicy.yaml"
  ];
  for (const resource of expected_resources) {
    assert.match(kustomization_text, new RegExp(resource), `Missing resource: ${resource}`);
  }
});

test("namespaces include orchestration, execution, and shared", () => {
  const docs = load_yaml_documents("namespaces.yaml");
  const namespace_names = docs
    .filter((d) => d.includes("kind: Namespace"))
    .map((d) => {
      const match = d.match(/name:\s+(\S+)/);
      return match ? match[1] : null;
    });
  assert.ok(namespace_names.includes("artbattle-orchestration"), "Missing orchestration namespace");
  assert.ok(namespace_names.includes("artbattle-execution"), "Missing execution namespace");
  assert.ok(namespace_names.includes("shared"), "Missing shared namespace for Redis");
});

test("secrets template has REDIS_URL pointing to shared namespace", () => {
  const secrets_text = fs.readFileSync(path.join(base_dir, "secrets.template.yaml"), "utf8");
  const redis_urls = [...secrets_text.matchAll(/REDIS_URL:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(redis_urls.length > 0, "No REDIS_URL found in secrets");
  for (const url of redis_urls) {
    assert.match(url, /\.shared\.svc/, `REDIS_URL ${url} does not reference shared namespace`);
  }
});

test("network policies include ingress rules for orchestration-api", () => {
  const docs = load_yaml_documents("networkpolicy.yaml");
  const api_ingress = docs.find(
    (d) => d.includes("orchestration-api-ingress") && d.includes("kind: NetworkPolicy")
  );
  assert.ok(api_ingress, "Missing orchestration-api-ingress NetworkPolicy");
  assert.ok(api_ingress.includes("port: 3000"), "orchestration-api ingress must allow port 3000");
});

test("network policies allow Redis egress to shared namespace (not cross-plane)", () => {
  const docs = load_yaml_documents("networkpolicy.yaml");
  const orchestration_egress = docs.find((d) => d.includes("orchestration-egress-policy"));
  assert.ok(orchestration_egress, "Missing orchestration-egress-policy");
  assert.ok(
    orchestration_egress.includes("kubernetes.io/metadata.name: shared"),
    "Orchestration egress must target shared namespace for Redis"
  );
  assert.ok(
    !orchestration_egress.includes("kubernetes.io/metadata.name: artbattle-execution"),
    "Orchestration egress should not target execution namespace for Redis"
  );

  const execution_egress = docs.find((d) => d.includes("execution-egress-policy"));
  assert.ok(execution_egress, "Missing execution-egress-policy");
  assert.ok(
    execution_egress.includes("kubernetes.io/metadata.name: shared"),
    "Execution egress must target shared namespace for Redis"
  );
});

test("all deployment images are explicitly marked as placeholders", () => {
  const deployment_files = [
    "orchestration-api-deployment.yaml",
    "orchestration-supervisor-deployment.yaml",
    "execution-runners-deployments.yaml"
  ];
  for (const file_name of deployment_files) {
    const file_text = fs.readFileSync(path.join(base_dir, file_name), "utf8");
    const image_lines = [...file_text.matchAll(/image:\s*(.+)/g)].map((m) => m[1].trim());
    assert.ok(image_lines.length > 0, `No image fields found in ${file_name}`);
    for (const image_ref of image_lines) {
      assert.match(
        image_ref,
        /REPLACE_ME/,
        `Image in ${file_name} is not marked as placeholder: ${image_ref}`
      );
    }
  }
});

test("services expose expected ports", () => {
  const services_text = fs.readFileSync(path.join(base_dir, "services.yaml"), "utf8");
  assert.match(services_text, /port: 3000/, "orchestration-api service must expose port 3000");
  assert.match(services_text, /port: 8080/, "orchestration-supervisor service must expose port 8080");
});
