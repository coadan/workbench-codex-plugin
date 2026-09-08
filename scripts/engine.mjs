import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { validatePlan, validateReview } from "./policy.mjs";
import { configuration } from "./configuration.mjs";

const help = `Workbench tasks

  workbench sync                         Fetch, synchronize, and show recent main commits
  workbench start <name> --objective <text> --scope <path> [--scope <path> ...]
  workbench status [name]                Show local task state
  workbench check [name]                 Verify the current task against fresh main
  workbench land [name] --message <text> Verify and deliver using repository mode
  workbench land [name] --merged <sha>   Close a squash/rebase-merged PR after patch verification

Run sync before work and after returning to an existing task. Start writes the
plan under .workbench/tasks/<name>/plan.md. Fill its Objective, Steps, and
Acceptance sections before implementation; mark completed items before landing.
Inside the worktree, commands infer the task. Check reports the selected lanes
and writes receipt.json. Record actual local review in review.md with:

Tree: <receipt tree>
Base: <receipt base>
Result: pass

<findings, resolution, and remaining limitations>

Configure .workbench.json or package.json workbench with mode local, direct, or
pr; branch and remote default to main and origin. Register command arrays in
hooks.prepare and hooks.check. Local mode uses Git without contacting a remote;
direct mode pushes to the base branch; PR mode pushes only the task branch.

Land checkpoints scoped changes, integrates current main, and verifies again.
Changed content or base requires fresh review. Retry after resolving conflicts,
review findings, or push failures. Task files and worktrees remain until remote
and local main contain the landed commit and agree with a fresh remote readback.
`;

function command(cwd, executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${executable} ${args.join(" ")} failed:\n${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  return (result.stdout || "").trimEnd();
}
const git = (cwd, ...args) => command(cwd, "git", args);
const json = (filename) => JSON.parse(fs.readFileSync(filename, "utf8"));
function write(filename, value) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(temp, filename);
}
function context(cwd) {
  const checkout = git(cwd, "rev-parse", "--show-toplevel");
  const common = git(
    cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  if (path.basename(common) !== ".git")
    throw new Error("Use a repository with a primary working directory.");
  const root = path.dirname(common);
  const state = path.join(root, ".workbench");
  const config = configuration(checkout);
  if (!config.mode)
    throw new Error(
      "Set workbench mode to local, direct, or pr before starting work.",
    );
  git(root, "check-ref-format", `refs/heads/${config.branch}`);
  return {
    root,
    checkout,
    state,
    ...config,
    mainRef:
      config.mode === "local"
        ? `refs/heads/${config.branch}`
        : `refs/remotes/${config.remote}/${config.branch}`,
  };
}
function ignoreLocal(ctx) {
  const filename = path.join(ctx.root, ".git", "info", "exclude");
  const source = fs.existsSync(filename)
    ? fs.readFileSync(filename, "utf8")
    : "";
  const missing = ["/.workbench/"].filter(
    (line) => !source.split("\n").includes(line),
  );
  if (missing.length)
    fs.appendFileSync(filename, "\n" + missing.join("\n") + "\n");
}
function lock(ctx, action) {
  fs.mkdirSync(ctx.state, { recursive: true });
  const filename = path.join(ctx.state, "operation.lock");
  const value = { pid: process.pid, host: os.hostname(), nonce: randomUUID() };
  try {
    fs.writeFileSync(filename, JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner;
    try {
      owner = json(filename);
    } catch {
      throw new Error(`Inspect incomplete lock ${filename} before retrying.`);
    }
    if (owner.host !== os.hostname())
      throw new Error(`Another host owns ${filename}.`);
    try {
      process.kill(owner.pid, 0);
    } catch (probe) {
      if (probe.code !== "ESRCH") throw probe;
      throw new Error(
        `Stale operation lock ${filename}. Confirm its operation ended, remove the lock, and retry.`,
      );
    }
    throw new Error(`Workbench operation ${owner.pid} is running.`);
  }
  try {
    return action();
  } finally {
    if (fs.existsSync(filename) && json(filename).nonce === value.nonce)
      fs.unlinkSync(filename);
  }
}
function fetchMain(ctx) {
  if (ctx.mode !== "local")
    git(
      ctx.root,
      "fetch",
      ctx.remote,
      `+refs/heads/${ctx.branch}:${ctx.mainRef}`,
    );
  return git(ctx.root, "rev-parse", ctx.mainRef);
}
function recent(ctx) {
  return git(ctx.root, "log", "-5", "--format=%h %s", ctx.mainRef).split("\n");
}
function ancestor(cwd, older, newer) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", older, newer],
    { cwd },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("Unable to establish Git ancestry.");
}
function clean(cwd) {
  return git(cwd, "status", "--porcelain=v1", "--untracked-files=all") === "";
}
function assertMain(ctx) {
  if (git(ctx.root, "branch", "--show-current") !== ctx.branch)
    throw new Error("The primary checkout must be on main.");
  if (!clean(ctx.root))
    throw new Error(
      "Preserve and resolve primary checkout changes before synchronizing main.",
    );
  if (!ancestor(ctx.root, "HEAD", ctx.mainRef))
    throw new Error(
      "Primary main has unpublished commits; reconcile them before synchronizing.",
    );
}
function assertBranch(task) {
  if (git(task.path, "branch", "--show-current") !== task.branch)
    throw new Error("Task worktree is on a different branch.");
  if (
    fs.existsSync(
      git(
        task.path,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "rebase-merge",
      ),
    ) ||
    fs.existsSync(
      git(
        task.path,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "rebase-apply",
      ),
    )
  )
    throw new Error(
      "Resolve the task rebase and run git rebase --continue before retrying.",
    );
}
function taskAt(ctx, name) {
  name ||= path
    .relative(path.join(ctx.state, "tasks"), ctx.checkout)
    .split(path.sep)[0];
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name || ""))
    throw new Error("Specify a task name or run inside its worktree.");
  const directory = path.join(ctx.state, "tasks", name);
  if (!fs.existsSync(path.join(directory, "task.json")))
    throw new Error(
      `Task ${name} is not registered. Start a task from the primary checkout.`,
    );
  const task = json(path.join(directory, "task.json"));
  if (
    task.path !== path.join(ctx.state, "tasks", name, "repo") ||
    task.branch !== `codex/${name}`
  )
    throw new Error("Task identity differs from the owning repository.");
  return { task, directory };
}
function readPlan(directory, complete = false) {
  validatePlan(
    fs.readFileSync(path.join(directory, "plan.md"), "utf8"),
    complete,
  );
}
function scoped(task, paths) {
  const outside = paths.filter(
    (file) =>
      !task.scopes.some(
        (scope) => file === scope || file.startsWith(scope + "/"),
      ),
  );
  if (outside.length)
    throw new Error(`Changes outside task scope: ${outside.join(", ")}`);
}
function snapshot(task, base) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-index-"));
  const env = { GIT_INDEX_FILE: path.join(temporary, "index") };
  try {
    command(task.path, "git", ["read-tree", "HEAD"], { env });
    command(task.path, "git", ["add", "-A", "--", "."], { env });
    command(task.path, "git", ["diff", "--cached", "--check", base], { env });
    const tree = command(task.path, "git", ["write-tree"], { env });
    const paths = command(
      task.path,
      "git",
      ["diff", "--name-only", "--no-renames", "-z", base, tree],
      { env },
    )
      .split("\0")
      .filter(Boolean);
    scoped(task, paths);
    return { tree, paths, head: git(task.path, "rev-parse", "HEAD"), base };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
function packageAt(task, revision) {
  try {
    return JSON.parse(git(task.path, "show", `${revision}:package.json`));
  } catch {
    return {};
  }
}
function verify(ctx, task, directory, base) {
  assertBranch(task);
  readPlan(directory);
  if (!ancestor(task.path, base, "HEAD"))
    throw new Error(
      "Main advanced. Run task sync with a clean checkpoint, or task land to checkpoint and rebase.",
    );
  const state = snapshot(task, base);
  if (!state.paths.length)
    throw new Error("Task has no changes relative to current main.");
  const pkg = packageAt(task, state.tree);
  const workspace = {};
  if (state.paths.includes("pnpm-workspace.yaml")) {
    try {
      workspace.before = git(task.path, "show", `${base}:pnpm-workspace.yaml`);
      workspace.after = git(
        task.path,
        "show",
        `${state.tree}:pnpm-workspace.yaml`,
      );
    } catch {
      /* Creation or deletion uses the full dependency checks. */
    }
  }
  const commands = ctx.selectChecks
    ? ctx
        .selectChecks(state.paths, packageAt(task, base), pkg, workspace)
        .map((name) => {
          if (!pkg.scripts?.[name])
            throw new Error(`Required verification script ${name} is missing.`);
          return {
            name,
            command: ["pnpm", "run", name],
            script: pkg.scripts[name],
          };
        })
    : ctx.hooks.check;
  if (
    !commands.length &&
    state.paths.some((file) => !file.endsWith(".md") && file !== ".gitignore")
  )
    throw new Error(
      "Register at least one verification command in workbench hooks.check.",
    );
  const checks = commands.map((item) => item.name);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ ...state, commands }))
    .digest("hex");
  const receiptFile = path.join(directory, "receipt.json");
  let previous;
  try {
    previous = json(receiptFile);
  } catch {
    /* First check. */
  }
  if (previous?.fingerprint === fingerprint && previous.ok)
    return { ...previous, reused: true };
  fs.rmSync(receiptFile, { force: true });
  for (const { name, command: argv } of commands) {
    const logfile = path.join(directory, `${name.replaceAll(":", "-")}.log`);
    const fd = fs.openSync(logfile, "w", 0o600);
    console.error(`Checking ${name}; log: ${logfile}`);
    let result;
    try {
      result = spawnSync(argv[0], argv.slice(1), {
        cwd: task.path,
        stdio: ["ignore", fd, fd],
        env: {
          ...process.env,
          PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
          pnpm_config_verify_deps_before_run: "false",
        },
      });
    } finally {
      fs.closeSync(fd);
    }
    if (result.error || result.status !== 0)
      throw new Error(`Verification ${name} failed; inspect ${logfile}.`);
    const after = snapshot(task, base);
    if (after.tree !== state.tree || after.head !== state.head)
      throw new Error(
        "Verification changed repository content; inspect changes and check again.",
      );
  }
  const receipt = {
    ...state,
    checks,
    fingerprint,
    ok: true,
    checkedAt: new Date().toISOString(),
  };
  write(receiptFile, receipt);
  return receipt;
}
function start(ctx, name, flags) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name || ""))
    throw new Error(
      "Use a lowercase task name with letters, digits, and hyphens.",
    );
  if (!flags.objective?.trim() || !flags.scope?.length)
    throw new Error("Provide --objective and at least one --scope.");
  const scopes = flags.scope.map((scope) => {
    const normalized = scope.replace(/\/$/, "");
    if (
      !normalized ||
      path.isAbsolute(normalized) ||
      normalized
        .split("/")
        .some((part) =>
          ["..", ".", ".git", ".workbench", ".worktrees"].includes(part),
        )
    )
      throw new Error(`Use a confined repository-relative scope: ${scope}`);
    return normalized;
  });
  const directory = path.join(ctx.state, "tasks", name);
  const target = path.join(ctx.state, "tasks", name, "repo");
  if (fs.existsSync(directory) || fs.existsSync(target))
    throw new Error("Task name or worktree already exists.");
  const base = fetchMain(ctx);
  assertMain(ctx);
  git(ctx.root, "merge", "--ff-only", base);
  git(ctx.root, "worktree", "add", "-b", `codex/${name}`, target, base);
  fs.mkdirSync(directory, { recursive: true });
  const task = {
    name,
    path: target,
    branch: `codex/${name}`,
    scopes,
    objective: flags.objective,
    phase: "active",
    mode: ctx.mode,
    createdAt: new Date().toISOString(),
    startBase: base,
  };
  write(path.join(directory, "task.json"), task);
  fs.writeFileSync(
    path.join(directory, "plan.md"),
    `# ${name}\n\n## Objective\n${flags.objective}\n\n## Steps\n- [ ] TODO: describe the implementation step\n\n## Acceptance\n- [ ] TODO: describe observable success\n`,
    { mode: 0o600 },
  );
  for (const hook of ctx.hooks.prepare)
    command(target, hook.command[0], hook.command.slice(1));
  return {
    ...task,
    plan: path.join(directory, "plan.md"),
    recent: recent(ctx),
  };
}
function sync(ctx) {
  const base = fetchMain(ctx);
  if (ctx.checkout === ctx.root) {
    assertMain(ctx);
    git(ctx.root, "merge", "--ff-only", base);
  } else {
    const { task } = taskAt(ctx);
    assertBranch(task);
    if (!ancestor(task.path, base, "HEAD")) {
      if (!clean(task.path))
        throw new Error(
          "Main advanced; checkpoint task changes before sync, or use task land to checkpoint and rebase.",
        );
      if (ctx.mode === "pr" && task.landing?.submitted)
        git(task.path, "merge", "--no-edit", base);
      else git(task.path, "rebase", base);
    }
  }
  return { base, checkout: ctx.checkout, recent: recent(ctx) };
}
function finish(ctx, task, directory) {
  const candidate = task.landing.mergedCommit || task.landing.commit;
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = fetchMain(ctx);
    if (!ancestor(ctx.root, candidate, base))
      throw new Error(
        "Remote main does not contain the verified landing commit.",
      );
    assertMain(ctx);
    if (fs.existsSync(task.path)) {
      const detachedMerged =
        task.landing.mergedCommit &&
        git(task.path, "branch", "--show-current") === "";
      if (detachedMerged) {
        if (
          git(task.path, "rev-parse", task.branch) !== task.landing.commit ||
          !ancestor(task.path, "HEAD", base)
        )
          throw new Error(
            "Preserve unexpected task state before retrying merged PR cleanup.",
          );
      } else assertBranch(task);
      if (!clean(task.path))
        throw new Error(
          "Landing is pushed; preserve new task changes before cleanup.",
        );
      if (task.landing.mergedCommit) {
        if (
          !detachedMerged &&
          git(task.path, "rev-parse", "HEAD") !== task.landing.commit
        )
          throw new Error(
            "Preserve new task commits before closing the merged PR.",
          );
        git(task.path, "checkout", "--detach", base);
      } else git(task.path, "merge", "--ff-only", base);
    }
    git(ctx.root, "merge", "--ff-only", base);
    const remote =
      ctx.mode === "local"
        ? git(ctx.root, "rev-parse", ctx.mainRef)
        : git(
            ctx.root,
            "ls-remote",
            "--exit-code",
            ctx.remote,
            `refs/heads/${ctx.branch}`,
          ).split(/\s/)[0];
    if (remote !== base) continue;
    if (git(ctx.root, "rev-parse", "HEAD") !== base)
      throw new Error("Primary main moved during landing. Retry.");
    task.landing.observedMain = base;
    write(path.join(directory, "task.json"), task);
    if (fs.existsSync(task.path))
      git(ctx.root, "worktree", "remove", task.path);
    // Keep the branch as an inexpensive recovery reference; only the clean checkout is removed.
    task.phase = "closed";
    task.closedAt = new Date().toISOString();
    write(path.join(directory, "task.json"), task);
    return {
      name: task.name,
      phase: task.phase,
      commit: candidate,
      main: base,
      recent: recent(ctx),
    };
  }
  throw new Error(
    "Main kept advancing during readback. Landing is retained; retry to synchronize and close.",
  );
}
function land(ctx, task, directory, message, merged) {
  if (task.phase === "closed") return task;
  const base = fetchMain(ctx);
  if (
    task.landing?.mergedCommit &&
    ancestor(ctx.root, task.landing.mergedCommit, base)
  )
    return finish(ctx, task, directory);
  if (merged) {
    if (ctx.mode !== "pr" || !task.landing?.submitted)
      throw new Error("Use --merged only after submitting a PR task.");
    const mergeCommit = git(
      ctx.root,
      "rev-parse",
      "--verify",
      `${merged}^{commit}`,
    );
    if (!ancestor(ctx.root, mergeCommit, base))
      throw new Error("The merge commit must be on current main.");
    const patchId = (from, to) =>
      command(ctx.root, "git", ["patch-id", "--stable"], {
        input: git(ctx.root, "diff", "--binary", from, to),
      }).split(/\s/)[0];
    if (
      patchId(task.landing.base, task.landing.commit) !==
      patchId(`${mergeCommit}^1`, mergeCommit)
    )
      throw new Error(
        "Merge patch differs from the reviewed task; inspect the forge result before closing.",
      );
    task.landing.mergedCommit = mergeCommit;
    write(path.join(directory, "task.json"), task);
    return finish(ctx, task, directory);
  }
  if (task.landing?.commit && ancestor(ctx.root, task.landing.commit, base))
    return finish(ctx, task, directory);
  assertMain(ctx);
  assertBranch(task);
  readPlan(directory, true);
  if (!message?.trim())
    throw new Error("Provide --message for the task checkpoint.");
  // Compare scope against the task merge base, before upstream changes are integrated.
  snapshot(task, git(task.path, "merge-base", "HEAD", base));
  if (!clean(task.path)) {
    git(task.path, "add", "-A", "--", ".");
    git(task.path, "commit", "-m", message);
  }
  if (ctx.mode === "pr" && task.landing?.submitted)
    git(task.path, "merge", "--no-edit", base);
  else git(task.path, "rebase", base);
  const receipt = verify(ctx, task, directory, base);
  const reviewFile = path.join(directory, "review.md");
  if (!fs.existsSync(reviewFile))
    throw new Error(
      `Review the checked state and write ${reviewFile} (Tree: ${receipt.tree}, Base: ${base}, Result: pass).`,
    );
  validateReview(fs.readFileSync(reviewFile, "utf8"), receipt);
  if (!clean(task.path))
    throw new Error(
      "Task changed after verification. Check and review the new state.",
    );
  const fresh = fetchMain(ctx);
  if (fresh !== base)
    throw new Error(
      "Main advanced during verification. Retry landing to rebase, check, and review the new state.",
    );
  const current = snapshot(task, base);
  if (current.tree !== receipt.tree || current.head !== receipt.head)
    throw new Error("Task changed after verification.");
  task.landing = {
    commit: receipt.head,
    base,
    tree: receipt.tree,
    submitted: task.landing?.submitted || false,
  };
  write(path.join(directory, "task.json"), task);
  if (ctx.mode === "pr") {
    git(
      task.path,
      "push",
      ctx.remote,
      `${receipt.head}:refs/heads/${task.branch}`,
    );
    task.landing.submitted = true;
    write(path.join(directory, "task.json"), task);
    return {
      name: task.name,
      phase: "awaiting-pr",
      branch: task.branch,
      commit: receipt.head,
      next: "Open or update the forge PR. After merge, run land again; pass --merged <merge-sha> for a squash or rebase merge.",
    };
  }
  if (ctx.mode === "local") git(ctx.root, "merge", "--ff-only", receipt.head);
  else
    git(
      task.path,
      "push",
      ctx.remote,
      `${receipt.head}:refs/heads/${ctx.branch}`,
    );
  return finish(ctx, task, directory);
}
export function run(argv, { cwd = process.cwd(), selectChecks } = {}) {
  const [operation, ...args] = argv;
  if (
    !operation ||
    ["help", "--help", "-h"].includes(operation) ||
    args.includes("--help")
  ) {
    console.log(help);
    return;
  }
  const flags = {};
  let name;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (
        !["scope", "objective", "message", "merged"].includes(key) ||
        !args[i + 1] ||
        args[i + 1].startsWith("--")
      )
        throw new Error(`Invalid option ${args[i]}.`);
      const value = args[++i];
      if (key === "scope") (flags.scope ||= []).push(value);
      else flags[key] = value;
    } else if (!name) name = args[i];
    else throw new Error("Specify one task name.");
  }
  if (!["sync", "start", "status", "check", "land"].includes(operation))
    throw new Error(`Unknown task command ${operation}.`);
  const ctx = context(cwd);
  ctx.selectChecks = selectChecks;
  if (operation === "status") {
    if (!name && ctx.checkout === ctx.root) {
      const parent = path.join(ctx.state, "tasks");
      return {
        tasks: fs.existsSync(parent)
          ? fs
              .readdirSync(parent)
              .map((entry) => json(path.join(parent, entry, "task.json")))
              .filter((task) => task.phase === "active")
          : [],
      };
    }
    const { task, directory } = taskAt(ctx, name);
    return {
      ...task,
      directory,
      dirty: fs.existsSync(task.path) ? !clean(task.path) : false,
    };
  }
  ignoreLocal(ctx);
  return lock(ctx, () => {
    if (operation === "sync") return sync(ctx);
    if (operation === "start") return start(ctx, name, flags);
    const { task, directory } = taskAt(ctx, name);
    if (task.mode && task.mode !== ctx.mode)
      throw new Error(
        "Task delivery mode changed; reconcile the task policy before continuing.",
      );
    if (operation === "land")
      return land(ctx, task, directory, flags.message, flags.merged);
    if (task.phase !== "active") throw new Error("Select an active task.");
    const base = fetchMain(ctx);
    const receipt = verify(ctx, task, directory, base);
    if (fetchMain(ctx) !== base) {
      fs.rmSync(path.join(directory, "receipt.json"), { force: true });
      throw new Error(
        "Main advanced during verification. Sync and check again.",
      );
    }
    return receipt;
  });
}
