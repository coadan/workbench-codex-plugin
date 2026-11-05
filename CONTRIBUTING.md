# Contributing

Keep changes focused and explain the problem, the resulting behavior and how you
checked it. Open an issue for a substantial change to the configuration, CLI or
delivery contract before building it. Small fixes and documentation improvements
can go straight to a PR.

Read [AGENTS.md](AGENTS.md) for the repository's boundaries and
[the Workbench skill](skills/workbench/SKILL.md) for the workflow it teaches.

## Work locally

Requires Node.js 20+ and Git. The engine has no dependencies, so there is nothing
to install.

```sh
node --test tests/*.test.mjs
```

The complete suite is required before delivery. Tests build throwaway local
repositories and drive a fake `gh` (`tests/fake-gh.mjs`), so they never reach a
forge. Add a test that fails before the change for every bug fix, and regression
coverage for changes to the tree binding of receipts and reviews, branch naming,
delivery modes, `--repo` across repositories and pull request rounds.

The repository uses local Workbench delivery for agent tasks. Contributors can use
a normal branch and pull request. Do not commit `.workbench/` task evidence,
`.codex/worktrees/`, credentials or personal paths. Update the skill and the
README together when a command, flag or configuration key changes.

## Review

Describe why the change is needed, include the test run, and link any issue it
resolves. For a change in delivery behavior, say which modes (`local`, `direct`,
`pr`) it affects and how each was checked.
