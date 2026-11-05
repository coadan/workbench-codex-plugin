import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/claude-review.mjs", import.meta.url));
const prompts = fileURLToPath(new URL("../reviewers/", import.meta.url));
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

// A worktree with one change, a task directory with plan.md and qa.md, and a fake claude that records its
// arguments and prompt and answers with `answer`.
function setup(answer) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wb-cr-")));
  const wt = path.join(dir, "wt");
  fs.mkdirSync(wt);
  git(wt, "init", "-q", "-b", "main");
  git(wt, "config", "user.email", "t@example.com");
  git(wt, "config", "user.name", "t");
  fs.writeFileSync(path.join(wt, "a.txt"), "a\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "init");
  const base = git(wt, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(wt, "a.txt"), "a changed\n");
  fs.writeFileSync(path.join(wt, "new.txt"), "brand new\n");
  git(wt, "add", "-A");
  const tree = git(wt, "write-tree");
  git(wt, "reset", "-q");
  const task = path.join(dir, "task");
  fs.mkdirSync(task);
  fs.writeFileSync(path.join(task, "plan.md"), "---\ntype: feat\nobjective: change a\nscope:\n  - .\n---\n# t\n\n## Steps\n\n- my private reasoning step\n\n## Acceptance\n\n- [ ] a.txt says changed\n");
  fs.writeFileSync(path.join(task, "qa.md"), "Tried an empty a.txt: the check failed as it should.\n");
  fs.writeFileSync(path.join(task, "review.md"), "# Review\n\nAuthor's own reasoning: SECRET-AUTHOR-NOTE\n");
  fs.writeFileSync(path.join(task, "changed"), "a.txt\nnew.txt\n");
  fs.writeFileSync(path.join(task, "receipt.json"), JSON.stringify({ passed: true, checks: [{ name: "test", ok: true }] }));
  const fake = path.join(dir, "fake-claude.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(path.join(dir, "call.json"))}, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd() }));
process.stdout.write(${JSON.stringify(JSON.stringify(answer))});
`);
  fs.renameSync(fake, fake.replace(/\.mjs$/, ".cjs"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(fake.replace(/\.mjs$/, ".cjs"))} "$@"\n`);
  fs.chmodSync(bin, 0o755);
  const env = {
    ...process.env,
    WORKBENCH_CLAUDE: bin,
    WORKBENCH_TASK: "t",
    WORKBENCH_TASK_DIR: task,
    WORKBENCH_WORKTREE: wt,
    WORKBENCH_BASE: base,
    WORKBENCH_TREE: tree,
    WORKBENCH_PLAN: path.join(task, "plan.md"),
    WORKBENCH_QA: path.join(task, "qa.md"),
    WORKBENCH_RECEIPT: path.join(task, "receipt.json"),
    WORKBENCH_CHANGED: path.join(task, "changed"),
    WORKBENCH_REVIEW_OUT: path.join(task, "out.json"),
    WORKBENCH_REVIEWER: "task",
  };
  const call = () => JSON.parse(fs.readFileSync(path.join(dir, "call.json"), "utf8"));
  const out = () => JSON.parse(fs.readFileSync(env.WORKBENCH_REVIEW_OUT, "utf8"));
  return { wt, env, call, out };
}

const ok = { type: "result", is_error: false, structured_output: { verdict: "fail", summary: "s", findings: [{ id: "F1", severity: "blocking", escalate: false, title: "t", detail: "d" }] } };

test("the blind task reviewer sees the objective, acceptance and diff, never the steps, QA notes or review", () => {
  const s = setup(ok);
  const r = spawnSync("node", [runner, "--prompt", path.join(prompts, "task.md"), "--model", "m1", "--effort", "xhigh"], { cwd: s.wt, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const { args, input, cwd } = s.call();
  assert.equal(cwd, s.wt);
  for (const flag of ["-p", "--restricted", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--model") + 1], "m1");
  assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.ok(JSON.parse(args[args.indexOf("--json-schema") + 1]).properties.findings);
  assert.match(input, /change a/);
  assert.match(input, /a\.txt says changed/);
  assert.match(input, /\+a changed/);
  assert.match(input, /\+brand new/); // a file git does not track yet is in the diff
  assert.doesNotMatch(input, /my private reasoning step/);
  assert.doesNotMatch(input, /Tried an empty/);
  assert.doesNotMatch(input, /SECRET-AUTHOR-NOTE/);
  assert.deepEqual(s.out(), ok.structured_output);
});

test("the QA reviewer also sees the QA notes and the checks that ran", () => {
  const s = setup(ok);
  const r = spawnSync("node", [runner, "--prompt", path.join(prompts, "qa.md"), "--with", "acceptance,changed,qa,receipt"], { cwd: s.wt, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const { input } = s.call();
  assert.match(input, /Tried an empty a\.txt/);
  assert.match(input, /"name":\s*"test"/);
  assert.match(input, /new\.txt/);
  assert.doesNotMatch(input, /\+brand new/); // no diff asked for
  assert.doesNotMatch(input, /SECRET-AUTHOR-NOTE/);
});

test("a prompt path is read relative to WORKBENCH_ROOT, and claude's error fails the runner without a result", () => {
  const s = setup({ type: "result", is_error: true, result: "rate limited" });
  fs.mkdirSync(path.join(s.env.WORKBENCH_TASK_DIR, "prompts"));
  fs.writeFileSync(path.join(s.env.WORKBENCH_TASK_DIR, "prompts", "mine.md"), "Review for MY-RULE.\n");
  const r = spawnSync("node", [runner, "--prompt", "prompts/mine.md"], { cwd: s.wt, env: { ...s.env, WORKBENCH_ROOT: s.env.WORKBENCH_TASK_DIR }, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /rate limited/);
  assert.match(s.call().input, /MY-RULE/);
  assert.equal(fs.existsSync(s.env.WORKBENCH_REVIEW_OUT), false);
});

test("--add-dir lets the reviewer read named directories, and --include adds files to its prompt", () => {
  const s = setup(ok);
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cr-dir-"));
  const ctxFile = path.join(extra, "branches.txt");
  fs.writeFileSync(ctxFile, "sibling repo: branch feat/x has 3 changed files\n");
  const run = (...args) => spawnSync("node", [runner, "--prompt", path.join(prompts, "task.md"), ...args], { cwd: s.wt, env: s.env, encoding: "utf8" });
  const r = run("--add-dir", `${extra},${s.env.WORKBENCH_TASK_DIR}`, "--include", ctxFile);
  assert.equal(r.status, 0, r.stderr);
  const { args, input } = s.call();
  const dirs = args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : []));
  assert.deepEqual(dirs, [extra, s.env.WORKBENCH_TASK_DIR]);
  assert.match(input, /branches\.txt[\s\S]*feat\/x has 3 changed files/);
  assert.match(run("--add-dir", path.join(extra, "nope")).stderr, /--add-dir .*nope.* is not a directory/);
  assert.match(run("--include", path.join(extra, "nope.txt")).stderr, /--include .*nope\.txt.* is not a file/);
});
