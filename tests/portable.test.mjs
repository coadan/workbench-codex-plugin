import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const pluginSource = fileURLToPath(new URL("../", import.meta.url));
function fixture(t, mode) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "portable-workbench-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const plugin = path.join(parent, "installed");
  fs.cpSync(pluginSource, plugin, { recursive: true });
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(repo, "init", "--initial-branch=trunk");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src/example.py"), "initial\n");
  fs.writeFileSync(
    path.join(repo, ".workbench.json"),
    JSON.stringify({
      mode,
      branch: "trunk",
      remote: "upstream",
      hooks: {
        prepare: [
          {
            name: "setup",
            command: [
              process.execPath,
              "-e",
              'require("fs").writeFileSync("src/setup.txt", "prepared\\n")',
            ],
          },
        ],
        check: [
          {
            name: "test",
            command: [
              process.execPath,
              "-e",
              'process.exit(require("fs").readFileSync("src/example.py", "utf8").includes("FAIL") ? 1 : 0)',
            ],
          },
        ],
      },
    }),
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Initial");
  const origin = path.join(parent, "origin.git");
  if (mode !== "local") {
    git(parent, "clone", "--bare", repo, origin);
    git(repo, "remote", "add", "upstream", origin);
  }
  const invoke = (cwd, args, ok = true) => {
    const r = spawnSync(
      process.execPath,
      [path.join(plugin, "scripts/workbench.mjs"), ...args],
      { cwd, encoding: "utf8" },
    );
    if (ok) assert.equal(r.status, 0, r.stderr);
    return r;
  };
  invoke(repo, [
    "start",
    "task",
    "--objective",
    "Improve the example",
    "--scope",
    "src",
  ]);
  const task = path.join(repo, ".workbench/tasks/task/repo");
  const state = path.join(repo, ".workbench/tasks/task");
  fs.writeFileSync(
    path.join(state, "plan.md"),
    "## Objective\nImprove the example.\n## Steps\n- [x] Implement the change.\n## Acceptance\n- [x] Verify the result.\n",
  );
  fs.writeFileSync(path.join(task, "src/example.py"), "improved\n");
  const review = () => {
    const receipt = JSON.parse(invoke(task, ["check"]).stdout);
    fs.writeFileSync(
      path.join(state, "review.md"),
      `Tree: ${receipt.tree}\nBase: ${receipt.base}\nResult: pass\nReviewed the scoped change and verified preservation of repository data.\n`,
    );
  };
  return { parent, repo, origin, task, state, git, invoke, review };
}

test("portable engine lands locally without a remote or package.json and executes repository hooks", (t) => {
  const f = fixture(t, "local");
  assert.equal(
    fs.readFileSync(path.join(f.task, "src/setup.txt"), "utf8"),
    "prepared\n",
  );
  f.review();
  f.invoke(f.task, ["land", "--message", "Improve example"]);
  assert.equal(f.git(f.repo, "remote"), "");
  assert.equal(
    fs.readFileSync(path.join(f.repo, "src/example.py"), "utf8"),
    "improved\n",
  );
  assert.equal(fs.existsSync(f.task), false);
});

test("portable direct mode pushes to the configured remote and base branch", (t) => {
  const f = fixture(t, "direct");
  f.review();
  f.invoke(f.task, ["land", "--message", "Improve example"]);
  assert.equal(
    f.git(f.repo, "rev-parse", "HEAD"),
    f.git(f.origin, "rev-parse", "trunk"),
  );
});

test("PR mode pushes the task branch and closes only after verified squash merge", (t) => {
  const f = fixture(t, "pr");
  const base = f.git(f.origin, "rev-parse", "trunk");
  f.review();
  f.invoke(f.task, ["land", "--message", "Improve example"]);
  assert.equal(f.git(f.origin, "rev-parse", "trunk"), base);
  assert.equal(
    f.git(f.origin, "rev-parse", "codex/task"),
    f.git(f.task, "rev-parse", "HEAD"),
  );
  assert.notEqual(
    f.invoke(f.task, ["land", "--merged", base], false).status,
    0,
  );
  const merger = path.join(f.parent, "forge");
  f.git(f.parent, "clone", f.origin, merger);
  f.git(merger, "config", "user.name", "Forge");
  f.git(merger, "config", "user.email", "forge@example.invalid");
  f.git(merger, "merge", "--squash", "origin/codex/task");
  f.git(merger, "commit", "-m", "Squash PR");
  f.git(merger, "push");
  const merged = f.git(merger, "rev-parse", "HEAD");
  f.invoke(f.task, ["land", "--merged", merged]);
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), merged);
  assert.equal(fs.existsSync(f.task), false);
});

test("repository verification failure blocks portable local landing", (t) => {
  const f = fixture(t, "local");
  const base = f.git(f.repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(f.task, "src/example.py"), "FAIL\n");
  assert.notEqual(
    f.invoke(f.task, ["land", "--message", "Broken change"], false).status,
    0,
  );
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), base);
  assert.equal(
    fs.readFileSync(path.join(f.task, "src/example.py"), "utf8"),
    "FAIL\n",
  );
});
