#!/usr/bin/env node
// Workbench for Codex: scoped tasks on Codex worktrees
// (<repo>/.codex/worktrees/<name>), a plan, registered checks, a review bound
// to the exact tree, and delivery by policy (local merge, direct push, or a
// pushed branch for a pull request). One task name is one branch in every repo.
//
// Usage: node workbench.mjs <command> [args]   (--repo <path> repeats a command in a sibling repo)
//   inspect                         show the resolved configuration
//   sync                            fetch the base (non-local modes) and report drift;
//                                   in a task with an open PR, sync a changed pr.md to it
//   status                          list tasks and their state
//   start <name> [--base <ref>]   a new worktree and task <name>; its data goes in plan.md's front matter
//   adopt [name]   make the current worktree task <name>
//   check [name]                    run registered checks, write the receipt
//   review [name] [--fresh true]    run the hooks.review reviewers that match the change on the checked tree;
//                                   their findings go into review.md (answer each one before land)
//   answer [name] --id <reviewer/id> --kind done|not-needed|human --text <text>
//                                   record the answer to a reviewer's finding in review.md
//   put plan|pr|qa|review [name]    write that task file from stdin
//   land [name] --message <text> [--draft true]
//                                   commit, verify receipt + review, deliver by mode; the message may
//                                   carry a body and trailers (one argument, newlines included)
//                                   (pr: push, then open or update the PR from the task's pr.md; inside
//                                   Claude Code, print the gh pr create command instead of opening it)
//   land [name] --merged <sha>      after a PR merged: confirm, clean up and run hooks.merged; on a landed
//                                   task, run hooks.merged again (after one failed)
//   abandon <name>                  remove a task's clean worktree, keep its evidence
//   context [--hook <event>]        short context for hooks (silent when unconfigured); --hook prints it
//                                   as the event's hookSpecificOutput.additionalContext JSON
//
// Configuration: .workbench.json at the repository root (shared), or
// .git/workbench.json (this clone only; never committed). The repository file wins.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

class WorkbenchError extends Error {}
const fail = (msg) => {
  throw new WorkbenchError(msg);
};

// ---------------------------------------------------------------- git helpers

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

// The primary checkout: the worktree that owns the common .git directory.
function primaryRoot(cwd) {
  const common = tryGit(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common.ok) return null;
  return path.dirname(common.out);
}

// A content hash of the working tree including uncommitted and untracked
// files, computed in a scratch index so the real index is untouched. The
// scratch index starts as a copy of the real one, whose stat data lets
// add -A rehash only the files that changed; from HEAD it rehashes them all.
function treeOf(cwd) {
  const idx = path.join(os.tmpdir(), `wb-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const hash = (seed) => {
    fs.rmSync(idx, { force: true });
    seed();
    execFileSync("git", ["add", "-A"], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    return execFileSync("git", ["write-tree"], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  };
  const fromHead = () => {
    if (tryGit(cwd, "rev-parse", "--verify", "HEAD").ok) execFileSync("git", ["read-tree", "HEAD"], { cwd, env });
  };
  try {
    const index = tryGit(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index").out;
    if (!index || !fs.existsSync(index)) return hash(fromHead);
    try {
      // The copy keeps the index's mtime: git rechecks the content of an entry no older than its index (racily
      // clean), and a fresh mtime would make a file rewritten in the same second at the same size look unchanged.
      return hash(() => {
        fs.copyFileSync(index, idx);
        const st = fs.statSync(index);
        fs.utimesSync(idx, st.atime, st.mtime);
      });
    } catch {
      return hash(fromHead); // an index the copy cannot stand in for (a split index, say)
    }
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

// ---------------------------------------------------------------- configuration

function loadConfig(root) {
  const candidates = [path.join(root, ".workbench.json"), path.join(root, ".git", "workbench.json"), path.join(root, "package.json")];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const raw = path.basename(file) === "package.json" ? parsed.workbench : parsed;
      if (!raw) continue;
      if (!["local", "direct", "pr"].includes(raw.mode)) fail(`${file}: mode must be local, direct or pr`);
      return {
        file,
        mode: raw.mode,
        branch: raw.branch || "main",
        remote: raw.remote || "origin",
        branchPrefix: raw.branchPrefix ?? "codex/",
        integrate: raw.integrate || "merge", // merge | rebase: how a moved base is brought in
        prepare: raw.hooks?.prepare || [],
        check: raw.hooks?.check || [],
        merged: raw.hooks?.merged || [], // run once the task's change is on the base branch
        review: reviewersOf(file, raw.hooks?.review || []),
        links: linksOf(file, raw.links),
      };
    }
  }
  return null;
}

// The task files a reviewer may read besides the tree; its result goes stale when one of its inputs changes.
const REVIEW_INPUTS = { plan: "plan.md", qa: "qa.md", pr: "pr.md" };
const DEFAULT_INPUTS = ["plan", "qa"];

// hooks.review: { name, when?: [globs], inputs?: [plan, qa, pr], command: [args] }; a reviewer runs when a changed file
// matches a glob.
function reviewersOf(file, list) {
  for (const r of list) {
    if (!NAME.test(r.name || "")) fail(`${file}: hooks.review name ${JSON.stringify(r.name)}: lowercase letters, digits and dashes`);
    if (!Array.isArray(r.command) || r.command.length === 0) fail(`${file}: hooks.review ${r.name}: command must be a non-empty array`);
    if (r.when !== undefined && (!Array.isArray(r.when) || r.when.length === 0)) fail(`${file}: hooks.review ${r.name}: when must be a non-empty array of globs`);
    if (r.inputs !== undefined && (!Array.isArray(r.inputs) || r.inputs.some((i) => !REVIEW_INPUTS[i]))) fail(`${file}: hooks.review ${r.name}: inputs is a list of ${Object.keys(REVIEW_INPUTS).join(", ")}`);
  }
  if (new Set(list.map((r) => r.name)).size !== list.length) fail(`${file}: hooks.review names must be unique`);
  return list;
}

// links: git-ignored paths, relative to the repository root, that every task worktree gets as a
// symlink into the primary checkout, so notes and caches are shared rather than copied per task.
function linksOf(file, raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`${file}: links must be an array of relative paths`);
  return raw.map((p) => {
    if (typeof p !== "string" || !p.trim()) fail(`${file}: links entries must be non-empty strings`);
    const n = path.posix.normalize(p.trim().replace(/\\/g, "/")).replace(/\/+$/, "");
    if (path.posix.isAbsolute(n) || n === "." || n === ".." || n.startsWith("../")) fail(`${file}: link ${JSON.stringify(p)} must stay inside the repository`);
    if (n === ".git" || n.startsWith(".git/") || n === ".workbench" || n.startsWith(".workbench/") || (n.startsWith(".claude/worktrees") || n.startsWith(".codex/worktrees"))) fail(`${file}: link ${JSON.stringify(p)} names a path the workbench owns`);
    return n;
  });
}

function ctxAt(root, cfg) {
  const home = path.join(root, ".workbench");
  return { root, cfg, home, tasks: path.join(home, "tasks") };
}

function ctxFor(cwd) {
  const root = primaryRoot(cwd);
  if (!root) fail("not inside a git repository");
  const cfg = loadConfig(root);
  if (!cfg) fail("no .workbench.json or .git/workbench.json; run inspect for the contract");
  return ctxAt(root, cfg);
}

// Where Claude Code puts a session's worktree; the app trusts paths under it.
function worktreePath(ctx, name) {
  return path.join(ctx.root, ".codex", "worktrees", name);
}

function excludeWorkbench(ctx) {
  const file = path.join(ctx.root, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const entry of [".workbench/", ".codex/worktrees/"]) {
    if (text.split("\n").includes(entry)) continue;
    const add = (text.endsWith("\n") || !text ? "" : "\n") + entry + "\n";
    fs.appendFileSync(file, add);
    text += add;
  }
}

// ---------------------------------------------------------------- lock

// A lock is stale when the process it names has exited, however long a live holder takes. One with no pid
// (its holder died between creating and writing it) is stale after ten minutes.
function lockIsStale(file) {
  let pid, mtime;
  try {
    pid = Number(fs.readFileSync(file, "utf8"));
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return false; // already gone: opening it decides
  }
  if (!(pid > 0)) return Date.now() - mtime > 10 * 60 * 1000;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH"; // EPERM: alive, under another user
  }
}

function withLock(ctx, fn) {
  fs.mkdirSync(ctx.home, { recursive: true });
  const file = path.join(ctx.home, "operation.lock");
  if (lockIsStale(file)) fs.rmSync(file, { force: true });
  let fd;
  try {
    fd = fs.openSync(file, "wx");
  } catch {
    fail(`another workbench operation holds ${file}; retry, or remove it if stale`);
  }
  try {
    fs.writeSync(fd, String(process.pid));
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
  }
}

// ---------------------------------------------------------------- tasks

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function taskDir(ctx, name) {
  return path.join(ctx.tasks, name);
}

function readTask(ctx, name) {
  const file = path.join(taskDir(ctx, name), "task.json");
  if (!fs.existsSync(file)) fail(`no task ${name}`);
  const task = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!task.state && task.phase && task.startBase) {
    return { ...task, scope: task.scopes || ["."], base: task.mode === "local" ? ctx.cfg.branch : `${ctx.cfg.remote}/${ctx.cfg.branch}`,
      baseSha: task.startBase, state: task.phase === "closed" ? "landed" : task.phase, created: task.createdAt };
  }
  return task;
}

function writeTask(ctx, task) {
  fs.writeFileSync(path.join(taskDir(ctx, task.name), "task.json"), JSON.stringify(task, null, 2) + "\n");
}

function taskNames(ctx) {
  if (!fs.existsSync(ctx.tasks)) return [];
  return fs.readdirSync(ctx.tasks).filter((n) => fs.existsSync(path.join(ctx.tasks, n, "task.json")));
}

const real = (p) => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));

// The task whose worktree contains cwd: a Codex worktree or a legacy
// .workbench/tasks/<name>/repo one.
function taskAt(ctx, cwd) {
  const top = tryGit(cwd, "rev-parse", "--show-toplevel");
  if (!top.ok) return null;
  const here = real(top.out);
  for (const n of taskNames(ctx)) {
    const t = readTask(ctx, n);
    if (t.path && real(t.path) === here) return t; // a record with no worktree path matches nothing
  }
  return null;
}

// Resolve the task from an explicit name or the current directory.
function resolveTask(ctx, name, cwd) {
  if (name) return readTask(ctx, name);
  const t = taskAt(ctx, cwd);
  if (t) return t;
  fail("name a task, or run inside its worktree (adopt makes the current worktree a task)");
}

function baseRef(ctx) {
  return ctx.cfg.mode === "local" ? ctx.cfg.branch : `${ctx.cfg.remote}/${ctx.cfg.branch}`;
}

function fetchBase(ctx) {
  if (ctx.cfg.mode === "local") return;
  const r = tryGit(ctx.root, "fetch", "--quiet", ctx.cfg.remote, ctx.cfg.branch);
  if (!r.ok) fail(`fetch ${ctx.cfg.remote} ${ctx.cfg.branch} failed: ${r.err}`);
}

function runHooks(hooks, cwd, logFile, env) {
  const results = [];
  for (const h of hooks) {
    if (!Array.isArray(h.command) || h.command.length === 0) fail(`hook ${h.name}: command must be a non-empty array`);
    const t0 = Date.now();
    const r = spawnSync(h.command[0], h.command.slice(1), { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: env && { ...process.env, ...env } });
    const out = `$ ${h.command.join(" ")}\n${r.stdout || ""}${r.stderr || ""}${r.error ? String(r.error) + "\n" : ""}`;
    if (logFile) fs.appendFileSync(logFile, `\n===== ${h.name} (exit ${r.status}) =====\n${out}`);
    results.push({ name: h.name, ok: r.status === 0, exit: r.status, ms: Date.now() - t0 });
  }
  return results;
}

// plan.md opens with front matter, the task's data: its Conventional Commits type, its objective and its
// scope. sync and land apply it; nothing else writes it once the task exists.
function frontMatterOf(task) {
  return `---
type: ${task.type || ""}
objective: ${task.objective}
scope:
${task.scope.map((s) => `  - ${s}`).join("\n")}
---
`;
}

function planTemplate(task) {
  return `${frontMatterOf(task)}# ${task.name}

## Steps

- [ ]

## Acceptance

- [ ]
`;
}

const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

// The front matter's keys: "key: value", "key: [a, b]", or "key:" followed by "  - item" lines.
function readFrontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const data = {};
  let list = null;
  for (const line of m[1].split("\n")) {
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && list) {
      if (!Array.isArray(data[list])) data[list] = [];
      data[list].push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([a-z]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    list = v === "" ? k : null;
    data[k] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(",").map(unquote).filter(Boolean) : unquote(v);
  }
  return data;
}

// The task as its plan.md states it: type, objective and scope from the front matter, the rest from task.json.
// A plan without front matter (an earlier version's) leaves task.json as it is.
function withPlan(ctx, task) {
  const f = path.join(taskDir(ctx, task.name), "plan.md");
  const data = fs.existsSync(f) ? readFrontMatter(fs.readFileSync(f, "utf8")) : null;
  if (!data) return task;
  const type = data.type || undefined;
  if (type !== undefined && !TYPES.includes(type)) fail(`type in plan.md: one of ${TYPES.join(", ")}`);
  const scope = Array.isArray(data.scope) ? data.scope : data.scope ? [data.scope] : task.scope;
  return { ...task, type, objective: data.objective || task.objective, scope: scope.length ? scope : ["."] };
}

// A branch is pushed once land pushed it, it is on the remote, or it has an upstream of its own (one cut from the
// base tracks the base).
function isPushed(ctx, task, wt) {
  if (task.pushed) return true;
  const current = tryGit(wt, "branch", "--show-current").out;
  if (current && tryGit(wt, "rev-parse", "--verify", "--quiet", `refs/remotes/${ctx.cfg.remote}/${current}`).ok) return true;
  const up = tryGit(wt, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  return up.ok && up.out !== `${ctx.cfg.remote}/${ctx.cfg.branch}`;
}

// Apply plan.md to the task: the record takes its type, objective and scope, and an unpushed branch takes the
// name they give, <type>/<name>. A pushed branch keeps its name: its PR is on it.
function applyPlan(ctx, task) {
  const f = path.join(taskDir(ctx, task.name), "plan.md");
  if (!fs.existsSync(f) || !readFrontMatter(fs.readFileSync(f, "utf8"))) return undefined; // an earlier version's plan
  Object.assign(task, withPlan(ctx, task));
  const want = branchOf(ctx, task.name, task.type);
  let note;
  if (task.branch !== want && fs.existsSync(task.path)) {
    if (isPushed(ctx, task, task.path)) note = `${task.branch} is pushed, so it keeps its name (plan.md's type gives ${want})`;
    else {
      if (tryGit(ctx.root, "rev-parse", "--verify", `refs/heads/${want}`).ok) fail(`branch ${want} already exists`);
      git(task.path, "branch", "-m", task.branch, want);
      note = `renamed ${task.branch} to ${want}`;
      task.branch = want;
    }
  }
  writeTask(ctx, task);
  return note;
}

function reviewTemplate(receipt) {
  return `# Review

Tree: ${receipt.tree}
Base: ${receipt.base}
Result: pending

## Findings

## Resolutions

## Limitations
`;
}

function parseReview(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  const field = (k) => (text.match(new RegExp(`^${k}:\\s*(\\S+)`, "m")) || [])[1];
  return { tree: field("Tree"), base: field("Base"), result: field("Result") };
}

// The files the task changed against its base, untracked ones included, sorted.
function changedFiles(task, cwd) {
  const changed = new Set();
  for (const line of tryGit(cwd, "diff", "--name-only", "--no-renames", task.baseSha).out.split("\n")) if (line) changed.add(line); // a move lists both paths
  for (const line of tryGit(cwd, "ls-files", "--others", "--exclude-standard").out.split("\n")) if (line) changed.add(line);
  return [...changed].sort();
}

function outOfScope(task, cwd) {
  const inScope = (f) => task.scope.some((s) => s === "." || f === s || f.startsWith(s.replace(/\/?$/, "/")));
  return changedFiles(task, cwd).filter((f) => !inScope(f));
}

// ---------------------------------------------------------------- commands

function cmdInspect(cwd) {
  const root = primaryRoot(cwd);
  if (!root) fail("not inside a git repository");
  const cfg = loadConfig(root);
  return { root, configured: !!cfg, config: cfg };
}

// Report drift from the base. Inside a pr-mode task with an open PR, also bring the PR's
// title and description in line with a changed pr.md (no push: code goes up through land).
function cmdSync(ctx, task) {
  const applied = task ? withLock(ctx, () => applyPlan(ctx, task)) : undefined;
  fetchBase(ctx);
  const ref = baseRef(ctx);
  const head = git(ctx.root, "rev-parse", "HEAD");
  const base = git(ctx.root, "rev-parse", ref);
  const counts = tryGit(ctx.root, "rev-list", "--left-right", "--count", `HEAD...${ref}`).out.split(/\s+/);
  const recent = git(ctx.root, "log", "--oneline", "-8", ref);
  const out = { base: ref, baseSha: base, primaryHead: head, ahead: Number(counts[0] || 0), behind: Number(counts[1] || 0), recent, ...(task && { task: task.name, branch: task.branch, note: applied }) };
  if (!task || ctx.cfg.mode !== "pr" || !fs.existsSync(path.join(taskDir(ctx, task.name), "pr.md"))) return out;
  const open = openPrFor(task);
  if (!open) return { ...out, pr: null, note: [applied, "no open PR for this task; land opens it"].filter(Boolean).join("; ") };
  return withLock(ctx, () => {
    const prMd = readPrMd(ctx, task);
    if (task.prSynced !== prMd.hash) prReadersGate(ctx, task);
    const pr = updatePr(task, open, prMd);
    writeTask(ctx, task);
    return { ...out, pr: pr.url, prAction: pr.action };
  });
}

function cmdStatus(ctx) {
  return taskNames(ctx).map((n) => {
      let t = readTask(ctx, n);
      try {
        t = withPlan(ctx, t);
      } catch {} // a malformed plan shows when the task's own sync or check runs
      const live = fs.existsSync(t.path);
      const dirty = live ? tryGit(t.path, "status", "--porcelain").out.split("\n").filter(Boolean).length : 0;
      const receipt = path.join(taskDir(ctx, n), "receipt.json");
      let verified = false;
      if (live && fs.existsSync(receipt)) {
        const r = JSON.parse(fs.readFileSync(receipt, "utf8"));
        verified = r.passed && r.tree === treeOf(t.path);
      }
      // Claude Code removes a session's worktree on its own; the record then stays open.
      const worktreeGone = !live && !CLOSED.includes(t.state);
      return { name: n, state: t.state, branch: t.branch, path: live ? t.path : null, worktreeGone, changedFiles: dirty, verified, pushed: t.pushed || null, objective: t.objective };
    });
}

const PLACEHOLDER = (name) => `Task ${name}: write its type, objective and scope here, then run sync.`;
const LEGACY_PLACEHOLDER = (name) => `Agent task ${name}, started from Claude Code. Write the objective, steps and acceptance in plan.md before editing.`;

function checkName(name) {
  if (!NAME.test(name || "")) fail("task name: lowercase letters, digits and dashes, starting with a letter or digit");
}

// The Conventional Commits types a task's branch can start with.
const TYPES = ["feat", "fix", "docs", "chore", "refactor", "test", "ci", "build", "perf", "style", "revert"];

// A task's branch: <type>/<name> when the task has a type, else the policy's branchPrefix (default codex/).
function branchOf(ctx, name, type) {
  return type ? `${type}/${name}` : `${ctx.cfg.branchPrefix}${name}`;
}

// Write the task record and plan for a worktree that exists, then run the prepare hooks.
function register(ctx, task) {
  const dir = taskDir(ctx, task.name);
  fs.mkdirSync(dir, { recursive: true });
  writeTask(ctx, task);
  fs.writeFileSync(path.join(dir, "plan.md"), planTemplate(task));
  // Links come first, so prepare hooks can use what they share.
  const links = linkWorktree(ctx.root, task.path, ctx.cfg.links);
  const linked = links.length ? { links } : {};
  if (links.some((l) => !l.ok)) {
    task.state = "prepare-failed";
    writeTask(ctx, task);
    return { task, ...linked, prepare: [], note: "a link failed; the worktree is kept for diagnosis (see links)" };
  }
  const prep = runHooks(ctx.cfg.prepare, task.path, path.join(dir, "prepare.log"));
  if (prep.some((r) => !r.ok)) {
    task.state = "prepare-failed";
    writeTask(ctx, task);
    return { task, ...linked, prepare: prep, note: "a prepare hook failed; the worktree is kept for diagnosis (see prepare.log)" };
  }
  return { task, ...linked, prepare: prep, plan: path.join(dir, "plan.md") };
}

// seed: the front matter values a sibling repository's task starts from (adopt --repo, start --repo).
function cmdStart(ctx, name, flags, seed = {}) {
  checkName(name);
  return withLock(ctx, () => {
    excludeWorkbench(ctx);
    if (fs.existsSync(taskDir(ctx, name))) fail(`task ${name} already exists`);
    if (!flags.base) fetchBase(ctx); // an explicit --base is used as is, offline
    const ref = flags.base || baseRef(ctx);
    const baseSha = git(ctx.root, "rev-parse", ref);
    const branch = branchOf(ctx, name, seed.type);
    if (tryGit(ctx.root, "rev-parse", "--verify", `refs/heads/${branch}`).ok) fail(`branch ${branch} already exists`);
    const wt = worktreePath(ctx, name);
    if (fs.existsSync(wt)) fail(`${wt} already exists; run adopt inside it`);
    git(ctx.root, "worktree", "add", "-b", branch, wt, baseSha);
    copyWorktreeInclude(ctx.root, wt);
    return register(ctx, { name, type: seed.type, objective: seed.objective || PLACEHOLDER(name), scope: ["."], branch, path: wt, base: ref, baseSha, mode: ctx.cfg.mode, state: "active", created: new Date().toISOString() });
  });
}

// Make the worktree Codex put this session in task <name>: register it (the app
// names it codex/<random>), or rename a task an earlier version's WorktreeCreate hook
// made under that random name. The branch becomes <branchPrefix><name> while it is
// unpushed, so one task name is one branch name in every repository.
function cmdAdopt(ctx, name, cwd) {
  const top = tryGit(cwd, "rev-parse", "--show-toplevel");
  if (!top.ok) fail("adopt runs inside a git worktree");
  const wt = real(top.out);
  if (wt === real(ctx.root)) fail("adopt runs inside a linked worktree, never the primary checkout");
  return withLock(ctx, () => {
    excludeWorkbench(ctx);
    const task = taskAt(ctx, wt);
    const before = task && { ...task };
    name = name || task?.name || taskName(path.basename(wt));
    checkName(name);
    const type = task ? withPlan(ctx, task).type : undefined;
    // Every refusal comes before the first change, so a failed adopt leaves the task as it was.
    if (task && task.name !== name && fs.existsSync(taskDir(ctx, name))) fail(`task ${name} already exists`);
    if (!task && fs.existsSync(taskDir(ctx, name))) fail(`task ${name} already exists for another worktree`);
    const want = branchOf(ctx, name, type);
    const current = tryGit(wt, "branch", "--show-current").out;
    if (!current) fail(`${wt} has a detached HEAD; check out a branch first`);
    if (current !== want) {
      if (isPushed(ctx, task || {}, wt)) fail(`branch ${current} is pushed; it keeps its name (start a new task to get ${want})`);
      if (tryGit(ctx.root, "rev-parse", "--verify", `refs/heads/${want}`).ok) fail(`branch ${want} already exists`);
    }
    if (task && task.name !== name) {
      fs.renameSync(taskDir(ctx, task.name), taskDir(ctx, name));
      if ([PLACEHOLDER(task.name), LEGACY_PLACEHOLDER(task.name)].includes(task.objective)) task.objective = PLACEHOLDER(name);
      task.name = name;
    }
    if (current !== want) git(wt, "branch", "-m", current, want);
    if (task) {
      task.branch = want;
      writeTask(ctx, task);
      // Rewrite the plan only while it is still the untouched template.
      const plan = path.join(taskDir(ctx, name), "plan.md");
      if (!fs.existsSync(plan) || fs.readFileSync(plan, "utf8") === planTemplate(before)) fs.writeFileSync(plan, planTemplate(task));
      return { task, plan, renamedFrom: current !== want ? current : undefined };
    }
    fetchBase(ctx);
    const ref = baseRef(ctx);
    const baseSha = git(wt, "merge-base", "HEAD", ref);
    const res = register(ctx, { name, objective: PLACEHOLDER(name), scope: ["."], branch: want, path: wt, base: ref, baseSha, mode: ctx.cfg.mode, state: "active", created: new Date().toISOString(), adopted: true });
    return { ...res, renamedFrom: current !== want ? current : undefined };
  });
}

function cmdCheck(ctx, task) {
  if (!fs.existsSync(task.path)) fail(`task ${task.name} has no worktree`);
  if (!ctx.cfg.check.length) fail("no hooks.check registered");
  const dir = taskDir(ctx, task.name);
  const log = path.join(dir, "check.log");
  fs.writeFileSync(log, `check ${new Date().toISOString()}\n`);
  const before = treeOf(task.path);
  const results = runHooks(ctx.cfg.check, task.path, log);
  const after = treeOf(task.path);
  const scope = outOfScope(withPlan(ctx, task), task.path);
  const receipt = {
    tree: after,
    base: task.baseSha,
    checks: results,
    outOfScope: scope,
    changedByChecks: before !== after,
    passed: results.every((r) => r.ok) && before === after,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  const review = path.join(dir, "review.md");
  const prior = parseReview(review);
  if (!fs.existsSync(review) || prior.tree !== receipt.tree) fs.writeFileSync(review, reviewTemplate(receipt));
  task.state = receipt.passed ? "checked" : "check-failed";
  writeTask(ctx, task);
  return { receipt, log, review, note: receipt.changedByChecks ? "a check changed the tree; verification is void, re-run check" : undefined };
}

// The last receipt, when it passed and is bound to the current tree and base.
function checkedReceipt(ctx, task) {
  const rf = path.join(taskDir(ctx, task.name), "receipt.json");
  if (!fs.existsSync(rf)) fail("no receipt; run check");
  const receipt = JSON.parse(fs.readFileSync(rf, "utf8"));
  const tree = treeOf(task.path);
  if (!receipt.passed) fail("the last check did not pass; see check.log");
  if (receipt.tree !== tree) fail("the tree changed since the last check; run check again");
  if (receipt.base !== task.baseSha) fail("the base changed since the last check; run check again");
  return { receipt, tree };
}

// Verify the receipt, the review and the reviewers are bound to the current tree and base.
function gate(ctx, task) {
  const dir = taskDir(ctx, task.name);
  const { receipt, tree } = checkedReceipt(ctx, task);
  const review = parseReview(path.join(dir, "review.md"));
  if (review.tree !== tree || review.base !== task.baseSha) fail("review.md is not bound to the checked Tree and Base");
  if (review.result !== "pass") fail("review.md does not record Result: pass");
  reviewGate(ctx, task, tree);
  return receipt;
}

// ---------------------------------------------------------------- reviewers

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// A glob over repository paths: * and ? stay within one path segment, ** crosses them.
function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// The reviewers whose when globs match a changed file; one without when reviews every change.
function reviewersFor(ctx, task) {
  if (!ctx.cfg.review.length) return { list: [], changed: [] };
  const changed = changedFiles(task, task.path);
  const list = ctx.cfg.review.filter((r) => !r.when || r.when.map(globRe).some((re) => changed.some((f) => re.test(f))));
  return { list, changed };
}

const taskText = (ctx, task, file) => {
  const f = path.join(taskDir(ctx, task.name), file);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
};

// What a reviewer's result depends on: the tree, the base, the reviewer itself and the task files it reads (its
// inputs; plan.md and qa.md unless it names fewer).
function reviewKey(ctx, task, r, tree) {
  const inputs = (r.inputs || DEFAULT_INPUTS).map((i) => [i, taskText(ctx, task, REVIEW_INPUTS[i])]);
  return sha256(JSON.stringify([tree, task.baseSha, r.name, r.command, r.when || null, inputs]));
}

const resultFile = (ctx, task, name) => path.join(taskDir(ctx, task.name), "reviews", `${name}.json`);

function readResult(ctx, task, name) {
  const f = resultFile(ctx, task, name);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

// A reviewer's output: { verdict: pass|fail, summary, findings: [{ id, severity: blocking|recommendation,
// escalate, title, detail, evidence }] }. Returns the error, or null.
function invalidResult(out) {
  if (!out || typeof out !== "object") return "the result is not a JSON object";
  if (!["pass", "fail"].includes(out.verdict)) return "verdict must be pass or fail";
  if (!Array.isArray(out.findings)) return "findings must be an array";
  const ids = new Set();
  for (const f of out.findings) {
    if (!/^[A-Za-z0-9._-]+$/.test(f?.id || "")) return `finding id ${JSON.stringify(f?.id)}: letters, digits, dot, dash or underscore`;
    if (ids.has(f.id)) return `finding id ${f.id} is repeated`;
    ids.add(f.id);
    if (!["blocking", "recommendation"].includes(f.severity)) return `finding ${f.id}: severity must be blocking or recommendation`;
    if (typeof f.title !== "string" || !f.title.trim()) return `finding ${f.id}: title is required`;
  }
  return null;
}

// The findings that need an answer, as <reviewer>/<id>. A fail verdict without a blocking finding counts as one.
function findingsOf(name, res) {
  const list = res.findings.map((f) => ({ ...f, id: `${name}/${f.id}`, hard: f.severity === "blocking" || !!f.escalate }));
  if (res.verdict === "fail" && !list.some((f) => f.severity === "blocking")) {
    list.push({ id: `${name}/verdict`, severity: "blocking", escalate: false, title: res.summary || "the reviewer failed the change", hard: true });
  }
  return list;
}

const ANSWER_KINDS = ["done", "not-needed", "human"];
const ANSWER = /^- ([a-z0-9][a-z0-9-]*\/[A-Za-z0-9._-]+): (done|not-needed|human): (\S.*)$/;

// The lines under review.md's ## Answers heading: "- <reviewer>/<id>: done|not-needed|human: <text>". Only the heading
// after the reviewers' block counts, so text a reviewer wrote into that block can never stand in for an answer.
function answersIn(text) {
  const out = new Map();
  const end = text.lastIndexOf(MARK[1]);
  if (end >= 0) text = text.slice(end + MARK[1].length);
  const at = text.search(/^## Answers\s*$/m);
  if (at < 0) return out;
  const rest = text.slice(at).split("\n").slice(1);
  for (const line of rest) {
    if (/^## /.test(line)) break;
    const m = line.match(ANSWER);
    if (m) out.set(m[1], { kind: m[2], text: m[3] });
  }
  return out;
}

function openFindings(findings, answers) {
  const open = [];
  for (const f of findings) {
    const a = answers.get(f.id);
    if (!a) open.push({ id: f.id, why: "unanswered" });
    else if (f.hard && a.kind !== "human") open.push({ id: f.id, why: "needs the user's answer (human:), or a fix that clears it on the next review" });
  }
  return open;
}

const MARK = ["<!-- workbench:reviewers -->", "<!-- /workbench:reviewers -->"];

// A reviewer's text as it goes into review.md: one line, and never read as a heading, a list item or a marker.
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").replaceAll("<!--", "< !--").trim();

function reviewerBlock(tree, results) {
  const lines = [MARK[0], "## Reviewers", "", `Bound to tree ${tree}. Answer every finding under ## Answers as \`- <reviewer>/<id>: done|not-needed|human: <text>\` (the answer command writes it). A blocking or escalated finding needs \`human:\` with the user's own words, or a fix that clears it on the next review.`];
  for (const [name, res] of results) {
    lines.push("", `### ${name}: ${res.ok ? res.verdict : "did not complete"}`);
    if (!res.ok) {
      lines.push("", `> ${oneLine(res.error)}`);
      continue;
    }
    if (res.summary) lines.push("", `> ${oneLine(res.summary)}`);
    const list = findingsOf(name, res);
    if (list.length) lines.push("");
    for (const f of list) {
      const tags = [f.severity, f.escalate && "escalate"].filter(Boolean).join(", ");
      lines.push(`- ${f.id} (${tags}): ${oneLine(f.title)}`);
      if (f.detail) lines.push(`  ${oneLine(f.detail)}`);
      if (f.evidence) lines.push(`  Evidence: ${oneLine(f.evidence)}`);
    }
  }
  lines.push(MARK[1]);
  return lines.join("\n");
}

// Put the reviewers' block in review.md (replacing the last one), drop the answers to the reviewers that ran again,
// and make sure it has an ## Answers section.
function upsertReviewers(file, block, rerun) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# Review\n";
  const stale = (line) => rerun.some((n) => line.startsWith(`- ${n}/`) && ANSWER.test(line));
  text = text.split("\n").filter((l) => !stale(l)).join("\n");
  const a = text.indexOf(MARK[0]);
  const b = text.indexOf(MARK[1]);
  if (a >= 0 && b > a) text = text.slice(0, a) + block + text.slice(b + MARK[1].length);
  else {
    const at = text.search(/^## Answers\s*$/m);
    text = at >= 0 ? `${text.slice(0, at)}${block}\n\n${text.slice(at)}` : `${text.replace(/\n*$/, "\n\n")}${block}\n`;
  }
  if (!/^## Answers\s*$/m.test(text)) text = `${text.replace(/\n*$/, "\n\n")}## Answers\n`;
  fs.writeFileSync(file, text);
}

function runReviewer(cmd, cwd, env, log) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd[0], cmd.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => (out += `${e}\n`));
    child.on("close", (code) => {
      fs.writeFileSync(log, `$ ${cmd.join(" ")}\n${out}`);
      resolve({ exit: code, ms: Date.now() - t0 });
    });
  });
}

// Run the reviewers that match the change, all at once, on the checked tree. A result already bound to the same
// inputs is reused unless --fresh true.
async function cmdReview(ctx, task, flags) {
  if (!fs.existsSync(task.path)) fail(`task ${task.name} has no worktree`);
  const { tree } = checkedReceipt(ctx, task);
  const { list, changed } = reviewersFor(ctx, task);
  const dir = taskDir(ctx, task.name);
  if (!list.length) return { reviewers: [], note: ctx.cfg.review.length ? "no reviewer's when matches this change" : "no hooks.review registered" };
  const rdir = path.join(dir, "reviews");
  fs.mkdirSync(rdir, { recursive: true });
  const changedFile = path.join(rdir, "changed.txt");
  fs.writeFileSync(changedFile, changed.map((f) => `${f}\n`).join(""));
  const done = await Promise.all(
    list.map(async (r) => {
      const key = reviewKey(ctx, task, r, tree);
      const prior = readResult(ctx, task, r.name);
      if (prior?.key === key && prior.ok && flags.fresh !== "true") return [r.name, prior, true];
      const outFile = path.join(rdir, `${r.name}.out.json`);
      fs.rmSync(outFile, { force: true });
      const env = {
        WORKBENCH_REVIEWER: r.name,
        WORKBENCH_TASK: task.name,
        WORKBENCH_TASK_DIR: dir,
        WORKBENCH_ROOT: ctx.root,
        WORKBENCH_WORKTREE: task.path,
        WORKBENCH_BASE: task.baseSha,
        WORKBENCH_TREE: tree,
        WORKBENCH_PLAN: path.join(dir, "plan.md"),
        WORKBENCH_QA: path.join(dir, "qa.md"),
        WORKBENCH_PR_FILE: path.join(dir, "pr.md"),
        WORKBENCH_RECEIPT: path.join(dir, "receipt.json"),
        WORKBENCH_CHANGED: changedFile,
        WORKBENCH_REVIEW_OUT: outFile,
      };
      const cmd = r.command.map((a) => a.replaceAll("{plugin}", PLUGIN_ROOT));
      const ran = await runReviewer(cmd, task.path, env, path.join(rdir, `${r.name}.log`));
      let res = { key, name: r.name, tree, exit: ran.exit, ms: ran.ms, at: new Date().toISOString() };
      let out = null;
      try {
        out = JSON.parse(fs.readFileSync(outFile, "utf8"));
      } catch {}
      const error = ran.exit !== 0 ? `exited ${ran.exit} (see reviews/${r.name}.log)` : !out ? "wrote no JSON to WORKBENCH_REVIEW_OUT" : invalidResult(out);
      if (error) res = { ...res, ok: false, error };
      else res = { ...res, ok: true, verdict: out.verdict, summary: String(out.summary || ""), findings: out.findings.map((f) => ({ ...f, escalate: !!f.escalate })) };
      fs.writeFileSync(resultFile(ctx, task, r.name), JSON.stringify(res, null, 2) + "\n");
      return [r.name, res, false];
    }),
  );
  const review = path.join(dir, "review.md");
  // A reviewer that ran again may reuse an id for another finding, so the answers to its last run go.
  upsertReviewers(review, reviewerBlock(tree, done.map(([n, res]) => [n, res])), done.filter(([, , cached]) => !cached).map(([n]) => n));
  const findings = done.filter(([, res]) => res.ok).flatMap(([n, res]) => findingsOf(n, res));
  const answers = answersIn(fs.readFileSync(review, "utf8"));
  const escalations = findings.filter((f) => f.escalate).map((f) => ({ id: f.id, title: f.title, detail: f.detail }));
  const failed = done.filter(([, res]) => !res.ok).map(([n]) => n);
  const notes = [];
  if (failed.length) notes.push(`${failed.join(", ")} did not complete; fix the cause and run review again`);
  if (escalations.length) notes.push("ask the user about each escalation, one at a time with your recommendation, and record their answer with answer --kind human");
  if (findings.length) notes.push("answer every finding with the answer command: done (fixed; a blocking one must clear on the next review), not-needed (with the reason), or human (the user's words)");
  return {
    reviewers: done.map(([n, res, cached]) => ({ name: n, ok: res.ok, cached, ...(res.ok ? { verdict: res.verdict, findings: res.findings.length } : { error: res.error }) })),
    escalations,
    open: openFindings(findings, answers).map((o) => o.id),
    review,
    ...(notes.length && { note: notes.join("; ") }),
  };
}

// land's reviewer gate: every matching reviewer completed on this tree, base, plan and QA notes, and every
// finding is answered (a blocking or escalated one by the user).
function reviewGate(ctx, task, tree) {
  const { list } = reviewersFor(ctx, task);
  const findings = [];
  for (const r of list) {
    const res = readResult(ctx, task, r.name);
    if (!res) fail(`reviewer ${r.name} has not run on this change; run review`);
    if (res.key !== reviewKey(ctx, task, r, tree)) fail(`reviewer ${r.name}'s result is stale (the tree, the base, the reviewer or one of its inputs changed); run review`);
    if (!res.ok) fail(`reviewer ${r.name} did not complete (${res.error}); fix the cause and run review`);
    findings.push(...findingsOf(r.name, res));
  }
  if (!findings.length) return;
  const open = openFindings(findings, answersIn(taskText(ctx, task, "review.md")));
  if (open.length) fail(`answer every reviewer finding in review.md first:\n${open.map((o) => `  ${o.id}: ${o.why}`).join("\n")}`);
}

// sync's gate before a changed pr.md reaches the open PR: every matching reviewer that reads pr.md has a current
// result, and its findings are answered, as land requires.
function prReadersGate(ctx, task) {
  if (!fs.existsSync(task.path)) return;
  const readers = reviewersFor(ctx, task).list.filter((r) => r.inputs?.includes("pr"));
  if (!readers.length) return;
  const { tree } = checkedReceipt(ctx, task);
  const findings = [];
  for (const r of readers) {
    const res = readResult(ctx, task, r.name);
    if (!res || res.key !== reviewKey(ctx, task, r, tree)) fail(`pr.md changed since reviewer ${r.name} read it; run review before sync updates the PR`);
    if (!res.ok) fail(`reviewer ${r.name} did not complete (${res.error}); fix the cause and run review`);
    findings.push(...findingsOf(r.name, res));
  }
  const open = openFindings(findings, answersIn(taskText(ctx, task, "review.md")));
  if (open.length) fail(`answer every reviewer finding in review.md first:\n${open.map((o) => `  ${o.id}: ${o.why}`).join("\n")}`);
}

// Record an answer under review.md's ## Answers, replacing an earlier answer to the same finding.
function cmdAnswer(ctx, task, flags) {
  if (!/^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._-]+$/.test(flags.id || "")) fail("--id <reviewer>/<finding id>, as review.md lists it");
  if (!ANSWER_KINDS.includes(flags.kind)) fail(`--kind ${ANSWER_KINDS.join(", ")}`);
  const text = String(flags.text || "").replace(/\s*\n\s*/g, " ").trim();
  if (!text) fail("--text: what was done, why it is not needed, or the user's own words");
  return withLock(ctx, () => {
    const file = path.join(taskDir(ctx, task.name), "review.md");
    if (!fs.existsSync(file)) fail("no review.md; run check");
    let body = fs.readFileSync(file, "utf8");
    if (!/^## Answers\s*$/m.test(body)) body = `${body.replace(/\n*$/, "\n\n")}## Answers\n`;
    const lines = body.split("\n");
    const start = lines.findIndex((l) => /^## Answers\s*$/.test(l));
    let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    if (end < 0) end = lines.length;
    const line = `- ${flags.id}: ${flags.kind}: ${text}`;
    const prior = lines.findIndex((l, i) => i > start && i < end && l.startsWith(`- ${flags.id}: `));
    if (prior >= 0) lines[prior] = line;
    else {
      let at = end;
      while (at > start + 1 && lines[at - 1].trim() === "") at--;
      lines.splice(at, 0, ...(at === start + 1 ? ["", line] : [line]));
    }
    fs.writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
    return { review: file, answered: flags.id, kind: flags.kind };
  });
}

// put: write a task file from stdin, for agents whose file tools may not write outside their worktree.
const PUT = { plan: "plan.md", pr: "pr.md", qa: "qa.md", review: "review.md" };

function cmdPut(ctx, task, kind, text) {
  if (!PUT[kind]) fail(`put plan, pr, qa or review`);
  return withLock(ctx, () => {
    const file = path.join(taskDir(ctx, task.name), PUT[kind]);
    const prior = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    fs.writeFileSync(file, text);
    if (kind === "plan") {
      try {
        withPlan(ctx, task);
      } catch (e) {
        if (prior === null) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, prior);
        throw e;
      }
    }
    return { wrote: file, bytes: Buffer.byteLength(text), ...(kind === "plan" && { note: "run sync to apply the front matter" }) };
  });
}

// Bring a moved base into the task branch. Returns true when it moved.
function integrateBase(ctx, task) {
  fetchBase(ctx);
  const tip = git(ctx.root, "rev-parse", task.base);
  if (tip === task.baseSha || tryGit(task.path, "merge-base", "--is-ancestor", tip, "HEAD").ok) return false;
  const how = ctx.cfg.integrate === "rebase" ? ["rebase", tip] : ["merge", "--no-edit", tip];
  const r = tryGit(task.path, ...how);
  if (!r.ok) fail(`integrating ${task.base} failed; resolve in ${task.path} and re-run: ${r.err || r.out}`);
  task.baseSha = tip;
  writeTask(ctx, task);
  return true;
}

// Bring commits pushed to the task branch from elsewhere into the worktree (a review
// suggestion committed on the forge, Auto-fix in another session). Returns true when it did.
function integrateRemoteBranch(ctx, task) {
  if (ctx.cfg.mode !== "pr" || !task.pushed) return false;
  if (!tryGit(task.path, "fetch", "--quiet", ctx.cfg.remote, task.branch).ok) return false; // not on the remote (yet)
  const tip = git(task.path, "rev-parse", "FETCH_HEAD");
  // Still land's own last push: nothing from elsewhere, and a rewrite here replaces it (leaseOf).
  if (tip === task.pushed || tryGit(task.path, "merge-base", "--is-ancestor", tip, "HEAD").ok) return false;
  const r = tryGit(task.path, "merge", "--no-edit", tip);
  if (!r.ok) fail(`merging ${ctx.cfg.remote}/${task.branch} failed; resolve in ${task.path} and re-run: ${r.err || r.out}`);
  return true;
}

function cmdLand(ctx, task, flags) {
  return withLock(ctx, () => {
    if (flags.merged) return closeAfterMerge(ctx, task, flags.merged);
    const ready = prepareLand(ctx, task, flags);
    return ready.stop || deliver(ctx, task, flags, ready);
  });
}

// Everything land does before delivery: gate, commit, and bring in what moved. Returns { stop } when the task
// needs check and review again, else the commit to deliver. Nothing leaves this clone here, so a concerted land
// can prepare every repository before it pushes any.
function prepareLand(ctx, task, flags) {
  if (!flags.message) fail("--message is required");
  applyPlan(ctx, task);
  const receipt = gate(ctx, task);
  if (ctx.cfg.mode === "local") {
    const on = tryGit(ctx.root, "branch", "--show-current").out;
    if (on !== ctx.cfg.branch) fail(`the primary checkout is on ${on || "a detached HEAD"}, not ${ctx.cfg.branch}; check out ${ctx.cfg.branch} there, then land`);
  }
  // In pr mode land ends at an open PR whose title and description come from pr.md.
  const prMd = ctx.cfg.mode === "pr" && !flags.noPr ? readPrMd(ctx, task) : null;
  if (tryGit(task.path, "status", "--porcelain").out) {
    git(task.path, "add", "-A");
    const c = tryGit(task.path, "commit", "-m", flags.message);
    if (!c.ok) fail(`commit failed (hooks are never bypassed): ${c.err || c.out}`);
  }
  // A commit hook that rewrites files (a formatter) would deliver a tree no one checked or reviewed.
  if (git(task.path, "rev-parse", "HEAD^{tree}") !== receipt.tree) {
    task.state = "changed-by-hooks";
    writeTask(ctx, task);
    fail("the commit hooks changed the tree after check; the commit is kept in the worktree: run check and review again, then land");
  }
  if (integrateRemoteBranch(ctx, task)) {
    task.state = "branch-moved";
    writeTask(ctx, task);
    return { stop: { state: task.state, note: `${ctx.cfg.remote}/${task.branch} had commits this worktree lacked (review suggestions, or fixes pushed from elsewhere); they were merged in. Run check and review again, then land` } };
  }
  if (integrateBase(ctx, task)) {
    task.state = "base-moved";
    writeTask(ctx, task);
    return { stop: { state: task.state, note: `${task.base} moved and was integrated; run check and review again, then land` } };
  }
  return { head: git(task.path, "rev-parse", "HEAD"), prMd };
}

// Deliver a prepared commit by the policy's mode.
function deliver(ctx, task, flags, { head, prMd }) {
  if (ctx.cfg.mode === "local") {
    const r = tryGit(ctx.root, "merge", "--ff-only", head);
    if (!r.ok) fail(`fast-forward of ${ctx.cfg.branch} in the primary checkout failed: ${r.err}`);
    return finish(ctx, task, head);
  }
  if (ctx.cfg.mode === "direct") {
    const r = tryGit(task.path, "push", ctx.cfg.remote, `${head}:refs/heads/${ctx.cfg.branch}`);
    if (!r.ok) fail(`push failed: ${r.err}`);
    fetchBase(ctx);
    return finish(ctx, task, head);
  }
  const r = tryGit(task.path, "push", "-u", ...leaseOf(ctx, task), ctx.cfg.remote, task.branch);
  if (!r.ok) fail(`push of ${task.branch} failed: ${r.err}`);
  task.state = "pushed";
  task.pushed = head;
  writeTask(ctx, task);
  const out = { state: task.state, branch: task.branch, head };
  if (flags.noPr) return { ...out, note: "pushed; run land in this repository's own session to open its PR there" };
  const pr = syncPr(ctx, task, prMd, flags);
  writeTask(ctx, task);
  if (pr.action === "printed") {
    return {
      ...out,
      prAction: pr.action,
      prCommand: pr.command,
      note: process.env.CODEX_THREAD_ID
        ? "run prCommand, then call the Codex app's attach_artifact tool with artifact_type pull_request and the returned URL. Attach every created PR. Merging needs the repository's own approval"
        : "run prCommand as your own Bash command, so the app counts the PR as this session's; then call get_status, and set_monitor with auto_fix true and the URL it printed. Merging needs the repository's own approval",
    };
  }
  return {
    ...out,
    pr: pr.url,
    prAction: pr.action,
    note: pr.action === "created" ? "opened the PR. Merging needs the repository's own approval" : "pushed to the open PR. Merging needs the repository's own approval",
  };
}

// A PR branch whose remote tip is still the commit land last pushed has had no one else's push, so it is ours to
// rewrite (an amended commit, a rebase onto a moved base): push it with a lease on that commit, which git refuses
// if anyone pushes in between. A branch someone else pushed to goes up as a plain push, after their commits were
// merged in (integrateRemoteBranch).
function leaseOf(ctx, task) {
  if (!task.pushed) return [];
  if (!tryGit(task.path, "fetch", "--quiet", ctx.cfg.remote, task.branch).ok) return [];
  if (git(task.path, "rev-parse", "FETCH_HEAD") !== task.pushed) return [];
  return [`--force-with-lease=refs/heads/${task.branch}:${task.pushed}`];
}

// The forge CLI (gh), overridable for tests.
function forge(cwd, ...args) {
  const r = spawnSync(process.env.WORKBENCH_GH || "gh", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || String(r.error || "")).trim() };
}

// pr.md beside plan.md: "# <title>" on the first line, the PR description below it.
function readPrMd(ctx, task) {
  const file = path.join(taskDir(ctx, task.name), "pr.md");
  if (!fs.existsSync(file)) fail(`write ${file} first: "# <PR title>" on the first line, then the PR description`);
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/^# (.+)\n([\s\S]*)$/);
  if (!m || !m[1].trim() || !m[2].trim()) fail(`${file} needs "# <PR title>" on its first line and a description below it`);
  return { title: m[1].trim(), body: m[2].trim() + "\n", hash: crypto.createHash("sha256").update(text).digest("hex") };
}

// Open the task's PR, or bring an open PR's title and description in line with pr.md when
// pr.md changed since the last sync; edits made on the forge survive until then. Inside
// Codex (CODEX_THREAD_ID set), or Claude Code (CLAUDECODE=1), land only prints the gh pr create command, its body in a file:
// the agent runs the command and attaches the resulting PR through the desktop app tool.
function syncPr(ctx, task, prMd, flags) {
  const open = openPrFor(task);
  if (open) return updatePr(task, open, prMd);
  const args = ["pr", "create", "--base", ctx.cfg.branch, "--head", task.branch, "--title", prMd.title];
  if (flags.draft === "true") args.push("--draft");
  if (Boolean(process.env.CODEX_THREAD_ID) || process.env.CLAUDECODE === "1") {
    const bodyFile = path.join(taskDir(ctx, task.name), "pr-body.md");
    fs.writeFileSync(bodyFile, prMd.body);
    task.prSynced = prMd.hash; // the command opens the PR from this pr.md, so the next land leaves it as it is
    return { action: "printed", command: `cd ${shellQuote(task.path)} && gh ${[...args, "--body-file", bodyFile].map(shellQuote).join(" ")}` };
  }
  const c = forge(task.path, ...args, "--body", prMd.body);
  if (!c.ok) fail(`the branch is pushed, but opening its PR failed (re-run land to retry): ${c.err || c.out}`);
  task.pr = c.out.split("\n").pop();
  task.prSynced = prMd.hash;
  return { url: task.pr, action: "created" };
}

// One word for a POSIX shell: as it is when it needs no quoting, else in single quotes.
const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function openPrFor(task) {
  const v = forge(task.path, "pr", "view", task.branch, "--json", "url,state");
  if (!v.ok) return null;
  const pr = JSON.parse(v.out);
  return pr.state === "OPEN" ? pr.url : null;
}

function updatePr(task, url, prMd) {
  task.pr = url;
  if (task.prSynced === prMd.hash) return { url, action: "unchanged" };
  const e = forge(task.path, "pr", "edit", url, "--title", prMd.title, "--body", prMd.body);
  if (!e.ok) fail(`updating the PR from pr.md failed (re-run to retry): ${e.err || e.out}`);
  task.prSynced = prMd.hash;
  return { url, action: "updated" };
}

// The PR's last state: review and CI fixes may have been pushed after land, by hand or from elsewhere. It is the
// remote branch while that exists; a forge that deletes the branch on merge still names the PR's head commit.
function prHead(ctx, task) {
  if (ctx.cfg.mode !== "pr") return null;
  if (tryGit(ctx.root, "fetch", "--quiet", ctx.cfg.remote, task.branch).ok) return git(ctx.root, "rev-parse", "FETCH_HEAD");
  const v = forge(ctx.root, "pr", "view", task.pr || task.branch, "--json", "headRefOid");
  const head = v.ok ? JSON.parse(v.out).headRefOid : null;
  if (!head) return null;
  // The forge keeps the head reachable (GitHub under refs/pull), so a commit pushed from elsewhere can be fetched.
  if (!tryGit(ctx.root, "cat-file", "-e", `${head}^{commit}`).ok && !tryGit(ctx.root, "fetch", "--quiet", ctx.cfg.remote, head).ok) {
    fail(`the PR's head ${head} is not in this clone and fetching it from ${ctx.cfg.remote} failed; fetch it, then re-run`);
  }
  return head;
}

function closeAfterMerge(ctx, task, sha) {
  if (task.state === "landed") {
    // Landed already: run hooks.merged again (one failed, or the policy gained one), for that merge only.
    if (task.landed !== sha) fail(`${task.name} landed as ${task.landed}, not ${sha}`);
    const merged = runMerged(ctx, task, sha);
    return { state: task.state, landed: sha, ...merged };
  }
  fetchBase(ctx);
  if (!tryGit(ctx.root, "merge-base", "--is-ancestor", sha, task.base).ok) fail(`${sha} is not on ${task.base}`);
  const tip = prHead(ctx, task) || task.pushed || git(task.path, "rev-parse", "HEAD");
  const merged = tryGit(ctx.root, "merge-base", "--is-ancestor", tip, sha).ok;
  if (!merged) {
    // Squash or rebase merge: compare the patch, not the commits. A patch-id ignores line numbers, which shift when
    // the base gained lines above the change before the merge.
    const from = tryGit(ctx.root, "merge-base", tip, `${sha}^`).out || task.baseSha;
    if (patchId(ctx.root, from, tip) !== patchId(ctx.root, `${sha}^`, sha)) fail("the merged commit's patch differs from the pushed branch; investigate before closing");
  }
  // A PR the agent opened from land's printed command, with no land or sync since, is recorded here.
  if (ctx.cfg.mode === "pr" && !task.pr) {
    const v = forge(ctx.root, "pr", "view", task.branch, "--json", "url");
    if (v.ok) task.pr = JSON.parse(v.out).url;
  }
  return finish(ctx, task, sha);
}

// The patch-id of the diff from a to b, whitespace kept; empty for an empty diff.
function patchId(cwd, a, b) {
  const diff = spawnSync("git", ["diff", a, b], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (diff.status !== 0) fail(`git diff ${a} ${b} failed: ${(diff.stderr || "").trim()}`);
  const id = spawnSync("git", ["patch-id", "--verbatim"], { cwd, input: diff.stdout, encoding: "utf8" });
  if (id.status !== 0) fail(`git patch-id failed (it needs git 2.39 or later): ${(id.stderr || "").trim()}`);
  return id.stdout.split(" ")[0].trim();
}

// Remove a worktree the caller has found clean. git refuses any worktree that contains submodules
// unless forced; the clean check (which covers submodule changes too) is what makes --force safe.
// Symlinks, links included, are removed without following them.
function removeWorktree(ctx, wt) {
  const force = fs.existsSync(path.join(wt, ".gitmodules")) ? ["--force"] : [];
  git(ctx.root, "worktree", "remove", ...force, wt);
}

function finish(ctx, task, sha) {
  if (fs.existsSync(task.path)) {
    if (tryGit(task.path, "status", "--porcelain").out) fail("the worktree has uncommitted changes; nothing is removed");
    removeWorktree(ctx, task.path);
  } else tryGit(ctx.root, "worktree", "prune"); // Claude Code removed it already
  task.state = "landed";
  task.landed = sha;
  writeTask(ctx, task);
  const merged = runMerged(ctx, task, sha);
  return { state: task.state, landed: sha, kept: taskDir(ctx, task.name), note: `branch ${task.branch} kept for recovery`, ...merged };
}

// hooks.merged: the repository's own commands once the task's change is on the base branch (a PR merged, or a
// local or direct land), run in the primary checkout with the task in the environment and logged to merged.log.
// The task is landed whatever they answer; a failed one is re-run by land --merged <sha>, so they must be safe
// to run twice.
function runMerged(ctx, task, sha) {
  if (!ctx.cfg.merged.length) return {};
  const dir = taskDir(ctx, task.name);
  const env = {
    WORKBENCH_TASK: task.name,
    WORKBENCH_TASK_DIR: dir,
    WORKBENCH_BRANCH: task.branch,
    WORKBENCH_BASE: ctx.cfg.branch,
    WORKBENCH_MERGED: sha,
    WORKBENCH_PR: task.pr || "",
  };
  const results = runHooks(ctx.cfg.merged, ctx.root, path.join(dir, "merged.log"), env);
  task.mergedHooks = results;
  writeTask(ctx, task);
  if (results.every((r) => r.ok)) return { merged: results };
  return { merged: results, mergedNote: `a merged hook failed (see ${path.join(dir, "merged.log")}); fix the cause, then run land ${task.name} --merged ${sha} to run them again` };
}

function cmdAbandon(ctx, task) {
  return withLock(ctx, () => {
    if (fs.existsSync(task.path)) {
      if (tryGit(task.path, "status", "--porcelain").out) fail("the worktree has uncommitted changes; commit, stash or remove them first");
      removeWorktree(ctx, task.path);
    }
    task.state = "abandoned";
    writeTask(ctx, task);
    return { state: task.state, kept: taskDir(ctx, task.name), branch: task.branch };
  });
}

function cmdContext(cwd) {
  const root = primaryRoot(cwd);
  if (!root) return "";
  const cfg = loadConfig(root);
  if (!cfg) return "";
  const ctx = ctxAt(root, cfg);
  const ref = baseRef(ctx);
  const base = tryGit(root, "rev-parse", "--short", ref).out || "?";
  const lines = [`Workbench (${cfg.mode} mode, base ${ref} @ ${base}). Start scoped work with the workbench skill; never edit the primary checkout for a task.`];
  let tasks = [];
  try {
    tasks = cmdStatus(ctx).filter((t) => !CLOSED.includes(t.state));
  } catch {}
  for (const t of tasks.slice(0, 8)) lines.push(`- ${t.name} [${t.state}${t.verified ? ", verified" : ""}${t.worktreeGone ? ", worktree gone" : `, ${t.changedFiles} changed`}] ${t.path || ""}`);
  let current = null;
  try {
    current = taskAt(ctx, cwd);
  } catch {}
  const top = tryGit(cwd, "rev-parse", "--show-toplevel");
  if (!current && top.ok && real(top.out) !== real(root)) {
    const branch = tryGit(cwd, "branch", "--show-current").out || "detached";
    lines.push("", `This worktree (${top.out}, branch ${branch}) is not a Workbench task yet. Before editing, and always before the first push, run adopt <name> (the feature's name, the same in every repository), then write the type, objective and scope in the task's plan.md front matter and run sync: the branch becomes <type>/<name> (without a type, ${cfg.branchPrefix}<name>).`);
  }
  if (current) {
    const t = current;
    const dir = taskDir(ctx, t.name);
    const plan = fs.existsSync(path.join(dir, "plan.md")) ? fs.readFileSync(path.join(dir, "plan.md"), "utf8").trim() : "";
    const receipt = fs.existsSync(path.join(dir, "receipt.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "receipt.json"), "utf8")) : null;
    lines.push(
      "",
      `You are working in Workbench task "${t.name}" (state ${t.state}, branch ${t.branch}, base ${t.base} @ ${String(t.baseSha).slice(0, 7)}).`,
      `Worktree: ${t.path}. Plan: ${path.join(dir, "plan.md")}. Review: ${path.join(dir, "review.md")}.`,
      receipt ? `Last check: ${receipt.passed ? "passed" : "failed"} (${receipt.checks.map((c) => `${c.name} ${c.ok ? "ok" : "FAIL"}`).join(", ")}).` : "No check has run yet.",
      "Work only in this worktree and within the plan's scope. Before finishing: run the workbench check, review the full diff into review.md (Result: pass only when acceptance is proved), and land only when the user or repository policy authorises it.",
    );
    if (cfg.review.length) lines.push(`Reviewers (hooks.review): ${cfg.review.map((r) => r.name).join(", ")}. After check and your QA (record what you tried to break and what you saw: put qa), run review (in the background: it takes minutes), then answer every finding with answer; ask the user about each escalation, with your recommendation.`);
    if ([PLACEHOLDER(t.name), LEGACY_PLACEHOLDER(t.name)].includes(withPlanOrTask(ctx, t).objective)) lines.push("plan.md's front matter still has the placeholder objective: write the type, objective and scope there, then run sync (the branch follows the type).");
    if (plan) lines.push("", "plan.md:", plan.length > 1500 ? plan.slice(0, 1500) + "\n…" : plan);
  }
  return lines.join("\n");
}

const CLOSED = ["landed", "abandoned", "closed"];

function withPlanOrTask(ctx, task) {
  try {
    return withPlan(ctx, task);
  } catch {
    return task;
  }
}


// ---------------------------------------------------------------- worktree helpers

// Slug a Codex worktree name into a task name.
function taskName(raw) {
  const n = String(raw || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  if (!NAME.test(n)) fail(`cannot make a task name from ${JSON.stringify(raw)}`);
  return n;
}

// Give a new worktree the policy's links: a relative symlink per path, pointing at the same path in
// the primary checkout. A missing source becomes an empty directory there. A path that already
// exists in the worktree is never replaced. A link git does not ignore is removed again and fails,
// since it would show as a change in every task (a "dir/" pattern does not match a symlink).
function linkWorktree(root, wt, links) {
  return links.map((p) => {
    const src = path.join(root, p);
    const dst = path.join(wt, p);
    const rel = path.relative(path.dirname(dst), src);
    let existing = null;
    try {
      existing = fs.lstatSync(dst);
    } catch {}
    if (existing) {
      const same = existing.isSymbolicLink() && path.resolve(path.dirname(dst), fs.readlinkSync(dst)) === src;
      return same ? { path: p, ok: true, note: "already linked" } : { path: p, ok: false, note: "exists in the worktree; not replaced" };
    }
    let created = false;
    if (!fs.existsSync(src)) {
      fs.mkdirSync(src, { recursive: true });
      created = true;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(rel, dst);
    if (!tryGit(wt, "check-ignore", "-q", "--", p).ok) {
      fs.unlinkSync(dst);
      return { path: p, ok: false, note: `not ignored by git; add "${p}" to .gitignore (a "${p}/" pattern does not match a symlink)` };
    }
    return { path: p, ok: true, target: src, ...(created ? { created: true } : {}) };
  });
}

// Copy gitignored files listed in .worktreeinclude, as Claude Code's default does.
function copyWorktreeInclude(root, wt) {
  const inc = path.join(root, ".worktreeinclude");
  if (!fs.existsSync(inc)) return 0;
  const files = tryGit(root, "ls-files", "--others", "--ignored", `--exclude-from=${inc}`).out.split("\n").filter(Boolean);
  for (const f of files) {
    const to = path.join(wt, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, f), to);
  }
  return files.length;
}

// ---------------------------------------------------------------- CLI

function parse(argv) {
  const flags = { repo: [] };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a.startsWith("--")) {
      const k = a.slice(2);
      if (["objective", "scope", "type"].includes(k)) fail(`${a} is gone: write type, objective and scope in the task's plan.md front matter, then run sync`);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) fail(`${a} needs a value`);
      if (k === "repo") flags[k].push(v);
      else flags[k] = v;
      i++;
    } else pos.push(a);
  }
  return { cmd: pos[0], args: pos.slice(1), flags };
}

// One task name across repositories: run the command here, then in each --repo
// sibling, keyed by repository root. A sibling's own policy applies there.
function acrossRepos(cwd, repos, fn) {
  if (!repos.length) return fn(cwd, true);
  const out = {};
  for (const [i, dir] of [cwd, ...repos].entries()) {
    const root = primaryRoot(path.resolve(cwd, dir));
    if (!root) fail(`${dir} is not inside a git repository`);
    out[root] = fn(i === 0 ? cwd : root, i === 0);
  }
  return out;
}

export function run(argv, cwd = process.cwd(), io = {}) {
  const { cmd, args, flags } = parse(argv);
  // Siblings know the task by name only; a name resolved from cwd carries over.
  const named = () => args[0] || (flags.repo.length ? resolveTask(ctxFor(cwd), undefined, cwd).name : undefined);
  const each = (fn) => {
    const name = named();
    return acrossRepos(cwd, flags.repo, (dir, here) => {
      const ctx = ctxFor(dir);
      return fn(ctx, resolveTask(ctx, name, here ? cwd : dir), here);
    });
  };
  if (!cmd || cmd === "help" || flags.help) return usage();
  switch (cmd) {
    case "inspect":
      return cmdInspect(cwd);
    case "context": {
      // Plain stdout is context for SessionStart; other events, such as SubagentStart, take it as additionalContext.
      const text = cmdContext(cwd);
      if (!flags.hook || !text) return text;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: flags.hook, additionalContext: text } });
    }
    case "sync": {
      const here = args[0] ? readTask(ctxFor(cwd), args[0]) : taskAt(ctxFor(cwd), cwd);
      // A feature's branch is one name in every repository, so its plans name one type.
      const taskIn = (ctx, first) => (first ? here : here && taskNames(ctx).includes(here.name) ? readTask(ctx, here.name) : null);
      if (here && flags.repo.length) {
        const type = withPlan(ctxFor(cwd), here).type;
        acrossRepos(cwd, flags.repo, (dir, first) => {
          const ctx = ctxFor(dir);
          const t = taskIn(ctx, first);
          const theirs = t && withPlan(ctx, t).type;
          if (t && theirs !== type) fail(`one type across repositories: ${type || "none"} here, ${theirs || "none"} in ${ctx.root}`);
        });
      }
      return acrossRepos(cwd, flags.repo, (dir, first) => {
        const ctx = ctxFor(dir);
        return cmdSync(ctx, taskIn(ctx, first));
      });
    }
    case "status":
      return acrossRepos(cwd, flags.repo, (dir) => cmdStatus(ctxFor(dir)));
    case "start":
      return acrossRepos(cwd, flags.repo, (dir, here) => cmdStart(ctxFor(dir), args[0], here ? flags : { ...flags, base: undefined }));
    case "adopt": {
      const here = cmdAdopt(ctxFor(cwd), args[0], cwd);
      if (!flags.repo.length) return here;
      // Siblings start from this task's type and objective; their scope starts at the whole repository.
      const { type, objective } = withPlan(ctxFor(cwd), here.task);
      return acrossRepos(cwd, flags.repo, (dir, first) => (first ? here : cmdStart(ctxFor(dir), here.task.name, flags, { type, objective })));
    }
    case "check":
      return each(cmdCheck);
    case "land": {
      // Only the repository it runs in opens its PR here; each sibling opens its own from its session.
      const own = (here) => (here ? flags : { ...flags, noPr: true });
      if (!flags.repo.length || flags.merged) return each((ctx, task, here) => cmdLand(ctx, task, own(here)));
      // A concerted push: every repository's gate passes before any of them commits, and every one is prepared
      // (committed, with what moved brought in) before any of them pushes.
      each((ctx, task) => gate(ctx, task));
      const ready = each((ctx, task, here) => ({ ctx, task, here, prep: withLock(ctx, () => prepareLand(ctx, task, own(here))) }));
      const stopped = Object.values(ready).filter((r) => r.prep.stop).map((r) => `${r.ctx.root} (${r.prep.stop.state})`);
      return Object.fromEntries(
        Object.entries(ready).map(([root, r]) => [
          root,
          r.prep.stop ||
            (stopped.length
              ? { state: r.task.state, note: `ready, not pushed: ${stopped.join(", ")} must be checked and reviewed again first; then land again with the same --repo` }
              : withLock(r.ctx, () => deliver(r.ctx, r.task, own(r.here), r.prep))),
        ]),
      );
    }
    case "abandon":
      return each(cmdAbandon);
    case "review": {
      if (flags.repo.length) fail("review runs in one repository at a time; run it in each task's worktree");
      const ctx = ctxFor(cwd);
      return cmdReview(ctx, resolveTask(ctx, args[0], cwd), flags);
    }
    case "answer": {
      const ctx = ctxFor(cwd);
      return cmdAnswer(ctx, resolveTask(ctx, args[0], cwd), flags);
    }
    case "put": {
      const ctx = ctxFor(cwd);
      if (!PUT[args[0]]) fail("put plan, pr, qa or review");
      return cmdPut(ctx, resolveTask(ctx, args[1], cwd), args[0], io.stdin ?? fs.readFileSync(0, "utf8"));
    }
    default:
      fail(`unknown command ${cmd}; run --help for the commands`);
  }
}

// The header comment above, as the CLI's usage text.
function usage() {
  const lines = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
  return lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const out = await run(process.argv.slice(2));
    if (typeof out === "string") {
      if (out) console.log(out);
    } else console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    if (process.argv[2] === "context") process.exit(0); // hooks stay silent
    console.error(`workbench: ${e instanceof WorkbenchError ? e.message : e.stack}`);
    process.exit(1);
  }
}
