// `agentprime apps`: every directory holding a lockfile is an App. See scripts/CONTRACT.md. Owner: core.
import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { resolvePaths } from "./args.mjs";

export const LOCKFILES = {
  "composer.lock": "Packagist",
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "npm",
  "yarn.lock": "npm",
};

// Directory names skipped anywhere, and multi-segment paths skipped wherever they occur.
export const SKIP_NAMES = new Set(["vendor", "node_modules", ".git", "storage", "dist", "build", ".agentprime"]);
export const SKIP_PATHS = ["bootstrap/cache", "public/build"];

/** isSkippedDir(relPosixPath) -> true if the directory, relative to any root, must never be entered. */
export function isSkippedDir(relPosix) {
  const parts = relPosix.split("/").filter((p) => p && p !== ".");
  if (parts.length === 0) return false;
  if (SKIP_NAMES.has(parts.at(-1))) return true;
  const tail = parts.join("/");
  return SKIP_PATHS.some((p) => tail === p || tail.endsWith("/" + p));
}

export const toPosix = (p) => p.split(sep).join("/");

/** The App rooted at `dir` (lockfiles directly inside it), or null when it has none. `path` is relative to `cwd`. */
export function appAt(dir, cwd = dir) {
  const lockfiles = Object.keys(LOCKFILES)
    .filter((name) => existsSync(join(dir, name)))
    .sort();
  if (lockfiles.length === 0) return null;
  const ecosystems = [...new Set(lockfiles.map((l) => LOCKFILES[l]))].sort();
  return { path: toPosix(relative(cwd, dir)) || ".", lockfiles, ecosystems };
}

/** findApps(cwd) -> App[], sorted by path with "." first. Symlinked directories are not followed. */
export function findApps(cwd) {
  const apps = [];
  const walk = (dir) => {
    const app = appAt(dir, cwd);
    if (app) apps.push(app);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (isSkippedDir(toPosix(relative(cwd, child)))) continue;
      walk(child);
    }
  };
  walk(cwd);
  return apps.sort((a, b) => (a.path === "." ? -1 : b.path === "." ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function run(args) {
  const { cwd } = resolvePaths(args.flags);
  if (!existsSync(cwd)) throw new Error(`No such directory: ${cwd}`);
  return { apps: findApps(cwd) };
}
