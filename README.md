# Workbench for Codex

This plugin uses the current [Claude Workbench delivery contract](https://github.com/coadan/workbench-claude-plugin) with native Codex integration. Use it to iterate on a feature locally, across one or more repositories, before you push it all for review at once. Every task gets:
- a git worktree, adopted from the app or created at `<repo>/.codex/worktrees/<name>`;
- the same branch, `<type>/<name>`, in every repository it spans;
- a plan whose front matter is the task's data (type, objective, scope), applied by `sync`;
- the repository's own checks;
- a review bound to a hash of the exact tree it approves, with optional reviewers (Claude Code sessions or any command) whose every finding must be answered before it lands.

Delivery follows the repository's policy: merge locally, push to the base branch, or push a branch for a pull request. In a Codex chat, run the returned PR command and attach its URL to the chat. The plugin needs Node.js 20+ and git, and has no dependencies.

## Install

Clone this repository and add its root as a local Codex plugin marketplace. The native catalog is `.agents/plugins/marketplace.json`; its plugin is `workbench@workbench-local`.

```toml
[marketplaces.workbench-local]
source_type = "local"
source = "/absolute/path/to/workbench-codex-plugin"

[plugins."workbench@workbench-local"]
enabled = true

[features]
hooks = true
```

Refresh the marketplace and start a new Codex chat to load the skill and hooks. The source needs Node.js 20+ and Git; only repositories that configure Claude reviewers also need the Claude CLI. The engine works directly as well:

```sh
node /path/to/workbench-codex-plugin/scripts/workbench.mjs --help
```

Use `adopt <feature>` inside an existing linked worktree, or `start <feature>` from the primary checkout. Write the task's type, objective and scope in `plan.md`, then `sync`.

## Configure a repository

Put one of these files in the repository:
- `.workbench.json` at the root, to share the policy with everyone;
- `.git/workbench.json`, for this clone only (never committed). The engine reads it only when `.workbench.json` is absent.

```json
{
  "mode": "pr",
  "branch": "main",
  "remote": "origin",
  "branchPrefix": "docs/",
  "integrate": "merge",
  "links": ["notes"],
  "hooks": {
    "prepare": [{ "name": "deps", "command": ["npm", "ci"] }],
    "check": [{ "name": "test", "command": ["npm", "test"] }]
  }
}
```

| Key | Meaning |
|---|---|
| `mode` | Required: `local`, `direct` or `pr`. A remote existing does not select PR mode |
| `branch`, `remote` | The base branch and its remote. Defaults: `main`, `origin` |
| `branchPrefix` | Prefix for a task's branch while its plan names no type. Default: `codex/` |
| `integrate` | How a moved base enters a task branch: `merge` (default) or `rebase` |
| `links` | Git-ignored paths, relative to the root, that every new worktree gets as a relative symlink to the same path in the primary checkout, so notes and caches are shared instead of copied. Made on `start` and `adopt`, before the prepare hooks. A missing source becomes an empty directory. A path already in the worktree is never replaced. Each path must be ignored by a pattern without a trailing slash (`notes`, not `notes/`), because git does not match a `dir/` pattern against a symlink; a link git does not ignore fails setup like a prepare hook. Removing a worktree removes its links, never their targets |
| `hooks.prepare` | Commands run in a new worktree. A failure keeps the worktree for diagnosis |
| `hooks.check` | Commands that verify a task. A check that changes files voids verification |
| `hooks.review` | Reviewers run by `review` on the checked tree; see [Reviewers](#reviewers) |
| `hooks.merged` | Commands run in the primary checkout once a task's change is on the base branch: at `land --merged` in pr mode, at `land` in local and direct mode. They get `WORKBENCH_TASK`, `WORKBENCH_TASK_DIR`, `WORKBENCH_BRANCH`, `WORKBENCH_BASE`, `WORKBENCH_MERGED` (the commit on the base) and `WORKBENCH_PR` (the PR's URL, or empty), and log to `merged.log`. The task is landed whatever they answer; `land <name> --merged <sha>` runs them again, so they must be safe to run twice |

Commands are argument arrays and run without a shell.

A worktree that contains submodules is removed with `git worktree remove --force` once `land` or `abandon` has found it clean, since git refuses to remove such a worktree otherwise. The clean check covers changes inside submodules too.

## The task's data: plan.md front matter

A task's type, objective and scope live in one place, the front matter of `<repo>/.workbench/tasks/<name>/plan.md`. You write the file; `sync` and `land` apply it. No command takes them as flags.

```markdown
---
type: feat
objective: Add a configurable search ranking profile
scope:
  - src/search
  - Makefile
---
# platform-dev-profiles

## Steps
…
```

- **`type`:** a Conventional Commits type (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf`, `style`, `revert`). It names the branch: `<type>/<name>`. The type belongs to the feature, not to one PR: a feature's hub PR may be `docs(…)` and its app PR `feat(…)`, but both branches carry the plan's one type, so the branch name is the same in every repository. `sync --repo` refuses plans that name different types.
- **`objective`** and **`scope`:** what the task is for, and the paths it may change. `check` reads the scope from the plan as it stands and lists the files changed outside it.
- **The branch name, in order:** `<type>/<name>` when the plan names a type; else the policy's `branchPrefix` and `<name>`; else `codex/<name>`. `sync` and `land` rename an unpushed branch to match. A pushed branch keeps its name, since its PR is on it, and `sync` says so.
- **`start` and `adopt`** write the front matter with a placeholder objective and scope `.`; the session-start context asks for it to be filled in until it is.

## Commands

| Command | Does |
|---|---|
| `inspect` | Shows the resolved configuration |
| `sync [name]` | Inside a task (or for the task named), applies `plan.md`'s front matter: the task record takes its type, objective and scope, and an unpushed branch is renamed to `<type>/<name>`. Then fetches the base (in direct and pr modes) and reports drift and recent commits. In a `pr`-mode task with an open PR, it also brings the PR's title and description in line with a changed `pr.md`, without pushing |
| `status` | Lists tasks: state, changed files, whether the current tree is verified, and `worktreeGone` for an open task whose worktree Claude Code has removed |
| `start <name> [--base <ref>]` | Creates the worktree `.codex/worktrees/<name>` on branch `<branchPrefix><name>`, writes `plan.md` with its front matter, runs the prepare hooks. An explicit `--base` skips the fetch |
| `adopt [name]` | Run inside the worktree the app put the session in (the desktop app names it `.codex/worktrees/<random>` on `<app prefix>/<random>`). Registers it as task `<name>`, which defaults to the directory name, writes `plan.md` with its front matter and runs the prepare hooks in place. A task an earlier version's hook made under a random name is renamed instead. An unpushed branch becomes `<branchPrefix><name>` (or `<type>/<name>` when the plan already names a type); one pushed under its own name keeps it, so adopt before the first push. A plan still at its template is rewritten |
| `check [name]` | Runs the checks and writes `check.log` and `receipt.json` (tree hash, base, results, files out of scope), plus a `review.md` template |
| `review [name] [--fresh true]` | Runs the `hooks.review` reviewers whose `when` matches the change, on a tree whose check passed, and writes their findings into `review.md`. Returns each reviewer's verdict, the escalations and the findings still open |
| `answer [name] --id <reviewer/id> --kind done\|not-needed\|human --text <text>` | Records the answer to a finding under `## Answers` in `review.md`, replacing an earlier one |
| `put plan\|pr\|qa\|review [name]` | Writes that task file from stdin, for an agent whose file tools may not write outside its worktree. A plan with a front matter `sync` would refuse is not kept |
| `land [name] --message <text> [--draft true]` | Applies `plan.md` as `sync` does. Requires a passing receipt and `review.md` (`Result: pass`) bound to the current tree and base, and, when reviewers are registered, a current result from each matching one with every finding answered. The message may carry a body and trailers (one argument, newlines included). Then commits (through the repository's hooks), integrates a moved base, and delivers by mode. A commit hook that changes files (a formatter) stops it at `changed-by-hooks`, the commit kept, for check and review again. In `local` mode the primary checkout must have the base branch checked out. In `pr` mode it pushes the branch, then opens the PR from the task's `pr.md` or, when the PR is already open, updates it if `pr.md` changed. Inside Codex (`CODEX_THREAD_ID` set) it opens no PR and returns `prAction: printed` with `prCommand`, the `gh pr create` command for the agent to run (see [Sessions and pull requests](#sessions-and-pull-requests)). It records state `pushed`. PRs open ready for review unless `--draft true` is given. Run it again for every later round |
| `land [name] --merged <sha>` | After a PR merges: confirms the merge against the PR branch's last pushed state (comparing patches for a squash or rebase merge), records the PR's URL if no land or sync has yet, removes the worktree and runs `hooks.merged`; on a landed task, runs `hooks.merged` again for that merge |
| `abandon <name>` | Removes a clean worktree (if it still exists) and keeps the evidence and the branch |

Without a name, a command acts on the task whose worktree contains the current directory.

Task evidence lives under `<repo>/.workbench/tasks/<name>/` (`task.json`, `plan.md`, `receipt.json`, `review.md`, `qa.md`, `reviews/`, `pr.md`, `pr-body.md` for a printed `gh pr create`, the logs); `task.json` records the worktree's path and the PR's URL. The engine adds `.workbench/` and `.codex/worktrees/` to `.git/info/exclude`. A lock file serialises operations between cooperating agents. Tasks from earlier versions, whose worktree is at `.workbench/tasks/<name>/repo`, keep working as they are.

### One feature across repositories

`--repo <path>` (repeatable) runs a command in each sibling repository as well, under the same task name, so the branch name is the same in each. Each repository applies its own policy, and the output is keyed by repository root.

| Command | Across repositories |
|---|---|
| `start <name> --repo ../app` | Starts `<name>` in each one |
| `adopt <name> --repo ../app` | Adopts the current worktree, then starts `<name>` in each sibling with this plan's type and objective, and scope `.` |
| `sync --repo ../app` | Refuses when the repositories' plans name different types; otherwise applies each repository's own plan |
| `status`, `check`, `abandon` with `--repo` | Run in each one |
| `land --message <text> --repo ../app` | The concerted push: every repository's receipt and review must pass first, so a failing one stops all of them before anything is committed. Then every repository commits and brings in what moved before any of them pushes; one that must be checked again (`base-moved`, `branch-moved`) stops the push for all |

## Reviewers

`hooks.review` lets a repository put reviewers between `check` and `land`: commands that read the task's change and return a verdict with findings. The engine stays neutral about who reviews; the plugin ships a runner for Claude Code reviewers and two generic prompts, and a repository adds its own prompts beside them.

```json
{
  "hooks": {
    "review": [
      {
        "name": "task",
        "inputs": ["plan"],
        "command": ["node", "{plugin}/scripts/claude-review.mjs", "--prompt", "{plugin}/reviewers/task.md",
                    "--model", "claude-sonnet-5-5", "--effort", "xhigh"]
      },
      {
        "name": "qa",
        "command": ["node", "{plugin}/scripts/claude-review.mjs", "--prompt", "{plugin}/reviewers/qa.md",
                    "--with", "acceptance,changed,qa,receipt", "--model", "claude-sonnet-5-5", "--effort", "xhigh"]
      },
      {
        "name": "api",
        "when": ["api/**", "**/*.proto"],
        "inputs": ["plan"],
        "command": ["node", "{plugin}/scripts/claude-review.mjs", "--prompt", ".workbench/reviewers/api.md",
                    "--model", "claude-opus-5-5", "--effort", "xhigh"]
      }
    ]
  }
}
```

| Key | Meaning |
|---|---|
| `name` | The reviewer's name: lowercase letters, digits and dashes. Its findings are `<name>/<id>` |
| `when` | Globs over the changed files (`*` and `?` within a path segment, `**` across them). The reviewer runs when one matches; without `when` it reviews every change |
| `inputs` | The task files besides the tree the result depends on: `plan`, `qa`, `pr` (the PR title and description), or any mix; `plan` and `qa` by default. A result goes stale when the tree, the base, the reviewer's entry or one of its inputs changes |
| `command` | An argument array run in the task's worktree, without a shell. `{plugin}` in an argument is this plugin's directory |

**The flow.** After `check` passes and the author has done QA (recording what they tried to break and what they saw in `qa.md`: `put qa`), `review` runs every reviewer whose `when` matches, all at once, and writes their findings into `review.md` between `<!-- workbench:reviewers -->` markers. A result bound to the same inputs is reused; `--fresh true` runs them again, and a reviewer that runs again drops the answers to its last run. Reviewers take minutes: run `review` in the background. A reviewer with `pr` among its inputs also guards the PR text: `sync` sends a changed `pr.md` to the open PR only once that reviewer has a current result and its findings are answered.

**Answers.** `land` refuses until every finding has an answer under `## Answers` in `review.md`, one line each, which `answer` writes:

```markdown
- task/F1: done: renamed the flag and updated its test
- task/F2: not-needed: the caller already validates the input (api/handler.go:41)
- qa/F1: human: user: "element validation is out of scope for this task"
```

A blocking finding, or one the reviewer marked `escalate`, needs `human:` with the user's own words, or a fix that clears it when `review` runs again. `review` lists the escalations: the agent asks the user about each one, with its recommendation, and records the answer. A fail verdict with no blocking finding counts as one finding, `<name>/verdict`. A reviewer that exits non-zero or writes no valid result blocks `land` until it completes.

**The reviewer contract.** The engine runs each command with:

| Variable | Value |
|---|---|
| `WORKBENCH_REVIEWER`, `WORKBENCH_TASK` | The reviewer's and the task's names |
| `WORKBENCH_ROOT`, `WORKBENCH_WORKTREE`, `WORKBENCH_TASK_DIR` | The primary checkout, the task's worktree (the command's directory), the task's evidence directory |
| `WORKBENCH_BASE`, `WORKBENCH_TREE` | The base commit and the checked tree; `git diff $WORKBENCH_BASE $WORKBENCH_TREE` is the change, untracked files included |
| `WORKBENCH_PLAN`, `WORKBENCH_QA`, `WORKBENCH_RECEIPT`, `WORKBENCH_CHANGED` | `plan.md`, `qa.md` (it may not exist), `receipt.json`, and a file listing the changed paths |
| `WORKBENCH_REVIEW_OUT` | Where to write the result |

The result is JSON: `{ "verdict": "pass" | "fail", "summary": "…", "findings": [{ "id": "F1", "severity": "blocking" | "recommendation", "escalate": false, "title": "…", "detail": "…", "evidence": "file:line" }] }`. Output and errors go to `reviews/<name>.log`, the result to `reviews/<name>.json`.

**The Claude runner.** `scripts/claude-review.mjs` runs `claude -p` restricted to Read, Grep and Glob inside the worktree, with no settings files, MCP servers or saved session, and asks for that JSON by schema. `--prompt` is the reviewer's instructions (absolute, or relative to the repository root); `--model` and `--effort` pass through; `--with` picks what it is given from `acceptance` (the plan's objective and Acceptance, never its Steps), `plan`, `diff`, `changed`, `qa` and `receipt` (default `acceptance,diff`); `--max-diff` cuts a long diff (default 300000 characters); `--add-dir a,b` lets it also read those directories (name the ones it needs, never a parent of the task's evidence); `--include f,g` adds those files' content to its prompt, for context a wrapper script computed first. It never gives the author's `review.md`. The two shipped prompts:

- `reviewers/task.md`: a blind technical review of the change against its acceptance: correctness, tests, scope and safety.
- `reviewers/qa.md`: a check that the author did QA and recorded evidence for it. It does no QA itself; each gap is a blocking finding that tells the implementer what to try and record.

A repository's own reviewers (its architecture rules, its cross-repository coverage) keep their prompts in the repository, or in `.workbench/` with a `.git/workbench.json` policy to keep them out of history.

## Pull request descriptions: pr.md

In `pr` mode, `pr.md` beside `plan.md` is the source of the PR's title and description:

```markdown
# feat(search): rank exact title matches first PROJ-29

## The technical spec
…
```

- **First line:** `# <title>`. The rest of the file is the description.
- **First land:** refuses before it commits or pushes anything until `pr.md` has a title and a description, then opens the PR from it; inside Claude Code it prints the `gh pr create` command instead, with the description in `pr-body.md` (`--body-file`).
- **Later lands and `sync`:** update the open PR's title and description only when `pr.md` has changed since the last sync, so an edit made on the forge survives until then.
- **Not in the tree:** `pr.md` lives with the task's evidence, so editing it never voids the receipt.

## Review rounds

A PR usually comes back with review comments, automated or human, and CI failures. Each round goes the same way:
1. Fix the code in the task's worktree. A separate fixer follows the same sequence.
2. Run `check`, then re-record the review in `review.md` (and run `review` again when reviewers are registered).
3. Run `land --message …` again. It commits, pushes and syncs `pr.md`.

If the PR branch has commits the worktree lacks, `land` merges them in first and stops at `branch-moved` with check and review to do again. Such commits come from a reviewer's suggestion committed on the forge, or from fixes pushed from another session.

A change to the description alone needs only an edit to `pr.md` and a `sync`.

A PR branch no one else has pushed to is the task's to rewrite. When the branch's remote tip is still the commit `land` last pushed, `land` pushes with `--force-with-lease` on that commit, so an amended commit or a rebase onto a moved base goes up as it is; git refuses the push if anyone pushes in between. Once someone else has pushed to it, `land` merges their commits in and pushes normally.

## Sessions and pull requests

In a Codex chat (`CODEX_THREAD_ID` is set), `land` pushes the branch and prints `prCommand`, a `gh pr create` command built from `pr.md`. Run that command and attach the returned URL with the Codex app's `attach_artifact` tool. Sibling repositories are pushed together with `--repo`; open and attach each repository's PR from its own chat when the app provides that workflow. Merge only with the repository's required authorization.

`adopt` registers an existing linked worktree regardless of where the app created it. Engine-created worktrees live at `.codex/worktrees/<name>`. App-owned worktree attachment and cleanup follow the current app's rules. If the app removes a worktree first, `status` reports `worktreeGone`; `land <name> --merged <sha>` or `abandon <name>` closes the record and keeps evidence.

## Upstream parity

The task engine, reviewer runner and prompts track [the Claude Workbench plugin](https://github.com/coadan/workbench-claude-plugin). `upstream.json` records the source revision. The Codex adaptations are its native manifest and hooks, `codex/` default branch prefix, `.codex/worktrees/` engine-created worktrees and PR attachment guidance. Existing linked worktrees and first-version Codex task metadata remain readable; checks and reviews must be renewed. `package.json` configuration remains a last fallback after `.workbench.json` and `.git/workbench.json`.

## Hooks

### Context

`SessionStart`, `UserPromptSubmit` and `SubagentStart` give the mode, the base and the active tasks: as plain output for `SessionStart`, and as `hookSpecificOutput.additionalContext` (`context --hook SubagentStart`) for the prompt and subagent hooks. Inside a task worktree they also give:
- the task's objective, branch and last check;
- its `plan.md`;
- the rule: check, review, then land only when authorised;
- a reminder to fill in the plan's front matter and `sync` while the objective is still the placeholder.

In a linked worktree that is not a task yet, such as a new desktop-app session, they name its branch and ask for `adopt`, then the front matter and `sync`, before editing and before the first push.

Nothing is printed in a repository without a policy.

## Development

This repository uses its own policy (`.workbench.json`, local mode). Run the tests with:

```bash
node --test tests/*.test.mjs
```

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

[MIT](LICENSE)
