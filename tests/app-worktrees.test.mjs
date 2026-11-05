// Each test process models its own harness environment.
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDECODE;
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { install, read as forgeState } from "./fake-gh.mjs";

// Worktrees Codex makes itself (the desktop app: .codex/worktrees/<random> on
// codex/<random>), driven through the CLI as a session would.
const CLI = path.resolve("scripts/workbench.mjs");
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const wb = (cwd, ...a) => execFileSync("node", [CLI, ...a], { cwd, encoding: "utf8" });
install();

// The PR source land reads in pr mode.
function writePr(dir, name, title = `feat: ${name}`, body = "What and why.\n") {
  fs.writeFileSync(path.join(dir, ".workbench", "tasks", name, "pr.md"), `# ${title}\n\n${body}`);
}

const checkOk = { name: "ok", command: ["true"] };

function prRepo() {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "wb-remote-"));
  git(remote, "init", "-q", "--bare", "-b", "main");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wb-app-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  fs.writeFileSync(path.join(dir, ".git", "workbench.json"), JSON.stringify({ mode: "pr", branchPrefix: "me/", hooks: { check: [checkOk] } }));
  return { dir, remote };
}

// What the desktop app does for a worktree session.
function appWorktree(dir, name) {
  const wt = path.join(dir, ".codex", "worktrees", name);
  git(dir, "worktree", "add", "-q", "-b", `codex/${name}`, wt, "origin/main");
  return wt;
}

const readTask = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, ".workbench", "tasks", name, "task.json"), "utf8"));

test("session start in an app worktree asks for adopt before the first push", () => {
  const { dir } = prRepo();
  const wt = appWorktree(dir, "gracious-edison-31da16");
  const out = wb(wt, "context");
  assert.match(out, /branch codex\/gracious-edison-31da16\) is not a Workbench task yet/);
  assert.match(out, /always before the first push, run adopt/);
  assert.match(out, /run adopt <name> \(the feature's name, the same in every repository\)/);
  assert.match(out, /becomes <type>\/<name> \(without a type, me\/<name>\)/);
});

test("an adopted app worktree goes through check, review and land on the policy's branch", () => {
  const { dir, remote } = prRepo();
  const wt = appWorktree(dir, "gracious-edison-31da16");
  const a = JSON.parse(wb(wt, "adopt", "tax-returns"));
  assert.equal(a.renamedFrom, "codex/gracious-edison-31da16");
  assert.equal(a.task.path, wt);
  fs.writeFileSync(path.join(wt, "t.txt"), "t\n");
  assert.equal(JSON.parse(wb(wt, "check")).receipt.passed, true);
  const review = path.join(dir, ".workbench", "tasks", "tax-returns", "review.md");
  fs.writeFileSync(review, fs.readFileSync(review, "utf8").replace("Result: pending", "Result: pass"));
  writePr(dir, "tax-returns");
  assert.equal(JSON.parse(wb(wt, "land", "--message", "feat: t")).state, "pushed");
  assert.ok(git(remote, "branch", "--list", "me/tax-returns"));
  assert.equal(git(remote, "branch", "--list", "codex/*"), "");
});

test("a task whose worktree Codex removed is flagged, and abandon or land --merged closes it", () => {
  const { dir, remote } = prRepo();
  const wt = appWorktree(dir, "bold-turing-1a2b3c");
  wb(wt, "adopt", "gone-one");
  fs.writeFileSync(path.join(wt, "g.txt"), "g\n");
  wb(wt, "check");
  const review = path.join(dir, ".workbench", "tasks", "gone-one", "review.md");
  fs.writeFileSync(review, fs.readFileSync(review, "utf8").replace("Result: pending", "Result: pass"));
  writePr(dir, "gone-one");
  wb(wt, "land", "--message", "feat: g");
  // The app archives the session and removes its worktree; nothing tells the workbench.
  git(dir, "worktree", "remove", wt);
  const st = JSON.parse(wb(dir, "status")).find((t) => t.name === "gone-one");
  assert.equal(st.worktreeGone, true);
  assert.match(wb(dir, "context"), /gone-one \[pushed, worktree gone\]/);
  // The forge merges the PR; land --merged closes the record without a worktree.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "wb-forge-"));
  git(other, "clone", "-q", remote, ".");
  git(other, "config", "user.email", "f@example.com");
  git(other, "config", "user.name", "f");
  git(other, "merge", "-q", "--no-ff", "-m", "merge", "origin/me/gone-one");
  git(other, "push", "-q", "origin", "main");
  const done = JSON.parse(wb(dir, "land", "gone-one", "--merged", git(other, "rev-parse", "HEAD")));
  assert.equal(done.state, "landed");
  assert.equal(JSON.parse(wb(dir, "status")).find((t) => t.name === "gone-one").worktreeGone, false);
});

test("abandon closes a task whose worktree is already gone", () => {
  const { dir } = prRepo();
  const wt = appWorktree(dir, "quiet-hopper-9f8e7d");
  wb(wt, "adopt", "dropped");
  git(dir, "worktree", "remove", wt);
  assert.equal(JSON.parse(wb(dir, "abandon", "dropped")).state, "abandoned");
  assert.equal(readTask(dir, "dropped").state, "abandoned");
});
