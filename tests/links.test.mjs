// Each test process models its own harness environment.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDECODE;
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../scripts/workbench.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-c", "protocol.file.allow=always", ...a], { cwd, encoding: "utf8" }).trim();
const checkOk = { name: "ok", command: ["node", "-e", "process.exit(0)"] };

// A repository with a committed .gitignore and the given policy.
function repo(config, ignore = "notes\n.cache\n") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wb-links-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ignore);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  fs.writeFileSync(path.join(dir, ".git", "workbench.json"), JSON.stringify(config));
  return dir;
}

function passReview(dir, name) {
  const f = path.join(dir, ".workbench", "tasks", name, "review.md");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("Result: pending", "Result: pass"));
}

test("start links declared paths into the primary checkout and abandon keeps their targets", () => {
  const dir = repo({ mode: "local", links: ["notes", ".cache/jank/"], hooks: { check: [checkOk] } });
  fs.mkdirSync(path.join(dir, "notes"));
  fs.writeFileSync(path.join(dir, "notes", "001.md"), "first\n");
  const s = run(["start", "t1"], dir);
  const wt = s.task.path;
  assert.equal(s.task.state, "active");
  assert.deepEqual(s.links.map((l) => [l.path, l.ok]), [["notes", true], [".cache/jank", true]]);
  assert.equal(s.links[1].created, true, "a missing source becomes a directory in the primary checkout");
  assert.ok(fs.lstatSync(path.join(wt, "notes")).isSymbolicLink());
  assert.ok(!path.isAbsolute(fs.readlinkSync(path.join(wt, "notes"))), "links are relative");
  assert.equal(fs.readFileSync(path.join(wt, "notes", "001.md"), "utf8"), "first\n");
  fs.writeFileSync(path.join(wt, "notes", "002.md"), "from the task\n");
  assert.equal(fs.readFileSync(path.join(dir, "notes", "002.md"), "utf8"), "from the task\n", "writes land in the shared directory");
  assert.ok(fs.statSync(path.join(dir, ".cache", "jank")).isDirectory());
  assert.equal(git(wt, "status", "--porcelain"), "", "links do not show as changes");
  run(["abandon", "t1"], dir);
  assert.ok(!fs.existsSync(wt));
  assert.deepEqual(fs.readdirSync(path.join(dir, "notes")).sort(), ["001.md", "002.md"], "removing the worktree keeps the shared files");
});

test("a link git does not ignore fails setup and is not left behind", () => {
  const dir = repo({ mode: "local", links: ["shared"], hooks: { check: [checkOk] } }, "shared/\n");
  const s = run(["start", "t2"], dir);
  assert.equal(s.task.state, "prepare-failed");
  assert.equal(s.links[0].ok, false);
  assert.match(s.links[0].note, /"shared\/" pattern does not match a symlink/);
  assert.ok(!fs.existsSync(path.join(s.task.path, "shared")));
  assert.deepEqual(s.prepare, [], "prepare hooks do not run after a failed link");
});

test("a path that already exists in the worktree is not replaced", () => {
  const dir = repo({ mode: "local", links: ["a.txt"], hooks: { check: [checkOk] } });
  const s = run(["start", "t3"], dir);
  assert.equal(s.task.state, "prepare-failed");
  assert.match(s.links[0].note, /exists in the worktree; not replaced/);
  assert.equal(fs.readFileSync(path.join(s.task.path, "a.txt"), "utf8"), "a\n");
});

test("adopt links a worktree Codex made, before the prepare hooks run", () => {
  const prepare = [{ name: "sees-link", command: ["node", "-e", "require('fs').statSync('notes')"] }];
  const dir = repo({ mode: "local", links: ["notes"], hooks: { prepare, check: [checkOk] } });
  const wt = path.join(dir, ".codex", "worktrees", "calm-hopper-9f8e7d");
  git(dir, "worktree", "add", "-q", "-b", "codex/calm-hopper-9f8e7d", wt);
  const a = run(["adopt", "shared-notes"], wt);
  assert.equal(a.task.state, "active");
  assert.equal(a.links[0].ok, true);
  assert.equal(a.prepare[0].ok, true, "the prepare hook saw the link");
  assert.ok(fs.lstatSync(path.join(wt, "notes")).isSymbolicLink());
});

test("links must stay inside the repository and off the workbench's own paths", () => {
  for (const bad of ["../elsewhere", "/abs", ".git/hooks", ".workbench", ".codex/worktrees/x", "."]) {
    const dir = repo({ mode: "local", links: [bad], hooks: { check: [checkOk] } });
    assert.throws(() => run(["inspect"], dir), /link .* (must stay inside the repository|names a path the workbench owns)/, bad);
  }
  const dir = repo({ mode: "local", links: "notes", hooks: { check: [checkOk] } });
  assert.throws(() => run(["inspect"], dir), /links must be an array/);
});

// git refuses to remove a worktree that contains submodules unless forced.
function submoduleRepo() {
  const sub = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wb-sub-")));
  git(sub, "init", "-q", "-b", "main");
  git(sub, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "sub");
  const prepare = [{ name: "submodules", command: ["git", "-c", "protocol.file.allow=always", "submodule", "update", "--init"] }];
  const dir = repo({ mode: "local", hooks: { prepare, check: [checkOk] } });
  git(dir, "submodule", "add", "-q", sub, "vendor/sub");
  git(dir, "commit", "-qm", "add submodule");
  return dir;
}

test("abandon removes a clean worktree that contains a submodule, and refuses a dirty one", () => {
  const dir = submoduleRepo();
  const s = run(["start", "s1"], dir);
  assert.equal(s.prepare[0].ok, true);
  assert.ok(fs.existsSync(path.join(s.task.path, "vendor", "sub", ".git")));
  fs.writeFileSync(path.join(s.task.path, "wip.txt"), "wip\n");
  assert.throws(() => run(["abandon", "s1"], dir), /uncommitted changes/);
  fs.rmSync(path.join(s.task.path, "wip.txt"));
  assert.equal(run(["abandon", "s1"], dir).state, "abandoned");
  assert.ok(!fs.existsSync(s.task.path));
});

test("land removes a worktree that contains a submodule", () => {
  const dir = submoduleRepo();
  const s = run(["start", "s2"], dir);
  fs.writeFileSync(path.join(s.task.path, "b.txt"), "b\n");
  run(["check", "s2"], dir);
  passReview(dir, "s2");
  const l = run(["land", "s2", "--message", "feat: b"], dir);
  assert.equal(l.state, "landed");
  assert.ok(!fs.existsSync(s.task.path));
  assert.equal(git(dir, "show", "main:b.txt"), "b");
});
