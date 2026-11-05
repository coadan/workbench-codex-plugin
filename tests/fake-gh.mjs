#!/usr/bin/env node
// A stand-in for gh: `pr view|create|edit`, PRs kept per origin URL and head branch
// in the JSON file FAKE_GH_STATE, every call appended to its `calls`. Tests point
// WORKBENCH_GH at this file so nothing reaches a forge. Tests run outside Codex
// unless one sets CODEX_THREAD_ID itself, so land opens the PR through this file.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function install() {
  const file = new URL(import.meta.url).pathname;
  fs.chmodSync(file, 0o755);
  process.env.WORKBENCH_GH = file;
  delete process.env.CODEX_THREAD_ID;
  process.env.FAKE_GH_STATE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-gh-")), "state.json");
}

// The forge merged the PR on <branch> at <head> and deleted the branch: the PR keeps its head commit.
export function merged(remote, branch, head) {
  const state = read();
  Object.assign(state.prs[`${remote}#${branch}`], { state: "MERGED", headRefOid: head });
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state, null, 2));
}

export const read = () => (fs.existsSync(process.env.FAKE_GH_STATE) ? JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8")) : { prs: {}, calls: [] });

function main(argv) {
  const state = read();
  state.calls.push(argv);
  const origin = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const flag = (k) => argv[argv.indexOf(k) + 1];
  const [, verb, target] = argv;
  let code = 0;
  if (verb === "view") {
    const pr = state.prs[`${origin}#${target}`] || Object.values(state.prs).find((p) => p.url === target);
    if (pr) console.log(JSON.stringify({ url: pr.url, state: pr.state, headRefOid: pr.headRefOid }));
    else {
      console.error(`no pull requests found for branch "${target}"`);
      code = 1;
    }
  } else if (verb === "create") {
    const url = `https://forge.example/pull/${Object.keys(state.prs).length + 1}`;
    const body = argv.includes("--body-file") ? fs.readFileSync(flag("--body-file"), "utf8") : flag("--body");
    state.prs[`${origin}#${flag("--head")}`] = { url, state: "OPEN", title: flag("--title"), body, base: flag("--base"), draft: argv.includes("--draft") };
    console.log(url);
  } else if (verb === "edit") {
    const pr = Object.values(state.prs).find((p) => p.url === target);
    Object.assign(pr, { title: flag("--title"), body: flag("--body") });
  }
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state, null, 2));
  process.exit(code);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) main(process.argv.slice(2));
