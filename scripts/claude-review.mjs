#!/usr/bin/env node
// A hooks.review reviewer that asks a headless Claude Code session (claude -p) for a verdict on a task's change.
//
// Usage (as a hooks.review command; Workbench sets the WORKBENCH_* environment and runs it in the worktree):
//   node {plugin}/scripts/claude-review.mjs --prompt <file> [--model <id>] [--effort <level>]
//        [--with acceptance,diff,changed,qa,receipt,plan,pr] [--max-diff <chars>]
//        [--add-dir <dir>[,<dir>…]] [--include <file>[,<file>…]]
//
//   --prompt   the reviewer's instructions: an absolute path, or one relative to the repository root
//              (WORKBENCH_ROOT), for example a prompt kept in .workbench/ that is never committed
//   --with     what the reviewer is given (default acceptance,diff):
//                acceptance  plan.md's objective and Acceptance section, never its Steps
//                plan        the whole plan.md
//                diff        the diff from the base to the checked tree, untracked files included
//                changed     the list of changed files
//                qa          qa.md, the author's record of what they tried to break
//                receipt     the checks that ran and their results
//              The author's review.md is never given, and the file tools stay inside the worktree.
//   --max-diff a diff longer than this is cut, and the reviewer reads the files itself (default 300000)
//   --add-dir  directories outside the worktree the reviewer may also read (a sibling repository's rules, say);
//              name the directories it needs, never a parent of the task's evidence, or it is no longer blind
//   --include  files whose content is added to the prompt, each as its own section (context a wrapper
//              script computed, such as the state of the same task in sibling repositories)
//
// The session is restricted: Read, Grep and Glob only, confined to the worktree, no settings files, no MCP
// servers, no session saved. Its structured output goes to WORKBENCH_REVIEW_OUT. WORKBENCH_CLAUDE overrides
// the claude binary (tests).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "severity", "escalate", "title", "detail", "evidence"],
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9._-]+$" },
          severity: { type: "string", enum: ["blocking", "recommendation"] },
          escalate: { type: "boolean" },
          title: { type: "string" },
          detail: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

const CONTRACT = `## How to answer

Return the structured result only.

- verdict: fail when any finding is blocking; otherwise pass.
- summary: one or two sentences on the change as a whole.
- findings: one per distinct issue, ids F1, F2, … in order of importance.
  - severity blocking: the change is wrong, unsafe, or does not meet an acceptance item, and must be fixed
    before it lands. Everything else is a recommendation.
  - escalate true: the implementer should not settle it alone. Set it when there is more than one reasonable
    answer, the choice is hard to reverse, it changes the scope or the merge order, or it belongs to someone
    else's area. Say what the options are and which one you recommend.
  - title: the issue in one line. detail: what is wrong, why it matters, and what to do. evidence: the
    file:line (or the input section) that shows it.
- Report only what you can show from the material and the files. Never invent a finding to have one; an empty
  findings list with verdict pass is a good answer.
`;

function parse(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) die(`expected --flag value pairs, got ${argv[i]}`);
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  return flags;
}

function die(msg) {
  console.error(`claude-review: ${msg}`);
  process.exit(1);
}

const env = (k) => process.env[k] || die(`${k} is not set; run this as a Workbench hooks.review command`);
const readIf = (f) => (f && fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");

// plan.md's objective (front matter) and its ## Acceptance section.
function acceptanceOf(plan) {
  const objective = (plan.match(/^---\n[\s\S]*?^objective:\s*(.*)$[\s\S]*?\n---\n/m) || [])[1] || "";
  const lines = plan.split("\n");
  const at = lines.findIndex((l) => /^## Acceptance\s*$/.test(l));
  let section = "";
  if (at >= 0) {
    const end = lines.findIndex((l, i) => i > at && /^## /.test(l));
    section = lines.slice(at + 1, end < 0 ? undefined : end).join("\n").trim();
  }
  return `Objective: ${objective.trim() || "(none stated)"}\n\nAcceptance:\n${section || "(none stated)"}`;
}

function diffOf(max) {
  const out = execFileSync("git", ["diff", "--no-color", env("WORKBENCH_BASE"), env("WORKBENCH_TREE")], { cwd: env("WORKBENCH_WORKTREE"), encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (out.length <= max) return out;
  return `${out.slice(0, max)}\n\n[diff cut at ${max} of ${out.length} characters: read the remaining changed files yourself]`;
}

const SECTIONS = {
  acceptance: () => ["The task's objective and acceptance", acceptanceOf(readIf(env("WORKBENCH_PLAN")))],
  plan: () => ["The task's plan", readIf(env("WORKBENCH_PLAN")) || "(no plan.md)"],
  diff: (flags) => [`The change: git diff ${env("WORKBENCH_BASE").slice(0, 12)} to the checked tree`, diffOf(Number(flags["max-diff"] || 300000))],
  changed: () => ["Changed files", readIf(env("WORKBENCH_CHANGED")) || "(none)"],
  qa: () => ["The author's QA notes (qa.md)", readIf(process.env.WORKBENCH_QA) || "(no qa.md: the author recorded no QA)"],
  receipt: () => ["The checks that ran (receipt.json)", readIf(process.env.WORKBENCH_RECEIPT) || "(no receipt)"],
  pr: () => ["The pull request's title and description (pr.md)", readIf(process.env.WORKBENCH_PR_FILE) || "(no pr.md yet)"],
};

function main() {
  const flags = parse(process.argv.slice(2));
  if (!flags.prompt) die("--prompt <file> is required");
  const promptFile = path.isAbsolute(flags.prompt) ? flags.prompt : path.join(process.env.WORKBENCH_ROOT || process.cwd(), flags.prompt);
  if (!fs.existsSync(promptFile)) die(`no prompt at ${promptFile}`);
  const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const want = list(flags.with || "acceptance,diff");
  const dirs = list(flags["add-dir"]);
  for (const d of dirs) if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) die(`--add-dir ${d} is not a directory`);
  const includes = list(flags.include);
  for (const f of includes) if (!fs.existsSync(f) || !fs.statSync(f).isFile()) die(`--include ${f} is not a file`);
  for (const w of want) if (!SECTIONS[w]) die(`--with ${w}: one of ${Object.keys(SECTIONS).join(", ")}`);
  const parts = [fs.readFileSync(promptFile, "utf8").trim(), `Task: ${env("WORKBENCH_TASK")}. You are reviewer ${env("WORKBENCH_REVIEWER")}, working in ${env("WORKBENCH_WORKTREE")}; the files there are the checked tree.`];
  for (const w of want) {
    const [title, body] = SECTIONS[w](flags);
    parts.push(`## ${title}\n\n<${w}>\n${body.trim()}\n</${w}>`);
  }
  for (const f of includes) parts.push(`## Included: ${path.basename(f)}\n\n<include>\n${fs.readFileSync(f, "utf8").trim()}\n</include>`);
  parts.push(CONTRACT);
  const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA), "--restricted", "--tools", "Read,Grep,Glob", "--strict-mcp-config", "--permission-mode", "dontAsk", "--no-session-persistence"];
  if (flags.model) args.push("--model", flags.model);
  if (flags.effort) args.push("--effort", flags.effort);
  for (const d of dirs) args.push("--add-dir", d);
  const r = spawnSync(process.env.WORKBENCH_CLAUDE || "claude", args, { cwd: env("WORKBENCH_WORKTREE"), input: parts.join("\n\n"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) die(`could not run claude: ${r.error.message}`);
  let res;
  try {
    res = JSON.parse(r.stdout);
  } catch {
    die(`claude exited ${r.status} without a JSON result: ${(r.stderr || r.stdout || "").trim().slice(0, 2000)}`);
  }
  if (res.is_error || !res.structured_output) die(`claude returned no verdict: ${String(res.result || res.subtype || r.stderr || "").slice(0, 2000)}`);
  fs.writeFileSync(env("WORKBENCH_REVIEW_OUT"), JSON.stringify(res.structured_output, null, 2) + "\n");
  const cost = typeof res.total_cost_usd === "number" ? `, $${res.total_cost_usd.toFixed(4)}` : "";
  console.log(`${res.structured_output.verdict}: ${res.structured_output.findings.length} finding(s)${cost}`);
}

main();
