// Isolated, read-only fallback for the shared structured reviewer contract.
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
    for (const name of [...privateDirs, ".workbench", ".git", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"]) {
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

export function runCodexReview({ prompt, schema, model, effort, cwd, dirs, taskDir }) {
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
    if (r.error || r.signal || r.status !== 0) throw new Error(`codex fallback failed (${r.error?.code || r.signal || r.status}): ${String(r.stderr || r.stdout || r.error?.message || "no result").slice(0, 2000)}`);
    let result;
    try { result = JSON.parse(fs.readFileSync(resultFile, "utf8")); }
    catch { throw new Error("codex fallback returned no valid JSON verdict"); }
    return result;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
