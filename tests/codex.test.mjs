import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const source = fileURLToPath(new URL("../", import.meta.url));
function setup(t, config = { mode: "local", hooks: { check: [{ name: "ok", command: [process.execPath, "-e", "process.exit(0)"] }] } }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wb codex ")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, "installed plugin");
  fs.mkdirSync(plugin);
  for (const name of ["scripts", "skills", "hooks", "reviewers", ".codex-plugin", ".agents"])
    fs.cpSync(path.join(source, name), path.join(plugin, name), { recursive: true });
  const repo = path.join(root, "repository");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  if (config) fs.writeFileSync(path.join(repo, ".git/workbench.json"), JSON.stringify(config));
  const invoke = (args, cwd = repo) => spawnSync(process.execPath, [path.join(plugin, "scripts/workbench.mjs"), ...args], { cwd, encoding: "utf8" });
  return { root, repo, plugin, git, invoke };
}

test("native Codex hooks resolve a standalone installed plugin with spaces and return event context", t => {
  const f = setup(t);
  const hooks = JSON.parse(fs.readFileSync(path.join(f.plugin, "hooks/hooks.json"), "utf8")).hooks;
  for (const event of ["SessionStart", "UserPromptSubmit", "SubagentStart"]) {
    const command = hooks[event][0].hooks[0].command;
    const r = spawnSync("/bin/sh", ["-c", command], { cwd: f.repo, encoding: "utf8", env: { ...process.env, PLUGIN_ROOT: f.plugin } });
    assert.equal(r.status, 0, r.stderr);
    const context = event === "SessionStart" ? r.stdout : JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /Workbench \(local mode/);
    if (event !== "SessionStart") assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, event);
    assert.equal(f.git("status", "--short"), "");
  }
});

test("hooks stay silent outside configured repositories and Git", t => {
  const f = setup(t, null);
  for (const cwd of [f.repo, f.root]) {
    const r = f.invoke(["context", "--hook", "SubagentStart"], cwd);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  }
});

test("local and shared policies take precedence over legacy package.json policy", t => {
  const f = setup(t, null);
  fs.writeFileSync(path.join(f.repo, "package.json"), JSON.stringify({ workbench: { mode: "local", branchPrefix: "package/" } }));
  const inspect = () => JSON.parse(f.invoke(["inspect"]).stdout).config;
  assert.equal(inspect().branchPrefix, "package/");
  fs.writeFileSync(path.join(f.repo, ".git/workbench.json"), JSON.stringify({ mode: "local", branchPrefix: "clone/" }));
  assert.equal(inspect().branchPrefix, "clone/");
  fs.writeFileSync(path.join(f.repo, ".workbench.json"), JSON.stringify({ mode: "local" }));
  assert.equal(inspect().branchPrefix, "codex/");
});

test("first-version Codex task metadata retains its existing checkout and requires fresh evidence", t => {
  const f = setup(t);
  const dir = path.join(f.repo, ".workbench/tasks/old");
  const wt = path.join(dir, "repo");
  f.git("worktree", "add", "-q", "-b", "codex/old", wt);
  fs.appendFileSync(path.join(f.repo, ".git/info/exclude"), "\n/.workbench/\n");
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ name: "old", path: wt, branch: "codex/old", scopes: ["a.txt"], objective: "Change a", phase: "active", mode: "local", startBase: f.git("rev-parse", "HEAD") }));
  fs.writeFileSync(path.join(dir, "plan.md"), "## Objective\nChange a.\n## Steps\n- [x] Edit a.\n## Acceptance\n- [x] a says b.\n");
  fs.writeFileSync(path.join(wt, "a.txt"), "b\n");
  const status = JSON.parse(f.invoke(["status"]).stdout)[0];
  assert.equal(status.path, wt);
  assert.equal(status.state, "active");
  assert.equal(status.verified, false);
  const check = f.invoke(["check"], wt);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).receipt.passed, true);
  const land = f.invoke(["land", "--message", "fix: a"], wt);
  assert.notEqual(land.status, 0);
  assert.match(land.stderr, /Result: pass/);
  assert.equal(fs.readFileSync(path.join(f.repo, "a.txt"), "utf8"), "a\n");
});
