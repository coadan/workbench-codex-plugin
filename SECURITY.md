# Security

Workbench is experimental software that runs with the permissions of the local
user. It is not a sandbox. The `prepare` and `check` hooks in a repository's
`.workbench.json` are commands the engine runs on `start`, `adopt` and `check`.
Review that file before running Workbench in a repository you did not write.

The session-start and subagent-start hooks only read: they print the policy and
the active tasks and run no repository commands. In `direct` and `pr` modes the
engine pushes with your Git credentials and opens pull requests with your `gh`
login; `local` mode makes no network calls.

Task evidence in `.workbench/tasks/<name>/` (check logs, receipts, reviews, PR
descriptions) can contain whatever your checks print. The engine keeps it out of
Git through `.git/info/exclude`; check it before sharing.

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/coadan/workbench-codex-plugin/security/advisories/new)
to report security problems. Include the affected revision, a minimal reproduction
and the impact. Do not include real credentials or private repository content in
public issues. Ordinary bugs can use the issue tracker.

Security fixes target the current `main` branch. There are no separately supported
release branches yet.
