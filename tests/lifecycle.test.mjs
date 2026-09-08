import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mainContext } from "../scripts/context.mjs";

const cli = fileURLToPath(new URL("../scripts/workbench.mjs", import.meta.url));
const run = (cwd, command, args, ok = true) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (ok)
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
    );
  return result;
};
const git = (cwd, ...args) => run(cwd, "git", args).stdout.trim();
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
const json = (output) => {
  for (
    let index = output.indexOf("{");
    index !== -1;
    index = output.indexOf("{", index + 1)
  ) {
    try {
      return JSON.parse(output.slice(index));
    } catch {}
  }
  assert.fail(`No final JSON value in output: ${output}`);
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "workbench-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const primary = join(root, "primary");
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "clone", origin, primary);
  git(primary, "config", "user.name", "Workbench Test");
  git(primary, "config", "user.email", "workbench@example.invalid");
  write(join(primary, ".gitignore"), ".worktrees/\n.workbench/\n");
  write(
    join(primary, "package.json"),
    JSON.stringify({
      private: true,
      workbench: { mode: "direct", hooks: { check: [{ name: "check:workbench", command: [process.execPath, "verify.cjs"] }] } },
      scripts: { "check:workbench": "node verify.cjs" },
    }),
  );
  write(
    join(primary, "verify.cjs"),
    "const fs = require('node:fs'); process.exit(fs.readFileSync('tools/workbench/demo.txt', 'utf8').includes('FAIL') ? 1 : 0);\n",
  );
  write(join(primary, "tools/workbench/demo.txt"), "initial\n");
  write(join(primary, "outside.txt"), "preserve\n");
  git(primary, "add", ".");
  git(primary, "commit", "-m", "fixture");
  git(primary, "push", "-u", "origin", "main");
  const invoke = (cwd, args, ok = true) =>
    run(cwd, process.execPath, [cli, ...args], ok);
  const state = (name) => join(primary, ".workbench/tasks", name);
  const start = (name = "task") => {
    invoke(primary, [
      "start",
      name,
      "--objective",
      "Prove safe local landing",
      "--scope",
      "tools/workbench",
    ]);
    const path = join(primary, ".workbench/tasks", name, "repo");
    assert.ok(existsSync(join(state(name), "task.json")));
    assert.equal(git(path, "branch", "--show-current"), `codex/${name}`);
    write(
      join(state(name), "plan.md"),
      "# Plan\n\n## Objective\nProve safe local landing.\n\n## Steps\n- [x] Implement the bounded change.\n\n## Acceptance\n- [x] Verify the resulting change.\n",
    );
    return path;
  };
  const check = (path) => json(invoke(path, ["check"]).stdout);
  const review = (path, name = "task") => {
    const receipt = check(path);
    assert.ok(
      receipt.tree && receipt.base,
      "receipt binds verification to tree and base",
    );
    write(
      join(state(name), "review.md"),
      `Tree: ${receipt.tree}\nBase: ${receipt.base}\nResult: pass\n\nReviewed the complete scoped diff and verified that fixture data and unrelated paths remain intact.\n`,
    );
    return receipt;
  };
  const land = (path, ok = true) =>
    invoke(path, ["land", "--message", "Land verified fixture change"], ok);
  const remote = () =>
    git(primary, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0];
  const advance = () => {
    const other = join(root, `other-${Math.random().toString(16).slice(2)}`);
    git(root, "clone", origin, other);
    git(other, "config", "user.name", "Other Test");
    git(other, "config", "user.email", "other@example.invalid");
    write(join(other, "upstream.txt"), `${other}\n`);
    git(other, "add", ".");
    git(other, "commit", "-m", "Concurrent main change");
    git(other, "push");
    return git(other, "rev-parse", "HEAD");
  };
  return {
    root,
    origin,
    primary,
    invoke,
    start,
    state,
    check,
    review,
    land,
    remote,
    advance,
  };
}

test("refuses dirty primary state, preserves it, and lands after resolution", (t) => {
  const f = fixture(t);
  write(join(f.primary, "outside.txt"), "primary dirty data\n");
  write(join(f.primary, "personal.txt"), "untracked primary data\n");
  assert.notEqual(f.invoke(f.primary, ["sync"], false).status, 0);
  assert.notEqual(
    f.invoke(
      f.primary,
      [
        "start",
        "task",
        "--objective",
        "Prove safe landing",
        "--scope",
        "tools/workbench",
      ],
      false,
    ).status,
    0,
  );
  assert.equal(
    readFileSync(join(f.primary, "outside.txt"), "utf8"),
    "primary dirty data\n",
  );
  assert.equal(
    readFileSync(join(f.primary, "personal.txt"), "utf8"),
    "untracked primary data\n",
  );
  write(join(f.primary, "outside.txt"), "preserve\n");
  rmSync(join(f.primary, "personal.txt"));
  const path = f.start();
  write(join(path, "tools/workbench/demo.txt"), "landed\n");
  f.review(path);
  f.land(path);
  assert.equal(git(f.primary, "rev-parse", "HEAD"), f.remote());
  assert.equal(
    readFileSync(join(f.primary, "outside.txt"), "utf8"),
    "preserve\n",
  );
  assert.equal(
    readFileSync(join(f.primary, "tools/workbench/demo.txt"), "utf8"),
    "landed\n",
  );
  assert.equal(existsSync(path), false);
});

test("rejects out-of-scope tracked and untracked work without losing it", (t) => {
  const f = fixture(t);
  const before = f.remote();
  const path = f.start();
  write(join(path, "outside.txt"), "dirty data\n");
  write(join(path, "private.txt"), "untracked data\n");
  assert.notEqual(f.land(path, false).status, 0);
  assert.equal(f.remote(), before);
  assert.equal(readFileSync(join(path, "outside.txt"), "utf8"), "dirty data\n");
  assert.equal(
    readFileSync(join(path, "private.txt"), "utf8"),
    "untracked data\n",
  );
  assert.equal(git(path, "branch", "--show-current"), "codex/task");
});

test("failing verification prevents push and preserves recoverable task data", (t) => {
  const f = fixture(t);
  const before = f.remote();
  const path = f.start();
  write(join(path, "tools/workbench/demo.txt"), "FAIL\n");
  assert.notEqual(f.invoke(path, ["check"], false).status, 0);
  assert.notEqual(f.land(path, false).status, 0);
  assert.equal(f.remote(), before);
  assert.equal(
    readFileSync(join(path, "tools/workbench/demo.txt"), "utf8"),
    "FAIL\n",
  );
  assert.ok(existsSync(join(f.state("task"), "plan.md")));
});

test("editing after review invalidates approval and a new review permits retry", (t) => {
  const f = fixture(t);
  const before = f.remote();
  const path = f.start();
  write(join(path, "tools/workbench/demo.txt"), "reviewed\n");
  f.review(path);
  write(join(path, "tools/workbench/demo.txt"), "changed after review\n");
  assert.notEqual(f.land(path, false).status, 0);
  assert.equal(f.remote(), before);
  assert.ok(existsSync(path));
  f.review(path);
  f.land(path);
  assert.equal(
    readFileSync(join(f.primary, "tools/workbench/demo.txt"), "utf8"),
    "changed after review\n",
  );
});

test("unfinished acceptance blocks landing while preserving the reviewed task", (t) => {
  const f = fixture(t);
  const before = f.remote();
  const path = f.start();
  write(join(path, "tools/workbench/demo.txt"), "ready implementation\n");
  f.review(path);
  const plan = join(f.state("task"), "plan.md");
  write(
    plan,
    readFileSync(plan, "utf8").replace("- [x] Verify", "- [ ] Verify"),
  );
  assert.notEqual(f.land(path, false).status, 0);
  assert.equal(f.remote(), before);
  assert.ok(existsSync(path));
  write(
    plan,
    readFileSync(plan, "utf8").replace("- [ ] Verify", "- [x] Verify"),
  );
  f.land(path);
  assert.equal(git(f.primary, "rev-parse", "HEAD"), f.remote());
});

test("fresh upstream changes invalidate review after rebase and survive landing", (t) => {
  const f = fixture(t);
  const path = f.start();
  write(join(path, "tools/workbench/demo.txt"), "task change\n");
  f.review(path);
  const upstream = f.advance();
  assert.notEqual(f.invoke(path, ["check"], false).status, 0);
  assert.notEqual(f.land(path, false).status, 0);
  assert.equal(f.remote(), upstream);
  assert.equal(
    run(path, "git", ["merge-base", "--is-ancestor", upstream, "HEAD"], false)
      .status,
    0,
  );
  f.review(path);
  f.land(path);
  assert.ok(existsSync(join(f.primary, "upstream.txt")));
  assert.equal(git(f.primary, "rev-parse", "HEAD"), f.remote());
});

test("remote push rejection leaves branch and state available for retry", (t) => {
  const f = fixture(t);
  const before = f.remote();
  const path = f.start();
  write(join(path, "tools/workbench/demo.txt"), "retryable\n");
  f.review(path);
  const hook = join(f.origin, "hooks/pre-receive");
  write(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  assert.notEqual(f.land(path, false).status, 0);
  assert.equal(f.remote(), before);
  assert.ok(existsSync(path));
  assert.ok(existsSync(join(f.state("task"), "task.json")));
  rmSync(hook);
  f.land(path);
  assert.equal(git(f.primary, "rev-parse", "HEAD"), f.remote());
});

test("two isolated tasks land sequentially with second reviewed against new main", (t) => {
  const f = fixture(t);
  const first = f.start("first");
  const second = f.start("second");
  write(join(first, "tools/workbench/first.txt"), "first\n");
  f.review(first, "first");
  write(join(second, "tools/workbench/second.txt"), "second\n");
  f.review(second, "second");
  f.land(first);
  assert.notEqual(f.land(second, false).status, 0);
  f.review(second, "second");
  f.land(second);
  assert.equal(
    readFileSync(join(f.primary, "tools/workbench/first.txt"), "utf8"),
    "first\n",
  );
  assert.equal(
    readFileSync(join(f.primary, "tools/workbench/second.txt"), "utf8"),
    "second\n",
  );
  assert.equal(git(f.primary, "rev-parse", "HEAD"), f.remote());
});

test("landing reads back a main advance occurring during the push", (t) => {
  const f = fixture(t);
  const path = f.start();
  write(join(path, "tools/workbench/demo.txt"), "race-safe\n");
  f.review(path);
  const hook = join(f.origin, "hooks/post-receive");
  write(
    hook,
    '#!/bin/sh\nread old new ref\nif [ "$ref" = refs/heads/main ]; then\n  tree=$(git rev-parse "$new^{tree}")\n  next=$(echo "Concurrent post-push advance" | GIT_AUTHOR_NAME=Race GIT_AUTHOR_EMAIL=race@example.invalid GIT_COMMITTER_NAME=Race GIT_COMMITTER_EMAIL=race@example.invalid git commit-tree "$tree" -p "$new")\n  git update-ref refs/heads/main "$next" "$new"\nfi\n',
  );
  chmodSync(hook, 0o755);
  f.land(path);
  assert.equal(git(f.primary, "rev-parse", "HEAD"), f.remote());
  assert.equal(
    git(f.primary, "log", "-1", "--format=%s"),
    "Concurrent post-push advance",
  );
  assert.equal(existsSync(path), false);
});

test("hook reports current main and drift while preserving dirty task content", (t) => {
  const f = fixture(t);
  const path = f.start();
  const head = git(path, "rev-parse", "HEAD");
  write(join(path, "tools/workbench/demo.txt"), "preserve unfinished work\n");
  const upstream = f.advance();
  const context = mainContext(path);
  assert.ok(context.includes(upstream));
  assert.match(context, /missing main commits: 1/);
  assert.match(context, /Concurrent main change/);
  assert.equal(git(path, "rev-parse", "HEAD"), head);
  assert.notEqual(f.invoke(path, ["sync"], false).status, 0);
  assert.equal(
    readFileSync(join(path, "tools/workbench/demo.txt"), "utf8"),
    "preserve unfinished work\n",
  );
  git(path, "add", ".");
  git(path, "commit", "-m", "Checkpoint task work");
  const synced = json(f.invoke(path, ["sync"]).stdout);
  assert.equal(synced.base, upstream);
  assert.equal(
    run(path, "git", ["merge-base", "--is-ancestor", upstream, "HEAD"], false)
      .status,
    0,
  );
});

test("hook reports failed freshness without presenting cached main as current", (t) => {
  const f = fixture(t);
  git(f.primary, "remote", "set-url", "origin", join(f.root, "missing.git"));
  assert.match(mainContext(f.primary), /freshness could not be established/);
  assert.notEqual(f.invoke(f.primary, ["sync"], false).status, 0);
});

test("active coordinator lock prevents concurrent mutations", (t) => {
  const f = fixture(t);
  const path = f.start();
  write(
    join(f.primary, ".workbench/operation.lock"),
    JSON.stringify({
      pid: process.pid,
      host:
        process.env.HOSTNAME || run(f.primary, "hostname", []).stdout.trim(),
      nonce: "test",
    }),
  );
  assert.notEqual(f.invoke(path, ["sync"], false).status, 0);
  assert.ok(existsSync(join(f.primary, ".workbench/operation.lock")));
});
