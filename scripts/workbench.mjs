import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mainContext } from "./context.mjs";
import { configuration } from "./configuration.mjs";
import { run as engine } from "./engine.mjs";

export function repository(cwd = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return;
  const root = result.stdout.trim();
  return root;
}

export function inspect(cwd = process.cwd()) {
  const root = repository(cwd);
  if (!root) return;
  return { root, ...configuration(root) };
}

export function run(args, cwd = process.cwd()) {
  const state = inspect(cwd);
  if (args[0] === "inspect") {
    if (state) console.log(JSON.stringify(state, null, 2));
    else console.error("Run inside a Git repository.");
    return state ? 0 : 1;
  }
  if (args[0] === "context") {
    if (state?.configured) console.log(mainContext(state.root, state));
    return 0;
  }
  if (!state) {
    console.error("Run inside a Git repository.");
    return 1;
  }
  if (state.taskEngine) {
    const result = spawnSync(
      process.execPath,
      [path.join(state.root, "tools/workbench.mjs"), ...args],
      { cwd: state.root, stdio: "inherit", env: process.env },
    );
    if (result.error) console.error(result.error.message);
    return result.status ?? 1;
  }
  const result = engine(args, { cwd: state.root });
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
