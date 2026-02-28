import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { Logger } from "./logger.js";

const exec = promisify(execFile);
const logger = new Logger(process.env.LOG_LEVEL || "info");

const DEFAULT_CLONE_DIR = "/tmp/ab-repo-clone";
const MAX_FILE_SIZE_BYTES = 512_000; // 500 KB
const MAX_SEARCH_RESULTS = 50;

function create_repo_browser({ repo_url, clone_dir, branch }) {
  const repo_path = clone_dir || DEFAULT_CLONE_DIR;
  const target_branch = branch || "main";

  if (!repo_url) {
    logger.warn("repo_browser_skipped", { reason: "no CODEBASE_REPO_URL provided" });
    return null;
  }

  async function ensure_clone() {
    try {
      await fs.access(path.join(repo_path, ".git"));
      // Pull latest
      await exec("git", ["fetch", "origin", target_branch], { cwd: repo_path, timeout: 60_000 });
      await exec("git", ["reset", "--hard", `origin/${target_branch}`], { cwd: repo_path, timeout: 30_000 });
      logger.info("repo_browser_updated", { branch: target_branch });
    } catch {
      // Clone fresh
      await fs.mkdir(repo_path, { recursive: true });
      await exec("git", ["clone", "--depth", "1", "--branch", target_branch, repo_url, repo_path], { timeout: 120_000 });
      logger.info("repo_browser_cloned", { repo_url, branch: target_branch });
    }
  }

  async function search_files(pattern, file_glob) {
    await ensure_clone();

    const args = ["grep", "-rl", "--no-color"];
    if (file_glob) {
      args.push("--", pattern, file_glob);
    } else {
      args.push("--", pattern);
    }

    try {
      const { stdout } = await exec("git", args, { cwd: repo_path, timeout: 15_000 });
      const files = stdout.trim().split("\n").filter(Boolean).slice(0, MAX_SEARCH_RESULTS);
      return { files, count: files.length };
    } catch (error) {
      if (error.code === 1) {
        return { files: [], count: 0 };
      }
      throw error;
    }
  }

  async function read_file(file_path, max_lines) {
    await ensure_clone();

    const full_path = path.join(repo_path, file_path);
    const resolved = path.resolve(full_path);

    // Prevent path traversal
    if (!resolved.startsWith(path.resolve(repo_path))) {
      throw new Error("Path traversal not allowed");
    }

    const stat = await fs.stat(resolved);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE_BYTES})`);
    }

    const content = await fs.readFile(resolved, "utf8");
    if (max_lines && max_lines > 0) {
      const lines = content.split("\n");
      return {
        content: lines.slice(0, max_lines).join("\n"),
        total_lines: lines.length,
        truncated: lines.length > max_lines
      };
    }

    return { content, total_lines: content.split("\n").length, truncated: false };
  }

  async function list_directory(dir_path) {
    await ensure_clone();

    const full_path = path.join(repo_path, dir_path || "");
    const resolved = path.resolve(full_path);

    if (!resolved.startsWith(path.resolve(repo_path))) {
      throw new Error("Path traversal not allowed");
    }

    const entries = await fs.readdir(resolved, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file"
    }));
  }

  async function find_files(glob_pattern) {
    await ensure_clone();

    const args = ["ls-files", "--", glob_pattern];
    const { stdout } = await exec("git", args, { cwd: repo_path, timeout: 15_000 });
    const files = stdout.trim().split("\n").filter(Boolean).slice(0, MAX_SEARCH_RESULTS);
    return { files, count: files.length };
  }

  return { ensure_clone, search_files, read_file, list_directory, find_files };
}

export { create_repo_browser };
