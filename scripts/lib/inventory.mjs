// `agentprime inventory`: lockfiles -> installed packages with direct, dev and via, and for npm packages bundled.
// See scripts/CONTRACT.md. Owner: core. Reads lockfiles and manifests only; never vendor/ or node_modules/.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appAt, toPosix } from "./apps.mjs";
import { resolvePaths } from "./args.mjs";
import { composerLockEntries, packageLockEntries } from "./lockfiles.mjs";
import { compare } from "./semver.mjs";
import { clientImports } from "./usages.mjs";

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The parsing itself lives in lockfiles.mjs (browser-safe, one implementation for the CLI, the site and the
// service); these wrappers add the inventory's Package fields.

/** parseComposerLock(lockText, composerJsonText) -> Package[] (lockfile "composer.lock"). composerJsonText may be null. */
export function parseComposerLock(lockText, composerJsonText) {
  return composerLockEntries(lockText, composerJsonText).map((e) => ({
    ecosystem: "Packagist",
    name: e.name,
    version: e.version,
    lockfile: "composer.lock",
    direct: e.direct ?? false,
    dev: e.dev,
    via: e.via ?? [],
  }));
}

export class UnsupportedLockfileError extends Error {}

/**
 * parsePackageLock(lockText) -> Package[] (lockfile "package-lock.json"). lockfileVersion 2 or 3 only: version 1
 * does not record which packages the root requires, so `direct` and `via` can't be given (lockfiles.mjs reads it
 * without them).
 */
export function parsePackageLock(lockText) {
  const lock = JSON.parse(lockText);
  if (!lock.packages || typeof lock.packages !== "object" || !(lock.lockfileVersion >= 2)) {
    throw new UnsupportedLockfileError(
      `package-lock.json lockfileVersion ${lock.lockfileVersion ?? "unknown"} not supported (needs 2 or 3)`,
    );
  }
  return packageLockEntries(lock).map((e) => ({
    ecosystem: "npm",
    name: e.name,
    version: e.version,
    lockfile: "package-lock.json",
    direct: e.direct,
    dev: e.dev,
    via: e.via,
  }));
}

// ---------------------------------------------------------------- Inventory

export function comparePackages(a, b) {
  return (
    byName(a.ecosystem, b.ecosystem) ||
    byName(a.name, b.name) ||
    compare(a.version, b.version) ||
    byName(a.lockfile, b.lockfile) ||
    byName(a.via.join("\u0000"), b.via.join("\u0000"))
  );
}

/**
 * readInventory(appDir, { cwd }) -> { app, packages, warnings? }
 * appDir is resolved against process.cwd() when relative. `app.path` is relative to `cwd` (the Repository root,
 * default process.cwd()). Throws when appDir holds no lockfile.
 */
export function readInventory(appDir, { cwd = process.cwd() } = {}) {
  const app = appAt(appDir, cwd);
  if (!app) throw new Error(`No lockfile in ${toPosix(relative(cwd, appDir)) || "."}`);
  const read = (name) => (existsSync(join(appDir, name)) ? readFileSync(join(appDir, name), "utf8") : null);
  const packages = [];
  const warnings = [];

  for (const lockfile of app.lockfiles) {
    if (lockfile === "composer.lock") {
      const manifest = read("composer.json");
      if (manifest === null) warnings.push("composer.json not found; direct and via unknown for composer.lock");
      packages.push(...parseComposerLock(read(lockfile), manifest));
    } else if (lockfile === "package-lock.json") {
      try {
        packages.push(...parsePackageLock(read(lockfile)));
      } catch (err) {
        if (!(err instanceof UnsupportedLockfileError)) throw err;
        warnings.push(err.message);
      }
    } else {
      warnings.push(`${lockfile} not supported yet`);
    }
  }

  // `dev` says devDependencies, not "not shipped": a bundler puts whatever client code imports into the browser
  // build. `bundled` says the App's client source imports the package (npm only; read, never run).
  const npm = packages.filter((p) => p.ecosystem === "npm");
  if (npm.length) {
    const imported = clientImports(appDir, new Set(npm.map((p) => p.name)));
    for (const p of npm) p.bundled = imported.has(p.name);
  }

  packages.sort(comparePackages);
  return warnings.length ? { app, packages, warnings } : { app, packages };
}

export async function run(args) {
  const { cwd, appDir } = resolvePaths(args.flags);
  return readInventory(appDir, { cwd });
}
