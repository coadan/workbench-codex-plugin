# Workbench

Workbench gives coding agents a repeatable path from a scoped task to a verified Git landing. Each task has an isolated checkout, a small plan, test evidence, and a review tied to the exact content being delivered.

It supports three delivery policies: local development without a remote, direct pushes to a shared base branch, and pull requests through your forge. The engine runs with Node.js 24+ and Git. Your repository chooses its own languages, package managers, test tools, and forge integration.

The Codex plugin includes a workflow skill and lifecycle hooks that refresh branch context. The same engine can also run directly:

```sh
node /path/to/workbench-codex-plugin/scripts/workbench.mjs --help
```

## Repository configuration

Commit a `.workbench.json` file in the repository you want to manage. Node repositories can instead use a `workbench` object in `package.json`; `.workbench.json` takes precedence.

```json
{
  "mode": "direct",
  "branch": "main",
  "remote": "origin",
  "hooks": {
    "prepare": [
      { "name": "dependencies", "command": ["npm", "ci"] }
    ],
    "check": [
      { "name": "test", "command": ["npm", "test"] }
    ]
  }
}
```

Use the repository's actual commands. Command arrays preserve argument boundaries and execute without implicit shell expansion. To run a shell script, register an explicit command such as `["sh", "tools/check.sh"]`. Additional executables must be available in the environment where the repository runs.

- `mode` is required: `local`, `direct`, or `pr`. A forge remote alone does not select PR mode.
- `branch` defaults to `main`; `remote` defaults to `origin` and is unused in local mode.
- `hooks.prepare` runs after creating the task checkout and its state. A failing hook preserves the checkout for diagnosis; repair setup there before proceeding.
- `hooks.check` runs during verification, with output stored beside the task. Register at least one check for implementation changes. Checks that change source content invalidate verification.

A repository can expose `task: node tools/workbench.mjs` in its package scripts to supply a repository-owned adapter, for path-based check selection. The plugin delegates to that adapter when present; other repositories use the bundled engine directly.

## Working through a task

Run the CLI from the primary checkout to `sync`, read recent commits, then `start <name> --objective "<outcome>" --scope <path>`. Repeat `--scope` for additional paths. Fill the generated plan, work in the returned checkout, and run `check`. Review the complete diff and write the receipt's `Tree` and `Base` with `Result: pass` and actual findings into `review.md`.

`land --message "<change>"` checkpoints pending changes, integrates the current base, and requires matching checks and review. Local mode integrates locally. Direct mode pushes the base branch. PR mode pushes only the task branch and preserves the task while the agent follows your forge's review process. After merge, run `land` again; `land --merged <sha>` verifies patch equivalence for squash/rebase merges before closing.

```text
.workbench/
  operation.lock
  tasks/
    improve-search/
      repo/
      task.json
      plan.md
      receipt.json
      review.md
      test.log
```

The coordinator ignores `.workbench/` through `.git/info/exclude`, so consumers do not need to edit their shared ignore rules. Landing removes only the clean checkout after successful readback; the task's evidence and recovery branch remain. Cooperating agents share a repository operation lock, and failures preserve task state for retry.

## Codex installation

Install this plugin through a Codex marketplace that points to this source. Trust its lifecycle hooks through `/hooks` in the Codex CLI, then start a new task to load its skill. Public marketplace publication is a separate distribution step; this source can be installed through a personal or team marketplace.

The source of truth is this repository. Consumers that need a checked-in engine can vendor a pinned snapshot and record its source commit, keeping their policy adapter separate.

## Development

Follow [the agent guide](AGENTS.md). This repository uses local Workbench delivery. Its registered tests use temporary Git repositories and exercise local landing, direct pushes, PR submission and merge readback, repository hooks, and installation from a standalone directory.
