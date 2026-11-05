---
name: workbench
description: Plans, implements, verifies, reviews and delivers a scoped change in its own git worktree with the Workbench engine. Use when starting a task in a repository that has a .workbench.json or .git/workbench.json, when splitting work into separate branches or PRs, or when landing, pushing or closing a Workbench task.
---

# Workbench

The engine is the absolute installed path of [scripts/workbench.mjs](../../scripts/workbench.mjs) (Node 20+ and git). Run it with `node <path> <command>` from the primary checkout or from inside a task worktree. It prints JSON.

## Adopt the repository's policy

Run `inspect`. The configuration is `.workbench.json` at the repository root (shared, committed). If that file is absent, the engine reads `.git/workbench.json` (this clone only, never committed). The configuration fixes three things:

- **`mode`:**
  - `local` merges into the local base branch.
  - `direct` pushes to the remote base branch.
  - `pr` pushes the task branch for review.

  A remote existing does not by itself mean PR mode. If the policy is not stated, ask.
- **`hooks.prepare`:** commands run in a new worktree.
- **`hooks.check`:** commands that verify it.
- **`hooks.review`:** reviewers `review` runs on the checked tree, each when a changed file matches its `when` globs (see "Reviewers").
- **`hooks.merged`:** commands run in the primary checkout once the task's change is on the base branch (at `land --merged` in pr mode, at `land` in local and direct mode), with `WORKBENCH_TASK`, `WORKBENCH_TASK_DIR`, `WORKBENCH_BRANCH`, `WORKBENCH_BASE`, `WORKBENCH_MERGED` and `WORKBENCH_PR` set; output in `merged.log`. A repository uses them to act on a merge, such as moving its tracker's issues.
- **`links`** (optional): git-ignored paths every new worktree gets as symlinks into the primary checkout (shared notes, caches). Ignore each with a pattern without a trailing slash (`notes`, not `notes/`); a link git does not ignore fails setup.

Commands are argument arrays, run without a shell. Add `branchPrefix` (a task's branch prefix while its plan names no type; default `codex/`), `branch`, `remote` and `integrate` (`merge` or `rebase`) as the repository requires; a repository that forbids rebase uses `merge`.

## Work a task

1. **Sync and read.** Run `sync` and read the recent commits it returns, before planning. Repeat after compaction and before delegating.
2. **Start.** In a session Codex already put in a worktree (an app-managed linked worktree), run `adopt <name>` there. Otherwise run `start <name>` from the primary checkout. Pick `<name>` for the feature, not the session: the same `<name>` in every repository. Work only in the task's worktree; never edit the primary checkout for a task.
3. **Write the task's data, then sync.** The task's data is the front matter of `.workbench/tasks/<name>/plan.md`, and no command takes it as flags:
   ```markdown
   ---
   type: feat
   objective: <the outcome the user asked for>
   scope:
     - <path>
   ---
   ```
   - `type` is the feature's Conventional Commits type (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf`, `style`, `revert`). Use the same type in every repository's plan, even where that repository's PR title takes another type: the branch is `<type>/<name>` everywhere, and `sync --repo` refuses different types.
   - Then run `sync`: it applies the front matter, renaming the unpushed branch to `<type>/<name>`. Without a type the branch stays `<branchPrefix><name>`, else `codex/<name>`.
   - Fill the plan's Steps and Acceptance below the front matter before editing. To change the scope or type later, edit the file and `sync` again; a pushed branch keeps its name.
   For a feature that spans repositories, give each repository its own desktop-app worktree session that adopts the same `<name>` (see "Pull requests belong to the app"). For local-only work, `--repo <path>` on `adopt` or `start` creates the sibling task in one go (for example `--repo ../app`). Either way, `status`, `check` and `land` take `--repo` to act on every repository.
4. **Implement within scope.** The receipt lists files changed outside scope.
5. **Check.** Run `check`. It runs every registered check, writes `check.log` and `receipt.json`, and binds the receipt to a hash of the whole tree. A check that changes files voids verification.
6. **QA.** Try to break what you built beyond the checks, and record what you tried and what you saw, with the evidence, in the task's `qa.md` (`put qa` reads it from stdin).
7. **Review.** Read the full diff (`git -C <worktree> diff <baseSha>` plus untracked files). Then edit `review.md` (or `put review`): keep its `Tree:` and `Base:` lines, set `Result: pass` only when the acceptance items are proved, and record the findings, resolutions and limitations. Any later change to the tree requires `check` and review again.
8. **Reviewers.** When the policy registers `hooks.review`, run `review` (in the background: it takes minutes). Answer every finding with `answer --id <reviewer/id> --kind done|not-needed|human --text <text>`: `done` for a fix, `not-needed` with the reason, `human` with the user's own words. A blocking finding needs a fix that clears it on the next `review`, or the user's answer. For each escalation `review` lists, ask the user, one at a time, with your recommendation, and record their words with `--kind human`; never answer an escalation yourself. A change to the tree, `plan.md`, `qa.md` or `pr.md` makes the affected results stale: `check` and `review` again (a changed `pr.md` needs only `review`); `sync` holds a changed `pr.md` back from the open PR until the reviewers that read it are current.

The task files live in the primary checkout's `.workbench/tasks/<name>/`. Where your file tools may not write outside the worktree, write them with `put plan|pr|qa|review` (stdin).

## Deliver

Run `land --message "<conventional commit subject>"` only when the user or the repository policy authorises that commit and push. The engine refuses to land unless:
- the receipt passed;
- the receipt and `review.md` are bound to the current tree and base;
- `review.md` says `Result: pass`;
- every registered reviewer whose `when` matches has a current result, and every finding is answered (blocking and escalated ones by the user).

`--message` may carry a body and trailers: pass them in the one argument, newlines included.

It commits through the repository's hooks and never bypasses them; a hook that changes files stops it at `changed-by-hooks`, for check and review again. If the base has moved, it integrates the base and asks for check and review again.

- **local:** fast-forwards the base branch in the primary checkout, which must have it checked out, then removes the worktree.
- **direct:** pushes to the remote base, then removes the worktree.
- **pr:** pushes only the task branch, then opens the PR from `.workbench/tasks/<name>/pr.md`, or updates the open PR when `pr.md` changed. It returns `pushed` with the PR's URL. Inside Codex (`CODEX_THREAD_ID` is set) it opens no PR: it returns `prAction: printed` and `prCommand`, the `gh pr create` command for you to run (see "Pull requests belong to the app"). Write `pr.md` before the first land: `# <PR title>` on the first line, then the description, written per the repository's PR-description convention. PRs open ready for review; `--draft true` opens a draft. With `--repo`, no repository is pushed until every one passes its gate and is committed with what moved brought in, which makes it the concerted push of a feature. A PR opens only in the repository `land` runs in; each sibling's own session runs `land` to open its PR. Merging follows the repository's approval rules; never merge without that approval.

**Review rounds.** After review comments or a CI failure:
1. Fix the code in the worktree.
2. Run `check`, and review again.
3. Run `land --message "<subject>"` again.

If the PR branch gained commits elsewhere (a suggestion committed on the forge, a fixer in another session), `land` merges them in and stops at `branch-moved`; run check and review again, then land. A PR branch no one else has pushed to is the task's to rewrite: when its remote tip is still `land`'s last push, `land` pushes an amended commit or a rebase with `--force-with-lease` on that push, and git refuses it if anyone pushed in between. To change only the title or description, edit `pr.md` and run `sync` inside the worktree; that pushes no code.

## Pull requests belong to the app

Inside Codex, the first `land` pushes the branch and returns `prCommand`. Run that exact `gh pr create` command, then attach its returned URL with the Codex app's `attach_artifact` tool (`artifact_type: pull_request`). Attach every created PR. Use the account already signed in to `gh` unless the user authorizes another account. Codex and Claude have different app tools; use the tools this session actually exposes for PR review and progress.

`adopt` works in an existing linked worktree, including one the desktop app created outside this repository. Engine-created worktrees live in `.codex/worktrees/<name>`. Register each repository's worktree with the same feature name before the first push; put the same `type` in its plan and run `sync`. Follow the current app's worktree attachment and cleanup rules. A PR merge is reported separately from its branch being pushed or PR being opened.

After the forge merges a PR, run `land --merged <sha>` to verify the pushed state and run `hooks.merged`. If the app removed the worktree first, `status` shows `worktreeGone` until `land --merged` or `abandon` closes the task. A result carrying `mergedNote` names a failed merge hook; fix its cause and retry `land <name> --merged <sha>`.

## Hooks

At session start, resume and compaction, and at subagent start, the plugin prints a short context for configured repositories: the mode, the base and the active tasks. It prints nothing in other repositories.

## Reviewer availability

Claude reviews stay primary. A repository can opt into the [runner fallback](../../README.md#reviewers) with `WORKBENCH_FALLBACK_MODEL` and `WORKBENCH_FALLBACK_EFFORT`. A valid failed review is a finding to resolve; fallback handles recognized runner unavailability only. Keep the same role, permitted evidence and schema, inspect the `.runner.json` provenance beside each result, and rerun the affected gate after fixing findings.
