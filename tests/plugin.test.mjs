import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const source = fileURLToPath(new URL("../", import.meta.url));
function fixture(t, optedIn = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench plugin "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, "installed plugin");
  fs.cpSync(source, plugin, { recursive: true });
  const repo = path.join(root, "repository");
  fs.mkdirSync(path.join(repo, "tools"), { recursive: true });
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Workbench Test");
  git("config", "user.email", "test@example.invalid");
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({
      workbench: optedIn ? { mode: "direct" } : undefined,
      scripts: optedIn ? { task: "node tools/workbench.mjs" } : {},
    }),
  );
  fs.writeFileSync(
    path.join(repo, "tools/workbench.mjs"),
    'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) })); process.exitCode = process.argv.includes("fail") ? 7 : 0;\n',
  );
  git("add", ".");
  git("commit", "-m", "Adopt Workbench");
  const invoke = (args, cwd = repo) =>
    spawnSync(
      process.execPath,
      [path.join(plugin, "scripts/workbench.mjs"), ...args],
      { cwd, encoding: "utf8" },
    );
  return { root, plugin, repo, git, invoke };
}

test("installed adapter resolves nested directories and preserves arguments and failure status", (t) => {
  const f = fixture(t);
  const result = f.invoke(
    ["start", "example", "--objective", "Literal $HOME and `text`"],
    path.join(f.repo, "tools"),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: fs.realpathSync(f.repo),
    args: ["start", "example", "--objective", "Literal $HOME and `text`"],
  });
  assert.equal(f.invoke(["fail"]).status, 7);
});

test("plugin hooks stay silent in unrelated repositories and outside Git", (t) => {
  const f = fixture(t, false);
  for (const cwd of [f.repo, f.root]) {
    const result = f.invoke(["context"], cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
  assert.equal(f.invoke(["sync"]).status, 1);
});

test("hook executes from its installed plugin root and refreshes a participating worktree", (t) => {
  const f = fixture(t);
  f.git("remote", "add", "origin", f.repo);
  const checkout = path.join(f.root, "task checkout");
  f.git("worktree", "add", "-b", "codex/task", checkout);
  const config = JSON.parse(
    fs.readFileSync(path.join(f.plugin, "hooks/hooks.json")),
  );
  assert.deepEqual(Object.keys(config.hooks), [
    "SessionStart",
    "UserPromptSubmit",
    "SubagentStart",
  ]);
  const command = config.hooks.SessionStart[0].hooks[0].command;
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd: checkout,
    encoding: "utf8",
    env: { ...process.env, PLUGIN_ROOT: f.plugin },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /missing main commits: 0/);
  assert.match(result.stdout, /Adopt Workbench/);
  assert.ok(result.stdout.includes(fs.realpathSync(checkout)));
  assert.equal(f.git("status", "--short"), "");
});

test("hook reports unavailable origin for an opted-in repository", (t) => {
  const f = fixture(t);
  const result = f.invoke(["context"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /freshness could not be established/);
});
