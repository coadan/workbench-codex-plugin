---
name: workbench
description: Plan, implement, verify, review, and deliver scoped Git tasks with the portable Workbench engine. Use for local-only development, direct-push workflows, or forge pull-request workflows in repositories adopting Workbench.
---

# Workbench

Resolve the [CLI](../../scripts/workbench.mjs) to its absolute installed path and run it with Node. The commands below refer to arguments for that CLI; a repository may expose an equivalent wrapper such as `pnpm task`. Node.js 24+ and Git run the coordinator. Repositories own any extra tools used by their hooks or forge workflow.

## Adopt the repository's policy

Run `inspect` and read the owning repository instructions. Configuration lives in `.workbench.json`, or in `package.json` under `workbench`; the standalone file takes precedence. Read the [configuration contract](../../README.md#repository-configuration) when setting up or changing these settings.

Choose the delivery mode from explicit user or repository policy: `local` integrates into the local base branch without contacting a remote; `direct` pushes the verified result to the remote base branch; `pr` pushes the task branch for forge review. A remote's existence does not establish a PR policy. If policy is unspecified, resolve it before configuring delivery. Register the repository's real preparation and verification commands, then commit the configuration before starting the first task.

## Get current and work

1. Before research, planning, or edits, inspect `pwd` and Git status, run `sync`, and read the recent base-branch commits. Inspect relevant diffs and update assumptions. Repeat after resume, compaction, and before delegation. Preserve dirty work; coordinate a checkpoint with its owner if integrating new base commits requires one.
2. Run `start <name> --objective "<outcome>" --scope <path>`, repeating `--scope` for each owned path. Enter the returned checkout at `.workbench/tasks/<name>/repo`. Fill the adjacent plan's Objective, Steps, and Acceptance sections before editing. Preparation hooks run in that checkout.
3. Implement within scope. Give delegated agents the checkout, bounded assignment, current base SHA, and relevant recent commits. Each agent syncs before working; coordinate checkpoints and delivery through the task owner.
4. Run `check` and any additional checks required by owning instructions. Review the complete diff, fix findings, and write actual review in the adjacent `review.md`. Bind `Tree`, `Base`, and `Result: pass` to the receipt; record findings, resolutions, and limitations. Mark acceptance complete only when proved.

## Deliver according to mode

Run `land --message "<change>"` when the selected commit/push action is authorized. Changed content or base requires renewed review. Resolve conflicts, check failures, or push failures and retry the same task.

- **Local:** the engine integrates into the local base branch and closes the task. All Git operations stay local.
- **Direct:** the engine pushes a fast-forward to the configured base branch, fetches again, synchronizes against remote readback, and closes the task.
- **PR:** the engine publishes only the task branch and returns `awaiting-pr`. Use the owning forge's CLI or connector to create or update the PR with the verified change and checks. Observe its review and CI requirements. Merge only with the authorization required by the repository; when approval is pending, leave the task available and report the PR. After the forge merges it, run `land` again. For a squash or rebase merge, obtain the merge SHA from the forge and pass `land --merged <sha>`; the engine verifies the merged patch before cleanup. Investigate a patch mismatch instead of forcing closure.

Task state, plans, review, receipts, and logs remain in `.workbench/tasks/<name>/` after the clean `repo/` checkout is removed. The coordinator adds `.workbench/` to local Git exclusions. Use `status` from the primary checkout to list active tasks. Report the result, checks, and commit or PR, distinguishing a submitted PR from a completed landing.

## Hook context

Trusted plugin hooks refresh Git context at session start, resume, compaction, prompts, and subagent start in configured repositories. They stay silent elsewhere. Context hooks preserve checkout contents; explicit `sync` and landing gates perform integration. Trust definitions through `/hooks` in the Codex CLI. These workflow requirements also apply when using the engine from another harness.
