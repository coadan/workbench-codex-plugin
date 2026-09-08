import fs from "node:fs";
import path from "node:path";

export function configuration(root) {
  const standalone = path.join(root, ".workbench.json");
  const pkgFile = path.join(root, "package.json");
  const pkg = fs.existsSync(pkgFile)
    ? JSON.parse(fs.readFileSync(pkgFile, "utf8"))
    : {};
  const source = fs.existsSync(standalone)
    ? JSON.parse(fs.readFileSync(standalone, "utf8"))
    : pkg.workbench;
  const config = source || {};
  if (config.mode && !["local", "direct", "pr"].includes(config.mode))
    throw new Error("Workbench mode must be local, direct, or pr.");
  const hooks = {};
  for (const phase of ["prepare", "check"]) {
    hooks[phase] = config.hooks?.[phase] || [];
    if (!Array.isArray(hooks[phase]))
      throw new Error(`hooks.${phase} must be an array.`);
    const names = new Set();
    for (const hook of hooks[phase]) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(hook.name || "") ||
        names.has(hook.name) ||
        !Array.isArray(hook.command) ||
        !hook.command.length ||
        hook.command.some((arg) => typeof arg !== "string") ||
        !hook.command[0]
      ) {
        throw new Error(
          `Each hooks.${phase} entry needs a unique name and a nonempty command argument array.`,
        );
      }
      names.add(hook.name);
    }
  }
  const branch = config.branch || "main";
  const remote = config.remote || "origin";
  if (
    typeof branch !== "string" ||
    typeof remote !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)
  )
    throw new Error("Use a branch name and a valid configured remote name.");
  return {
    mode: config.mode,
    branch,
    remote,
    hooks,
    configured: Boolean(source),
    taskEngine:
      pkg.scripts?.task === "node tools/workbench.mjs" &&
      fs.existsSync(path.join(root, "tools/workbench.mjs")),
  };
}
