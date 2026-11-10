#!/usr/bin/env node
// The Claude-first reviewer, kept for hooks.review commands written before review.mjs: Claude reviews, and Codex
// only when a fallback model is named (--fallback-model, or WORKBENCH_FALLBACK_MODEL and WORKBENCH_FALLBACK_EFFORT)
// and Claude is unavailable. It takes every review.mjs flag; new reviewers use review.mjs, which runs Codex first.
//
// --primary codex (and WORKBENCH_REVIEW_PRIMARY=codex), the Codex-only review of plugin 0.5.1, is refused with the
// review.mjs command that replaces it: left to the shared flag parser, it would be ignored and Claude would review.
import { main } from "./review.mjs";

const argv = process.argv.slice(2);
const at = argv.indexOf("--primary");
const flag = at >= 0 && at % 2 === 0 ? argv[at + 1] : undefined;
const primary = flag ?? process.env.WORKBENCH_REVIEW_PRIMARY;
if (primary && primary !== "claude") {
  console.error(`review: --primary ${primary} (or WORKBENCH_REVIEW_PRIMARY) is replaced by scripts/review.mjs, which runs Codex first ` +
    "(--model and --effort, default gpt-6.1-sol xhigh) with Claude as the fallback (--fallback-model, --fallback-effort); " +
    "add --fallback-runner none for a Codex-only review");
  process.exit(1);
}
main(flag === "claude" ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv, { legacy: true });
