import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { failing, fakeCodex, ok, passed, prompts, setup } from "./review-fixture.mjs";

// review.mjs: Codex reviews first, Claude when Codex is unavailable.
const runner = fileURLToPath(new URL("../scripts/review.mjs", import.meta.url));
const legacy = fileURLToPath(new URL("../scripts/claude-review.mjs", import.meta.url));
const run = (s, ...args) => spawnSync("node", [runner, "--prompt", path.join(prompts, "task.md"), ...args], { cwd: s.wt, env: s.env, encoding: "utf8" });
const flag = (args, name) => args[args.indexOf(name) + 1];
const event = (e) => `${JSON.stringify(e)}\n`;
const usageLimit = { answer: null, status: 1, stdout: event({ type: "thread.started" }) + event({ type: "error", message: "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits" }) + event({ type: "turn.failed", error: { message: "You've hit your usage limit." } }) };

test("by default Codex reviews at gpt-6.1-sol xhigh with the blind prompt and schema, and Claude is not asked", () => {
  const s = setup(ok);
  const codex = fakeCodex(s, { answer: passed });
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  const c = codex.call();
  assert.equal(c.cwd, s.wt);
  assert.equal(flag(c.args, "--model"), "gpt-6.1-sol");
  assert.ok(c.args.includes('model_reasoning_effort="xhigh"'));
  for (const arg of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "features.hooks=false", "features.memories=false"]) assert.ok(c.args.includes(arg), arg);
  assert.ok(c.schema.properties.findings);
  assert.match(c.input, /change a/);
  assert.match(c.input, /\+brand new/);
  assert.doesNotMatch(c.input, /my private reasoning step|Tried an empty|SECRET-AUTHOR-NOTE/);
  assert.equal(s.called(), false);
  assert.deepEqual(s.out(), passed);
  assert.deepEqual(s.runner(), { backend: "codex", model: "gpt-6.1-sol", effort: "xhigh" });
  assert.match(r.stdout, /pass: 0 finding\(s\) via codex/);
});

test("--model and --effort set the Codex reviewer's model and effort", () => {
  const s = setup(ok);
  const codex = fakeCodex(s);
  assert.equal(run(s, "--model", "gpt-other", "--effort", "high").status, 0);
  assert.equal(flag(codex.call().args, "--model"), "gpt-other");
  assert.ok(codex.call().args.includes('model_reasoning_effort="high"'));
  assert.deepEqual(s.runner(), { backend: "codex", model: "gpt-other", effort: "high" });
  assert.notEqual(run(s, "--effort", "extreme").status, 0);
});

test("a Codex usage limit falls back to Claude with the same prompt, and the runner file records why", () => {
  const s = setup({ type: "result", is_error: false, structured_output: passed });
  const codex = fakeCodex(s, usageLimit);
  const r = run(s, "--fallback-model", "claude-sonnet-5-5", "--fallback-effort", "xhigh");
  assert.equal(r.status, 0, r.stderr);
  const { args, input } = s.call();
  assert.equal(input, codex.call().input);
  assert.deepEqual(JSON.parse(flag(args, "--json-schema")), codex.call().schema);
  assert.equal(flag(args, "--model"), "claude-sonnet-5-5");
  assert.equal(flag(args, "--effort"), "xhigh");
  for (const f of ["--restricted", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(args.includes(f), f);
  assert.deepEqual(s.out(), passed);
  assert.deepEqual(s.runner(), { backend: "claude", model: "claude-sonnet-5-5", effort: "xhigh", fallbackReason: "usage-limit" });
});

test("a failed Codex login, a Codex service failure and a missing codex fall back to Claude", () => {
  for (const [codex, reason] of [
    [{ answer: null, status: 1, stderr: "Your access token could not be refreshed. Please log out and sign in again." }, "authentication-unavailable"],
    [{ answer: null, status: 1, stdout: event({ type: "error", message: "exceeded retry limit, last status: 503 Service Unavailable" }) }, "service-unavailable"],
    [null, "executable-unavailable"],
  ]) {
    const s = setup(ok);
    if (codex) fakeCodex(s, codex);
    const r = run(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.called(), true);
    assert.deepEqual(s.runner(), { backend: "claude", model: null, effort: null, fallbackReason: reason });
    assert.equal(s.out().verdict, "fail"); // Claude's failing verdict stands
  }
});

test("a valid failing Codex verdict is the review: Claude is never asked", () => {
  const s = setup(ok);
  fakeCodex(s, { answer: failing });
  assert.equal(run(s).status, 0);
  assert.equal(s.called(), false);
  assert.deepEqual(s.out(), failing);
  assert.equal(s.runner().backend, "codex");
});

test("Codex failures that are not about availability fail closed without Claude or a stale result", () => {
  for (const codex of [
    { answer: null, status: 1, stdout: event({ type: "error", message: "model gpt-6.1-sol not found" }) },
    { answer: null, status: 0 },
    { answer: passed, status: 1 },
    { answer: { verdict: "pass" }, status: 0 },
    // a usage limit quoted in what the reviewer read is not Codex being limited
    { answer: null, status: 1, stdout: event({ type: "item.completed", item: { type: "agent_message", text: "You've hit your usage limit" } }) + event({ type: "turn.failed", error: { message: "internal error" } }) },
    { answer: null, status: 130, stderr: "You've hit your usage limit" },
  ]) {
    const s = setup(ok);
    fakeCodex(s, codex);
    fs.writeFileSync(s.env.WORKBENCH_REVIEW_OUT, JSON.stringify(passed));
    fs.writeFileSync(`${s.env.WORKBENCH_REVIEW_OUT}.runner.json`, "{}");
    assert.notEqual(run(s).status, 0, JSON.stringify(codex));
    assert.equal(s.called(), false, JSON.stringify(codex));
    assert.equal(s.wrote(), false, JSON.stringify(codex));
  }
});

test("--fallback-runner none, or Claude unavailable too, leaves the review failed", () => {
  const none = setup(ok);
  fakeCodex(none, usageLimit);
  const r = run(none, "--fallback-runner", "none");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage limit/);
  assert.equal(none.called(), false);
  assert.equal(none.wrote(), false);
  const both = setup({ type: "result", is_error: true, result: "You've hit your usage limit" });
  fakeCodex(both, usageLimit);
  const b = run(both);
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /codex is unavailable \(usage-limit\), and so is the claude fallback/);
  assert.equal(both.wrote(), false);
  assert.notEqual(run(both, "--fallback-runner", "codex").status, 0);
});

test("--runner claude puts Claude first, with Codex at gpt-6.1-sol xhigh as its fallback", () => {
  const s = setup({ type: "result", is_error: true, result: "You've hit your usage limit" });
  const codex = fakeCodex(s, { answer: passed });
  const r = run(s, "--runner", "claude", "--model", "claude-opus-5-5");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(flag(s.call().args, "--model"), "claude-opus-5-5");
  assert.equal(flag(codex.call().args, "--model"), "gpt-6.1-sol");
  assert.deepEqual(s.runner(), { backend: "codex", model: "gpt-6.1-sol", effort: "xhigh", fallbackReason: "usage-limit" });
});

test("claude-review.mjs keeps Claude first and asks Codex only when a fallback model is named", () => {
  const s = setup(ok);
  const codex = fakeCodex(s);
  const r = spawnSync("node", [legacy, "--prompt", path.join(prompts, "task.md")], { cwd: s.wt, env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(codex.called(), false);
  assert.deepEqual(s.runner(), { backend: "claude", model: null, effort: null });
  const limited = setup({ type: "result", is_error: true, result: "You've hit your usage limit" });
  const unused = fakeCodex(limited);
  assert.notEqual(spawnSync("node", [legacy, "--prompt", path.join(prompts, "task.md")], { cwd: limited.wt, env: limited.env, encoding: "utf8" }).status, 0);
  assert.equal(unused.called(), false);
});
