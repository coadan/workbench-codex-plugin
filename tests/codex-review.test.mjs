import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewConfig } from "../scripts/codex-review.mjs";

test("the Codex profile reads sources and committed rules, and denies task evidence and personal context", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wb-isolation-")));
  const tree = path.join(root, "tree"); const task = path.join(root, "task");
  fs.mkdirSync(tree); fs.mkdirSync(task);
  try {
    const config = reviewConfig(tree, [], task);
    const fsConfig = config.find((v) => v.startsWith("permissions.workbench-review.filesystem="));
    assert.ok(fsConfig.includes(`${JSON.stringify(tree)}="read"`));
    assert.ok(fsConfig.includes(`${JSON.stringify(task)}="deny"`));
    for (const name of [".claude", ".codex", ".agents"]) assert.ok(fsConfig.includes(`${JSON.stringify(path.join(os.homedir(), name))}="deny"`));
    for (const name of [".workbench", ".git", "CLAUDE.local.md", "AGENTS.override.md"]) assert.ok(fsConfig.includes(`${JSON.stringify(path.join(tree, name))}="deny"`), name);
    // the repository's committed rules are source the reviewer may read, as the Claude reviewer can
    for (const name of ["AGENTS.md", "CLAUDE.md"]) assert.ok(!fsConfig.includes(JSON.stringify(path.join(tree, name))), name);
    assert.doesNotMatch(fsConfig, /="write"/);
    assert.ok(config.includes('permissions.workbench-review.network.enabled=false'));
    assert.ok(config.includes('allow_login_shell=false'));
    assert.ok(config.includes('approval_policy="never"'));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test("installed Codex renders the confined review profile without task instructions, skills or context hooks", { skip: process.env.WORKBENCH_REAL_CODEX_TEST !== "1" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wb-codex-probe-")));
  const tree = path.join(root, "tree"); const task = path.join(root, "task");
  fs.mkdirSync(tree); fs.mkdirSync(task);
  fs.writeFileSync(path.join(tree, "AGENTS.md"), "AUTHOR_CONTEXT_SHOULD_NOT_APPEAR");
  try {
    const args = ["debug", "prompt-input"];
    for (const config of reviewConfig(tree, [], task)) args.push("-c", config);
    args.push("ISOLATED_REVIEW_PROBE");
    const r = spawnSync("codex", args, {cwd: tree, encoding: "utf8", maxBuffer: 8 * 1024 * 1024});
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /unknown|unrecognized|under-development/i);
    const messages = JSON.parse(r.stdout);
    assert.doesNotMatch(r.stdout, /AUTHOR_CONTEXT_SHOULD_NOT_APPEAR|<skills_instructions>/);
    assert.ok(!messages.some((m) => m.internal_chat_message_metadata_passthrough?.content_item_metadata?.some((v) => v.provenance?.hook === true)));
    const text = JSON.stringify(messages);
    assert.ok(text.includes('permission_profile'));
    assert.ok(text.includes(task));
    assert.match(text, /access=\\"deny\\"/);
    assert.doesNotMatch(text, /access=\\"write\\"/);
    // Global generic AGENTS guidance can still be present. The shared review prompt overrides its
    // bootstrap steps, and the effective filesystem prevents reading private context or task files.
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
