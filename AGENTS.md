# Workbench for Codex

Use local Workbench delivery. Publish commits or releases only when the user asks.
See [contribution guidance](CONTRIBUTING.md) and [the Workbench skill](skills/workbench/SKILL.md).

- This repository owns the task engine, native Codex integration, reviewer runner, workflow skill and manifests. Product checks belong in the consuming repository.
- Before work, inspect Git status, run `node scripts/workbench.mjs sync` and read recent commits. Adopt an app-created linked worktree, or start one in `.codex/worktrees/<name>`; land verified work into local `main`.
- The engine has no dependencies and needs Node.js 20+ and Git. Keep it one file. Hook and check commands are argument arrays run without a shell.
- Tests use isolated local repositories and `tests/fake-gh.mjs`. Local mode never touches the network. Register every test file in `.workbench.json`.
- Update the skill and README when configuration, CLI or delivery changes. Keep upstream provenance in `upstream.json` current when porting behavior.
- Keep source, examples, tests and commits generic. Personal and client configuration belongs outside this repository.
- Report checks and the landed commit.
