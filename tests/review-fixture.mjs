// Shared fixture for the reviewer runner tests: a worktree with one change, a task directory, and fake claude and
// codex executables that record their arguments and prompt.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const prompts = fileURLToPath(new URL("../reviewers/", import.meta.url));
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

export const failing = { verdict: "fail", summary: "s", findings: [{ id: "F1", severity: "blocking", escalate: false, title: "t", detail: "d", evidence: "a.txt:1" }] };
export const passed = { verdict: "pass", summary: "Checked.", findings: [] };
// A claude -p answer with a structured verdict.
export const ok = { type: "result", is_error: false, structured_output: failing };

// The worktree, the task directory and a fake claude answering with `answer` (claude -p's JSON).
export function setup(answer) {
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
  const fake = path.join(dir, "fake-claude.cjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(path.join(dir, "call.json"))}, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd() }));
process.stdout.write(${JSON.stringify(JSON.stringify(answer))});
`);
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(fake)} "$@"\n`);
  fs.chmodSync(bin, 0o755);
  const env = {
    ...process.env,
    WORKBENCH_CLAUDE: bin,
    WORKBENCH_CODEX: path.join(dir, "no-codex"),
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
  delete env.WORKBENCH_FALLBACK_MODEL;
  delete env.WORKBENCH_FALLBACK_EFFORT;
  delete env.WORKBENCH_REVIEW_PRIMARY;
  const record = path.join(dir, "call.json");
  const call = () => JSON.parse(fs.readFileSync(record, "utf8"));
  const called = () => fs.existsSync(record);
  const out = () => JSON.parse(fs.readFileSync(env.WORKBENCH_REVIEW_OUT, "utf8"));
  const runner = () => JSON.parse(fs.readFileSync(`${env.WORKBENCH_REVIEW_OUT}.runner.json`, "utf8"));
  const wrote = () => fs.existsSync(env.WORKBENCH_REVIEW_OUT) || fs.existsSync(`${env.WORKBENCH_REVIEW_OUT}.runner.json`);
  return { dir, wt, env, call, called, out, runner, wrote };
}

// A fake codex: it records its call, writes `answer` as its last message (unless answer is null), prints `stdout`
// and `stderr`, and exits with `status`.
export function fakeCodex(s, { answer = passed, status = 0, stdout = "", stderr = "" } = {}) {
  const binary = path.join(s.dir, "codex.cjs");
  const record = path.join(s.dir, "codex-call.json");
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({args, input, cwd: process.cwd(), schema: JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"))}));
const answer = ${JSON.stringify(answer === null ? null : JSON.stringify(answer))};
if (answer !== null) fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], answer);
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
process.exit(${status});
`);
  fs.chmodSync(binary, 0o755);
  s.env.WORKBENCH_CODEX = binary;
  return { called: () => fs.existsSync(record), call: () => JSON.parse(fs.readFileSync(record, "utf8")) };
}
