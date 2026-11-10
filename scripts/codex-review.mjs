// The isolated, read-only Codex runner for the shared structured reviewer contract (review.mjs). Codex loads no
// user config, rules, project docs, hooks, plugins, memories or skills; it reads the source roots and nothing that
// carries the author's context: the task's evidence directory, .workbench/, .git/, personal agent directories, and
// the uncommitted local instruction files. The repository's committed AGENTS.md and CLAUDE.md stay readable as
// source, as they are for the Claude reviewer, and are never loaded as instructions (project_doc_max_bytes=0).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function reviewConfig(cwd, dirs = [], taskDir) {
  const roots = [cwd, ...dirs].map((p) => fs.realpathSync(p));
  const filesystem = { ":minimal": "read" };
  for (const root of roots) filesystem[root] = "read";
  const privateDirs = [".claude", ".codex", ".agents"];
  for (const name of privateDirs) filesystem[path.join(os.homedir(), name)] = "deny";
  for (const root of roots) {
    for (const name of [...privateDirs, ".workbench", ".git", "AGENTS.override.md", "CLAUDE.local.md"]) {
      filesystem[path.join(root, name)] = "deny";
    }
  }
  if (taskDir) filesystem[fs.realpathSync(taskDir)] = "deny";
  const tomlMap = `{${Object.entries(filesystem).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",")}}`;
  return [
    "project_doc_max_bytes=0", "project_doc_fallback_filenames=[]",
    "skills.bundled.enabled=false", "skills.include_instructions=false",
    "features.hooks=false", "features.plugins=false", "features.apps=false", "features.memories=false",
    "features.multi_agent=false", "features.skill_search=false", "web_search=\"disabled\"",
    "approval_policy=\"never\"", "allow_login_shell=false", "shell_environment_policy.inherit=\"none\"",
    "shell_environment_policy.experimental_use_profile=false",
    "default_permissions=\"workbench-review\"",
    `permissions.workbench-review.filesystem=${tomlMap}`,
    "permissions.workbench-review.network.enabled=false",
  ];
}

// Runs one review and returns { r, result, errors }: the process outcome, the parsed final message when there is
// one (undefined otherwise), and the error text Codex reported (its JSONL error events and stderr), for review.mjs
// to tell an unavailable runner from a failed review.
export function runCodex({ prompt, schema, model, effort, cwd, dirs, taskDir }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-review-"));
  try {
    const schemaFile = path.join(temp, "schema.json");
    const resultFile = path.join(temp, "result.json");
    fs.writeFileSync(schemaFile, JSON.stringify(schema));
    const args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--model", model,
      "--json", "--color", "never", "--output-schema", schemaFile, "--output-last-message", resultFile];
    for (const config of [`model_reasoning_effort=${JSON.stringify(effort)}`, ...reviewConfig(cwd, dirs, taskDir)]) args.push("-c", config);
    args.push("-");
    const r = spawnSync(process.env.WORKBENCH_CODEX || "codex", args, { cwd, input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    let result;
    if (fs.existsSync(resultFile)) {
      try { result = JSON.parse(fs.readFileSync(resultFile, "utf8")); } catch {}
    }
    return { r, result, errors: errorsOf(r) };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// The messages of the JSONL error and turn.failed events, then stderr. Agent messages and tool output are left
// out: a file the reviewer reads may say "usage limit" without Codex being limited.
export function errorsOf(r) {
  const messages = [];
  for (const line of String(r.stdout || "").split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "error" && event.message) messages.push(String(event.message));
      if (event.type === "turn.failed" && event.error?.message) messages.push(String(event.error.message));
    } catch {}
  }
  if (r.stderr?.trim()) messages.push(r.stderr.trim());
  return messages.join("\n");
}
