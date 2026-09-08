# Workbench plugin development

This repository owns the portable task engine, Codex hook integration, workflow skill, and distribution metadata. Repository-specific product checks belong in the consuming repository.

Before work, inspect Git status, run `node scripts/workbench.mjs sync`, and read the recent commits. Follow [the Workbench skill](skills/workbench/SKILL.md). This repository uses local delivery; create task checkouts beside their plans under `.workbench/tasks/<name>/repo` and land verified work into local `main`.

Run the checks registered in `.workbench.json`. Tests must use isolated local repositories and preserve the no-network contract of local mode. Keep hook commands as argument arrays; repository hooks own their additional tool requirements. Update the skill and README when changing the public configuration or CLI contract. Report checks and the landed commit.
