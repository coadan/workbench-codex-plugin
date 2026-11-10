import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeCodex, ok, passed, prompts, setup } from "./review-fixture.mjs";

// claude-review.mjs: the Claude-first contract, with Codex only as an opt-in fallback.
const runner = fileURLToPath(new URL("../scripts/claude-review.mjs", import.meta.url));

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

// The legacy opt-in: a fallback model and effort in the environment.
function fallback(s, answer = passed, status = 0) {
  const f = fakeCodex(s, { answer, status });
  s.env.WORKBENCH_FALLBACK_MODEL = "gpt-6.1-sol";
  s.env.WORKBENCH_FALLBACK_EFFORT = "xhigh";
  return f;
}
const run = (s, ...args) => spawnSync("node", [runner, "--prompt", path.join(prompts, "task.md"), ...args], { cwd: s.wt, env: s.env, encoding: "utf8" });

test("quota failure uses the opt-in exact model/effort with the same blind prompt and schema", () => {
  const s = setup({ type: "result", is_error: true, result: "You've hit your usage limit" });
  const f = fallback(s);
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  const c = f.call();
  assert.equal(c.input, s.call().input);
  assert.deepEqual(c.schema, JSON.parse(s.call().args[s.call().args.indexOf("--json-schema") + 1]));
  assert.equal(c.args[c.args.indexOf("--model") + 1], "gpt-6.1-sol");
  assert.ok(c.args.includes('model_reasoning_effort="xhigh"'));
  for (const arg of ["--ignore-user-config", "--ignore-rules", "--ephemeral", 'features.hooks=false', 'features.plugins=false', 'features.memories=false']) assert.ok(c.args.includes(arg), arg);
  assert.equal(c.args.includes("--add-dir"), false);
  assert.equal(c.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.doesNotMatch(c.input, /my private reasoning step|SECRET-AUTHOR-NOTE/);
  assert.deepEqual(s.out(), passed);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${s.env.WORKBENCH_REVIEW_OUT}.runner.json`, "utf8")), {backend: "codex", model: "gpt-6.1-sol", effort: "xhigh", fallbackReason: "usage-limit"});
});

test("missing Claude executable can fall back, while valid failing reviews never do", () => {
  const missing = setup(ok); const f = fallback(missing);
  missing.env.WORKBENCH_CLAUDE = path.join(missing.dir, "missing");
  assert.equal(run(missing).status, 0);
  assert.equal(f.called(), true);
  const failing = setup(ok); const unused = fallback(failing);
  assert.equal(run(failing).status, 0);
  assert.equal(unused.called(), false);
  assert.equal(failing.out().verdict, "fail");
  assert.equal(JSON.parse(fs.readFileSync(`${failing.env.WORKBENCH_REVIEW_OUT}.runner.json`, "utf8")).backend, "claude");
});

test("malformed structured output and arbitrary Claude errors fail closed without fallback", () => {
  for (const answer of [
    { is_error: false, structured_output: { verdict: "pass" } },
    { is_error: true, result: "unrelated internal exception" },
    { is_error: false, result: "rate limited" },
    { is_error: true, result: "usage limit", structured_output: { verdict: "pass" } },
  ]) {
    const s = setup(answer); const f = fallback(s);
    assert.notEqual(run(s).status, 0);
    assert.equal(f.called(), false);
    assert.equal(fs.existsSync(s.env.WORKBENCH_REVIEW_OUT), false);
  }
});

test("malformed JSON and interrupted Claude do not trigger fallback or leave stale results", () => {
  for (const body of ['process.stdout.write("not JSON");', 'process.kill(process.pid, "SIGTERM");']) {
    const s = setup(ok); const f = fallback(s);
    fs.writeFileSync(path.join(s.dir, "fake-claude.cjs"), body);
    fs.writeFileSync(s.env.WORKBENCH_REVIEW_OUT, JSON.stringify(passed));
    fs.writeFileSync(`${s.env.WORKBENCH_REVIEW_OUT}.runner.json`, "{}");
    assert.notEqual(run(s).status, 0);
    assert.equal(f.called(), false);
    assert.equal(fs.existsSync(s.env.WORKBENCH_REVIEW_OUT), false);
    assert.equal(fs.existsSync(`${s.env.WORKBENCH_REVIEW_OUT}.runner.json`), false);
  }
});

test("recognized auth/service unavailability falls back, and unavailable fallback remains a failure", () => {
  for (const message of ["Not logged in. Please log in.", "API Error: 503 service unavailable"]) {
    const s = setup({ is_error: true, result: message }); const f = fallback(s);
    assert.equal(run(s).status, 0);
    assert.equal(f.called(), true);
  }
  for (const [answer, status] of [[passed, 1], [{ verdict: "pass" }, 0]]) {
    const s = setup({ is_error: true, result: "rate limited" }); fallback(s, answer, status);
    assert.notEqual(run(s).status, 0);
    assert.equal(fs.existsSync(s.env.WORKBENCH_REVIEW_OUT), false);
  }
});

// Shell and CLI wrappers can encode interruption as an exit code rather than r.signal.
test("signal-style exit statuses never recover through a passing fallback", () => {
  for (const status of [130, 143]) {
    const s = setup({ is_error: true, result: "rate limited" }); const f = fallback(s);
    fs.appendFileSync(path.join(s.dir, "fake-claude.cjs"), `\nprocess.exit(${status});\n`);
    assert.notEqual(run(s).status, 0);
    assert.equal(f.called(), false);
    assert.equal(fs.existsSync(s.env.WORKBENCH_REVIEW_OUT), false);
  }
});

test("a valid failing fallback remains a failing review with Codex provenance", () => {
  const s = setup({ is_error: true, result: "rate limited" });
  fallback(s, ok.structured_output);
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.out().verdict, "fail");
  assert.equal(JSON.parse(fs.readFileSync(`${s.env.WORKBENCH_REVIEW_OUT}.runner.json`, "utf8")).backend, "codex");
});

// 0.5.1 shipped --primary codex (and WORKBENCH_REVIEW_PRIMARY=codex), a Codex-only review. review.mjs replaces it;
// the flag parser ignores unknown flags, so without the refusal an old command would quietly review on Claude.
test("the 0.5.1 --primary codex is refused with its replacement, before any runner starts", () => {
  for (const [args, primary] of [[["--primary", "codex", "--fallback-model", "gpt-6.1-sol"], undefined], [[], "codex"]]) {
    const s = setup(ok); const f = fallback(s);
    if (primary) s.env.WORKBENCH_REVIEW_PRIMARY = primary;
    const r = run(s, ...args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /replaced by scripts\/review\.mjs/);
    assert.match(r.stderr, /--fallback-runner none/);
    assert.equal(s.called(), false);
    assert.equal(f.called(), false);
    assert.equal(s.wrote(), false);
  }
});

test("--primary claude keeps the Claude-first review, and the flag never reaches claude", () => {
  const s = setup(ok);
  const r = run(s, "--primary", "claude", "--model", "m1");
  assert.equal(r.status, 0, r.stderr);
  const { args } = s.call();
  assert.equal(args.includes("--primary"), false);
  assert.equal(args[args.indexOf("--model") + 1], "m1");
  assert.equal(s.runner().backend, "claude");
});

test("a --primary with no value fails as any unpaired flag does", () => {
  const s = setup(ok);
  assert.match(run(s, "--primary").stderr, /expected --flag value pairs/);
  assert.equal(s.called(), false);
});
