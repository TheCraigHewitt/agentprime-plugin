// Lockfile parsers for every major ecosystem: lockfile text -> installed package names and versions, named as OSV
// expects them. Browser-safe: pure ESM, no `node:` imports, no fs, no network, no dependencies, so the same module
// runs in a browser (the file never leaves it), in Node and in a Cloudflare Worker. Nothing from a lockfile is ever
// executed. See scripts/CONTRACT.md "Lockfiles, versions and upgrade plans (browser-safe)". Owner: core.
//
// When a parser is unsure it says so in `warnings` and leaves the entry out rather than guess; text it can't read
// is rejected with an Error naming the format and line, never half-parsed.
import { normalise as composerNormalise } from "./semver.mjs";
import { compareVersions, isVersion } from "./versions.mjs";

// ================================================================ the supported formats

/**
 * Every format parseLockfile reads, with its OSV ecosystem. `files` are the names detectLockfile recognises;
 * `records` says which of direct/dev/via the format can give (see CONTRACT.md for exactly when).
 */
export const SUPPORTED = [
  { format: "composer.lock", ecosystem: "Packagist", files: ["composer.lock"], variants: ["Composer 1 and 2"], records: ["dev"] },
  { format: "package-lock.json", ecosystem: "npm", files: ["package-lock.json"], variants: ["lockfileVersion 1", "lockfileVersion 2", "lockfileVersion 3"], records: ["direct", "dev", "via"] },
  { format: "npm-shrinkwrap.json", ecosystem: "npm", files: ["npm-shrinkwrap.json"], variants: ["lockfileVersion 1", "lockfileVersion 2", "lockfileVersion 3"], records: ["direct", "dev", "via"] },
  { format: "pnpm-lock.yaml", ecosystem: "npm", files: ["pnpm-lock.yaml"], variants: ["lockfileVersion 5.x", "lockfileVersion 6.x", "lockfileVersion 9.x"], records: ["direct", "dev", "via"] },
  { format: "yarn.lock", ecosystem: "npm", files: ["yarn.lock"], variants: ["Yarn 1 (classic)", "Yarn 2+ (Berry)"], records: [] },
  { format: "bun.lock", ecosystem: "npm", files: ["bun.lock"], variants: ["text lockfile (JSONC), lockfileVersion 0 and 1"], records: ["direct", "dev"] },
  { format: "requirements.txt", ecosystem: "PyPI", files: ["requirements.txt", "*requirements*.txt", "requirements/*.txt", "constraints.txt"], variants: ["pip requirements; exact == pins only"], records: [] },
  { format: "poetry.lock", ecosystem: "PyPI", files: ["poetry.lock"], variants: ["lock-version 1.x", "lock-version 2.x"], records: ["dev"] },
  { format: "uv.lock", ecosystem: "PyPI", files: ["uv.lock"], variants: ["version 1"], records: ["direct"] },
  { format: "Pipfile.lock", ecosystem: "PyPI", files: ["Pipfile.lock"], variants: ["pipfile-spec 6"], records: ["dev"] },
  { format: "Cargo.lock", ecosystem: "crates.io", files: ["Cargo.lock"], variants: ["version 1 to 4"], records: [] },
  { format: "go.sum", ecosystem: "Go", files: ["go.sum"], variants: ["go.sum"], records: [] },
  { format: "go.mod", ecosystem: "Go", files: ["go.mod"], variants: ["go.mod"], records: ["direct"] },
  { format: "Gemfile.lock", ecosystem: "RubyGems", files: ["Gemfile.lock", "gems.locked"], variants: ["Bundler 1 and 2"], records: ["direct"] },
  { format: "mix.lock", ecosystem: "Hex", files: ["mix.lock"], variants: ["mix.lock"], records: [] },
  { format: "packages.lock.json", ecosystem: "NuGet", files: ["packages.lock.json", "packages.<project>.lock.json"], variants: ["version 1", "version 2"], records: ["direct"] },
  { format: "gradle.lockfile", ecosystem: "Maven", files: ["gradle.lockfile", "*.lockfile"], variants: ["Gradle 6+ single lockfile", "per-configuration lockfiles"], records: [] },
];

const ECOSYSTEM_OF = Object.fromEntries(SUPPORTED.map((s) => [s.format, s.ecosystem]));

// ================================================================ detection

const baseName = (filename) => {
  const s = String(filename ?? "").replaceAll("\\", "/");
  // A browser saves a second download as "package-lock (1).json"; read it as the original name.
  return (s.slice(s.lastIndexOf("/") + 1) || "").replace(/ \(\d+\)(?=\.[^.]+$|$)/, "");
};

const BY_NAME = [
  [/^composer\.lock$/i, "composer.lock"],
  [/^package-lock\.json$/i, "package-lock.json"],
  [/^npm-shrinkwrap\.json$/i, "npm-shrinkwrap.json"],
  [/^pnpm-lock\.ya?ml$/i, "pnpm-lock.yaml"],
  [/^yarn\.lock$/i, "yarn.lock"],
  [/^bun\.lock$/i, "bun.lock"],
  [/^poetry\.lock$/i, "poetry.lock"],
  [/^uv\.lock$/i, "uv.lock"],
  [/^pipfile\.lock$/i, "Pipfile.lock"],
  [/^cargo\.lock$/i, "Cargo.lock"],
  [/^go\.sum$/i, "go.sum"],
  [/^go\.mod$/i, "go.mod"],
  [/^(gemfile\.lock|gems\.locked)$/i, "Gemfile.lock"],
  [/^mix\.lock$/i, "mix.lock"],
  [/^packages(\.[^/]+)?\.lock\.json$/i, "packages.lock.json"],
  [/^([\w.-]+-)?gradle\.lockfile$/i, "gradle.lockfile"],
  [/(requirements[^/]*|^constraints)\.txt$/i, "requirements.txt"],
];

function sniff(text) {
  const t = String(text ?? "").replace(/^﻿/, "");
  const head = t.trimStart();
  if (head.startsWith("{")) {
    let j;
    try {
      j = JSON.parse(stripJsonc(t));
    } catch {
      return null;
    }
    if (!j || typeof j !== "object") return null;
    if (j._meta && typeof j._meta === "object" && ("pipfile-spec" in j._meta || "sources" in j._meta)) return "Pipfile.lock";
    if ("content-hash" in j || "_readme" in j) return "composer.lock";
    if ("lockfileVersion" in j && j.workspaces && j.packages && Object.values(j.packages).every(Array.isArray)) return "bun.lock";
    if ("lockfileVersion" in j && (j.packages || j.dependencies)) return "package-lock.json";
    if (typeof j.version === "number" && j.dependencies && typeof j.dependencies === "object") {
      const tfms = Object.values(j.dependencies);
      if (tfms.length && tfms.every((d) => d && typeof d === "object" && Object.values(d).every((e) => e && typeof e === "object" && "type" in e))) return "packages.lock.json";
    }
    return null;
  }
  if (head.startsWith("%{")) return "mix.lock";
  if (/^# yarn lockfile v1\s*$/m.test(t) || /^__metadata:\s*$/m.test(t)) return "yarn.lock";
  if (/^lockfileVersion: /m.test(head.split("\n", 1)[0]) || /^---\r?\n(?:.*\r?\n)*?lockfileVersion: /.test(head)) return "pnpm-lock.yaml";
  if (/^# This file is automatically @generated by Cargo\./m.test(t)) return "Cargo.lock";
  if (/^# This file is automatically @generated by Poetry/m.test(t)) return "poetry.lock";
  if (/^\[\[package\]\]\s*$/m.test(t) && /^requires-python = /m.test(t) && /^version = \d+\s*$/m.test(t)) return "uv.lock";
  if (/^\[\[package\]\]\s*$/m.test(t) && /^source = "(registry|sparse|git)\+/m.test(t)) return "Cargo.lock";
  if (/^(GEM|GIT|PATH)\r?\n  remote: /m.test(t) && /^DEPENDENCIES\s*$/m.test(t)) return "Gemfile.lock";
  if (/^module\s+\S+/m.test(t) && /^(go|require)\s/m.test(t)) return "go.mod";
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && lines.every((l) => /^\S+ v\S+ h\d+:\S+$/.test(l))) return "go.sum";
  if (/Gradle generated file for dependency locking/.test(t)) return "gradle.lockfile";
  return null;
}

/**
 * detectLockfile(filename, text) -> { format, ecosystem } | null. By file name first (any directory, and a
 * browser's " (1)" suffix, are ignored); when the name says nothing, by content. A bun.lockb (binary) is null.
 */
export function detectLockfile(filename, text) {
  const name = baseName(filename);
  let format = null;
  for (const [re, f] of BY_NAME) {
    if (re.test(name)) {
      format = f;
      break;
    }
  }
  if (!format && /(^|\/)requirements\/[^/]+\.txt$/i.test(String(filename ?? "").replaceAll("\\", "/"))) format = "requirements.txt";
  if (!format && /\.lockfile$/i.test(name) && /^[^#\s:=]+:[^:=\s]+:[^:=\s]+(=|$)/m.test(String(text ?? ""))) format = "gradle.lockfile";
  if (!format && !/\.lockb$/i.test(name)) format = sniff(text);
  return format ? { format, ecosystem: ECOSYSTEM_OF[format] } : null;
}

const NOT_LOCKFILES = {
  "bun.lockb": "bun.lockb is a binary lockfile; run `bun install --save-text-lockfile` (Bun 1.1.39+) to write bun.lock, and check that instead",
  "package.json": "package.json lists ranges, not installed versions; check package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock instead",
  "composer.json": "composer.json lists constraints, not installed versions; check composer.lock instead",
  pipfile: "Pipfile lists ranges, not installed versions; check Pipfile.lock instead",
  "pyproject.toml": "pyproject.toml lists ranges, not installed versions; check poetry.lock, uv.lock or a pinned requirements.txt instead",
  "cargo.toml": "Cargo.toml lists ranges, not installed versions; check Cargo.lock instead",
  gemfile: "Gemfile lists ranges, not installed versions; check Gemfile.lock instead",
  "mix.exs": "mix.exs lists ranges, not installed versions; check mix.lock instead",
};

// ================================================================ parseLockfile

/**
 * parseLockfile(filename, text) -> { format, ecosystem, packages: [{ name, version, direct?, dev?, via? }], warnings }
 * One entry per distinct name and version, sorted by name then version. Throws when the file is not a supported
 * lockfile or can't be read.
 */
export function parseLockfile(filename, text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  const detected = detectLockfile(filename, src);
  if (!detected) {
    const hint = NOT_LOCKFILES[baseName(filename).toLowerCase()];
    throw new Error(hint ?? `${baseName(filename) || "this file"} is not a lockfile agentprime reads (supported: ${SUPPORTED.map((s) => s.format).join(", ")})`);
  }
  const { format, ecosystem } = detected;
  const warnings = [];
  const entries = PARSERS[format](src, warnings, format);
  return { format, ecosystem, packages: finish(ecosystem, entries), warnings: [...new Set(warnings)] };
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byName = cmpStr;

function cmpVersionsSafe(ecosystem, a, b) {
  if (ecosystem !== "Maven" && isVersion(ecosystem, a) && isVersion(ecosystem, b)) return compareVersions(ecosystem, a, b);
  return cmpStr(a, b);
}

// Rank of one occurrence for the via it carries: direct first, then not dev, then the shortest path, then by name.
const viaRank = (e) => [e.direct ? 0 : 1, e.dev ? 1 : 0, e.via ? e.via.length : Infinity, e.via ? e.via.join("\u0000") : ""];
const rankLess = (a, b) => {
  const x = viaRank(a);
  const y = viaRank(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

/** Merge occurrences of one name and version: direct if any is, dev only if all are, the via of the best one. */
function finish(ecosystem, entries) {
  const merged = new Map();
  for (const e of entries) {
    const key = `${e.name}\u0000${e.version}`;
    const m = merged.get(key);
    if (!m) {
      merged.set(key, { ...e, _all: [e] });
      continue;
    }
    m._all.push(e);
  }
  const out = [];
  for (const m of merged.values()) {
    const all = m._all;
    const p = { name: m.name, version: m.version };
    if (all.every((e) => typeof e.direct === "boolean")) p.direct = all.some((e) => e.direct);
    if (all.every((e) => typeof e.dev === "boolean")) p.dev = all.every((e) => e.dev);
    if (all.every((e) => Array.isArray(e.via))) {
      let best = all[0];
      for (const e of all) if (rankLess(e, best)) best = e;
      p.via = p.direct ? [] : [...best.via];
    }
    out.push(p);
  }
  return out.sort((a, b) => byName(a.name, b.name) || cmpVersionsSafe(ecosystem, a.version, b.version));
}

// ================================================================ shared: shortest via over a dependency graph

/**
 * Shortest `via` for every node by breadth-first search from the direct dependencies.
 * Non-dev nodes prefer a path that stays inside the non-dev graph from a non-dev direct dependency (so a
 * production package is never explained through a dev tool); dev nodes take the shortest path from any
 * direct dependency. Ties go to the name that sorts first, because roots and edges are visited in order.
 * Returns Map<id, string[]>; unreachable nodes are absent.
 */
function shortestVia({ label, edges, prodRoots, allRoots, isDev }) {
  const bfs = (roots, allowed) => {
    const via = new Map();
    const queue = [];
    for (const r of roots) {
      if (!via.has(r) && allowed(r)) {
        via.set(r, []);
        queue.push(r);
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      const path = [...via.get(id), label(id)];
      for (const next of edges(id)) {
        if (via.has(next) || !allowed(next)) continue;
        via.set(next, path);
        queue.push(next);
      }
    }
    return via;
  };
  const prod = bfs(prodRoots, (id) => !isDev(id));
  const all = bfs(allRoots, () => true);
  const result = new Map(all);
  for (const [id, path] of prod) result.set(id, path);
  return result;
}

// ================================================================ Composer

// Platform requirements (php, php-64bit, ext-*, lib-*, composer-plugin-api, composer-runtime-api, hhvm) have no
// vendor prefix; every real Packagist package is "vendor/name".
const isPlatform = (name) => !name.includes("/");

/**
 * composerLockEntries(lockText, composerJsonText|null) -> [{ name, version, dev, direct?, via?, dist_type, source_type }]
 * One entry per locked package, name as written, version through semver.mjs `normalise`. `direct` and `via` only
 * when composer.json is given (the lock alone does not say which packages the App requires). Used by
 * inventory.mjs's parseComposerLock and by parseLockfile.
 */
export function composerLockEntries(lockText, composerJsonText) {
  const lock = typeof lockText === "string" ? JSON.parse(lockText) : lockText;
  if (!lock || typeof lock !== "object" || (!Array.isArray(lock.packages) && !Array.isArray(lock["packages-dev"]))) {
    throw new Error("composer.lock: no packages or packages-dev list");
  }
  const manifest = composerJsonText ? JSON.parse(composerJsonText) : null;
  const prodList = (lock.packages ?? []).map((p) => ({ ...p, _dev: false }));
  const devList = (lock["packages-dev"] ?? []).map((p) => ({ ...p, _dev: true }));
  const locked = [...prodList, ...devList];
  for (const p of locked) if (typeof p?.name !== "string" || typeof p?.version !== "string") throw new Error("composer.lock: a package without name or version");

  let direct = null;
  let via = null;
  if (manifest) {
    // Composer names are case-insensitive. A package also answers for the names it replaces or provides.
    const byKey = new Map();
    for (const p of locked) byKey.set(p.name.toLowerCase(), p);
    const answers = new Map(byKey);
    for (const p of locked) {
      for (const field of ["replace", "provide"]) {
        for (const name of Object.keys(p[field] ?? {})) {
          const key = name.toLowerCase();
          if (!isPlatform(key) && !answers.has(key)) answers.set(key, p);
        }
      }
    }
    const resolveName = (name) => answers.get(name.toLowerCase())?.name.toLowerCase();
    const directKeys = (field) =>
      Object.keys(manifest[field] ?? {})
        .filter((n) => !isPlatform(n))
        .map(resolveName)
        .filter(Boolean)
        .sort(byName);
    const prodRoots = directKeys("require");
    const allRoots = [...new Set([...prodRoots, ...directKeys("require-dev")])].sort(byName);
    direct = new Set(allRoots);
    via = shortestVia({
      label: (key) => byKey.get(key).name,
      edges: (key) =>
        [...new Set(Object.keys(byKey.get(key).require ?? {}).filter((n) => !isPlatform(n)).map(resolveName).filter(Boolean))].sort(byName),
      prodRoots,
      allRoots,
      isDev: (key) => byKey.get(key)._dev,
    });
  }

  return locked.map((p) => {
    const key = p.name.toLowerCase();
    const e = { name: p.name, version: composerNormalise(p.version), dev: p._dev };
    if (direct) {
      e.direct = direct.has(key);
      e.via = e.direct ? [] : (via.get(key) ?? []);
    }
    e.dist_type = p.dist?.type ?? null;
    e.source_type = p.source?.type ?? null;
    return e;
  });
}

function parseComposer(text, warnings) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (err) {
    throw new Error(`composer.lock is not valid JSON: ${err.message}`);
  }
  const out = [];
  for (const e of composerLockEntries(lock, null)) {
    const name = e.name.toLowerCase();
    if (/^dev-|\.x-dev$|-dev$/i.test(e.version)) {
      warnings.push(`${name} is installed from the branch ${e.version}, not a release; not listed`);
      continue;
    }
    if (e.dist_type === "path" || e.source_type === "path") {
      warnings.push(`${name} ${e.version} comes from a local path repository, not Packagist; not listed`);
      continue;
    }
    out.push({ name, version: e.version, dev: e.dev });
  }
  return out;
}

// ================================================================ npm: package-lock.json and npm-shrinkwrap.json

const NM = "node_modules/";

// "node_modules/a/node_modules/@s/b" -> "@s/b"; null for keys that are not installed packages (root, workspaces).
function nameFromKey(key) {
  const i = key.lastIndexOf(NM);
  if (i === -1) return null;
  return key.slice(i + NM.length);
}

// Directories Node would search from `location`, nearest first: location, its parents, ..., "".
function* ancestors(location) {
  let dir = location;
  while (true) {
    yield dir;
    if (dir === "") return;
    const slash = dir.lastIndexOf("/");
    dir = slash === -1 ? "" : dir.slice(0, slash);
  }
}

/**
 * packageLockEntries(lock) -> [{ key, name, version, direct, dev, via, resolved }] for a parsed package-lock.json
 * (or npm-shrinkwrap.json) with lockfileVersion 2 or 3: one entry per installed occurrence (nested copies too),
 * links and the App's own root and workspace members left out. The one implementation of npm's graph: inventory.mjs's
 * parsePackageLock and parseLockfile both use it.
 */
export function packageLockEntries(lock) {
  const pkgs = lock?.packages;
  if (!pkgs || typeof pkgs !== "object") throw new Error("package-lock.json: no packages object");

  // Resolve a dependency name from a location the way Node does: the nearest enclosing node_modules wins.
  // Links (workspace symlinks) are followed to their target.
  const resolveFrom = (location, name) => {
    for (const dir of ancestors(location)) {
      const key = (dir ? dir + "/" : "") + NM + name;
      const entry = pkgs[key];
      if (!entry) continue;
      if (entry.link && typeof entry.resolved === "string") return pkgs[entry.resolved] ? entry.resolved : null;
      return key;
    }
    return null;
  };

  // The root and workspace members are the App's own code: their dependencies are direct.
  const ownKeys = Object.keys(pkgs).filter((k) => nameFromKey(k) === null && !pkgs[k].link);
  const isOwn = new Set(ownKeys);
  const prodRoots = [];
  const allRoots = [];
  for (const k of ownKeys.sort(byName)) {
    const e = pkgs[k];
    const prodNames = Object.keys({ ...e.dependencies, ...e.optionalDependencies }).sort(byName);
    const devNames = Object.keys(e.devDependencies ?? {}).sort(byName);
    for (const n of prodNames) {
      const r = resolveFrom(k, n);
      if (r && !isOwn.has(r)) prodRoots.push(r);
    }
    for (const n of [...prodNames, ...devNames]) {
      const r = resolveFrom(k, n);
      if (r && !isOwn.has(r)) allRoots.push(r);
    }
  }
  const direct = new Set(allRoots);

  const entryName = (key) => pkgs[key].name ?? nameFromKey(key); // `name` is set for aliased installs
  const via = shortestVia({
    label: entryName,
    edges: (key) => {
      const e = pkgs[key];
      const names = Object.keys({ ...e.dependencies, ...e.optionalDependencies, ...e.peerDependencies }).sort(byName);
      const out = [];
      for (const n of names) {
        const r = resolveFrom(key, n);
        if (r && !isOwn.has(r) && !out.includes(r)) out.push(r);
      }
      return out;
    },
    prodRoots,
    allRoots,
    isDev: (key) => pkgs[key].dev === true,
  });

  const out = [];
  for (const [key, e] of Object.entries(pkgs)) {
    if (nameFromKey(key) === null || e.link) continue;
    if (typeof e.version !== "string") continue; // an entry npm could not install has no version
    out.push({
      key,
      name: entryName(key),
      version: e.version,
      direct: direct.has(key),
      dev: e.dev === true,
      via: direct.has(key) ? [] : (via.get(key) ?? []),
      resolved: typeof e.resolved === "string" ? e.resolved : null,
    });
  }
  return out;
}

// Where an npm package came from, by its resolved URL or version spec: "registry", "git", "file" or "url".
function npmSource(spec) {
  if (spec === null || spec === undefined || spec === "") return "registry";
  const s = String(spec);
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|gist:|ssh:)/i.test(s) || /\.git(#|$)/.test(s)) return "git";
  if (/^[\w-][\w.-]*\/[\w.-]+(#.*)?$/.test(s)) return "git"; // GitHub shorthand "user/repo#ref"
  if (/^(file:|link:|portal:|\.{0,2}\/)/.test(s)) return "file";
  if (/^https?:\/\//i.test(s)) {
    if (/^https:\/\/codeload\.github\.com\//i.test(s)) return "git";
    return /\/-\/[^/]+\.tgz(#|\?|$)/.test(s) ? "registry" : "url";
  }
  return "registry";
}

const SOURCE_WORDS = { git: "a git repository", file: "a local path", url: "a tarball URL" };

function parsePackageLockText(text, warnings, format) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (err) {
    throw new Error(`${format} is not valid JSON: ${err.message}`);
  }
  if (!lock || typeof lock !== "object") throw new Error(`${format} is not a lockfile object`);
  const v = lock.lockfileVersion;
  if (lock.packages && typeof lock.packages === "object" && v >= 2) {
    if (v > 3) warnings.push(`${format} lockfileVersion ${v} is newer than agentprime knows (3); read as version 3`);
    const out = [];
    for (const e of packageLockEntries(lock)) {
      const src = npmSource(e.resolved);
      if (src !== "registry") {
        warnings.push(`${e.name} (${e.key}) comes from ${SOURCE_WORDS[src]} (${e.resolved}), not the npm registry; not listed`);
        continue;
      }
      out.push({ name: e.name, version: e.version, direct: e.direct, dev: e.dev, via: e.via });
    }
    for (const [key, e] of Object.entries(lock.packages)) {
      if (e?.link && typeof e.resolved === "string" && e.resolved.startsWith("../")) {
        warnings.push(`${nameFromKey(key) ?? key} links to ${e.resolved}, a directory outside the project; not listed`);
      }
    }
    return out;
  }
  if (v === 1 || (v === undefined && lock.dependencies && typeof lock.dependencies === "object")) return npmV1(lock, warnings, format);
  throw new Error(`${format} lockfileVersion ${v ?? "unknown"} not supported (1, 2 or 3)`);
}

// lockfileVersion 1: a tree of `dependencies`. It records `dev` but not which packages the root requires.
function npmV1(lock, warnings, format) {
  const out = [];
  const walk = (deps, path) => {
    for (const [key, e] of Object.entries(deps ?? {})) {
      if (!e || typeof e !== "object") throw new Error(`${format}: dependency ${key} is not an object`);
      const where = [...path, key].join(" > ");
      if (typeof e.version !== "string") {
        warnings.push(`${where} has no version; not listed`);
      } else {
        let name = key;
        let version = e.version;
        const alias = /^npm:((?:@[^/@]+\/)?[^@]+)@(.+)$/.exec(version);
        if (alias) [, name, version] = alias;
        const src = npmSource(alias ? null : /^\d/.test(version) ? e.resolved : version);
        if (src !== "registry") warnings.push(`${where} comes from ${SOURCE_WORDS[src]} (${e.version}), not the npm registry; not listed`);
        else out.push({ name, version, dev: e.dev === true });
      }
      if (e.dependencies) walk(e.dependencies, [...path, key]);
    }
  };
  walk(lock.dependencies, []);
  return out;
}

// ================================================================ a small YAML reader (pnpm-lock.yaml, Yarn Berry)

/**
 * The block-style subset pnpm and Yarn write: mappings, sequences, plain, single- and double-quoted scalars, and
 * one-line flow collections ({a: b}, [a, b]). Every scalar stays a string. Anchors, aliases, tags, block scalars,
 * complex keys and multi-line plain scalars are rejected with the line number. Returns one value per document.
 */
export function parseYamlSubset(text, what = "YAML") {
  const fail = (lineNo, msg) => new Error(`${what}: line ${lineNo}: ${msg}`);
  const docs = [[]];
  const rawLines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  rawLines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (/^(---|\.\.\.)(\s|$)/.test(raw)) {
      if (raw.startsWith("---") && raw.slice(3).trim() && !raw.slice(3).trim().startsWith("#")) throw fail(lineNo, "content after --- is not supported");
      if (docs[docs.length - 1].length || raw.startsWith("---")) docs.push([]);
      return;
    }
    const lead = /^[ \t]*/.exec(raw)[0];
    if (lead.includes("\t")) throw fail(lineNo, "tab indentation");
    const content = stripYamlComment(raw.slice(lead.length)).trimEnd();
    if (content === "") return;
    if (content.startsWith("%")) throw fail(lineNo, "YAML directives are not supported");
    docs[docs.length - 1].push({ indent: lead.length, content, lineNo });
  });
  return docs.filter((d) => d.length).map((lines) => {
    const [value, pos] = yamlBlock(lines, 0, lines[0].indent, fail);
    if (pos < lines.length) throw fail(lines[pos].lineNo, "unexpected indentation");
    return value;
  });
}

function stripYamlComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = null;
    } else if (quote === "'") {
      if (c === "'" && s[i + 1] === "'") i++;
      else if (c === "'") quote = null;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s{[,:]/.test(s[i - 1]))) {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

function yamlBlock(lines, pos, indent, fail) {
  if (lines[pos].content === "-" || lines[pos].content.startsWith("- ")) return yamlSeq(lines, pos, indent, fail);
  return yamlMap(lines, pos, indent, fail);
}

function yamlSeq(lines, pos, indent, fail) {
  const out = [];
  while (pos < lines.length && lines[pos].indent === indent && (lines[pos].content === "-" || lines[pos].content.startsWith("- "))) {
    const { content, lineNo } = lines[pos];
    const item = content.slice(1).trim();
    pos++;
    if (item === "") {
      if (pos < lines.length && lines[pos].indent > indent) {
        const [v, p] = yamlBlock(lines, pos, lines[pos].indent, fail);
        out.push(v);
        pos = p;
      } else out.push(null);
      continue;
    }
    if (/^[^"'{[][^:]*:(\s|$)/.test(item)) throw fail(lineNo, "a mapping inside a sequence item is not supported");
    out.push(yamlInline(item, lineNo, fail));
    if (pos < lines.length && lines[pos].indent > indent) throw fail(lines[pos].lineNo, "unexpected indentation (a multi-line value?)");
  }
  return [out, pos];
}

function yamlMap(lines, pos, indent, fail) {
  const out = {};
  while (pos < lines.length && lines[pos].indent === indent) {
    const { content, lineNo } = lines[pos];
    if (content === "-" || content.startsWith("- ")) throw fail(lineNo, "a sequence item where a mapping key was expected");
    const { key, rest } = yamlKey(content, lineNo, fail);
    if (Object.prototype.hasOwnProperty.call(out, key)) throw fail(lineNo, `duplicate key ${JSON.stringify(key)}`);
    pos++;
    if (rest === "") {
      if (pos < lines.length && lines[pos].indent > indent) {
        const [v, p] = yamlBlock(lines, pos, lines[pos].indent, fail);
        out[key] = v;
        pos = p;
      } else if (pos < lines.length && lines[pos].indent === indent && (lines[pos].content === "-" || lines[pos].content.startsWith("- "))) {
        const [v, p] = yamlSeq(lines, pos, indent, fail);
        out[key] = v;
        pos = p;
      } else out[key] = null;
    } else {
      out[key] = yamlInline(rest, lineNo, fail);
      if (pos < lines.length && lines[pos].indent > indent) throw fail(lines[pos].lineNo, "unexpected indentation (a multi-line value?)");
    }
  }
  if (pos < lines.length && lines[pos].indent > indent) throw fail(lines[pos].lineNo, "unexpected indentation");
  return [out, pos];
}

function yamlKey(content, lineNo, fail) {
  let key;
  let i;
  if (content[0] === '"' || content[0] === "'") {
    const [s, end] = yamlQuoted(content, 0, lineNo, fail);
    key = s;
    i = end;
    while (content[i] === " ") i++;
    if (content[i] !== ":") throw fail(lineNo, "expected : after a quoted key");
    i++;
  } else {
    if (/^[?&*!|>@`{[]/.test(content)) throw fail(lineNo, `unsupported YAML at ${JSON.stringify(content.slice(0, 20))}`);
    const m = /^(.*?):(?:\s|$)/.exec(content);
    if (!m) throw fail(lineNo, `expected "key: value", got ${JSON.stringify(content.slice(0, 40))}`);
    key = m[1].trimEnd();
    i = m[1].length + 1;
  }
  if (content[i] !== undefined && content[i] !== " ") throw fail(lineNo, "expected a space after :");
  return { key, rest: content.slice(i).trim() };
}

function yamlQuoted(s, i, lineNo, fail) {
  const q = s[i];
  let out = "";
  i++;
  while (i < s.length) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return [out, i + 1];
      }
      out += c;
      i++;
      continue;
    }
    if (c === '"') return [out, i + 1];
    if (c === "\\") {
      const n = s[i + 1];
      const simple = { '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", 0: "\0", " ": " " };
      if (n in simple) {
        out += simple[n];
        i += 2;
        continue;
      }
      const len = n === "x" ? 2 : n === "u" ? 4 : n === "U" ? 8 : 0;
      const hex = s.slice(i + 2, i + 2 + len);
      if (!len || !/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw fail(lineNo, `unsupported escape \\${n}`);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += 2 + len;
      continue;
    }
    out += c;
    i++;
  }
  throw fail(lineNo, "unterminated quoted string (multi-line strings are not supported)");
}

function yamlInline(text, lineNo, fail) {
  const s = text.trim();
  if (/^[&*!|>]/.test(s)) throw fail(lineNo, `unsupported YAML (anchor, alias, tag or block scalar): ${JSON.stringify(s.slice(0, 20))}`);
  if (s[0] === '"' || s[0] === "'") {
    const [v, end] = yamlQuoted(s, 0, lineNo, fail);
    if (s.slice(end).trim() !== "") throw fail(lineNo, "text after a quoted value");
    return v;
  }
  if (s[0] === "{" || s[0] === "[") {
    const [v, end] = yamlFlow(s, 0, lineNo, fail);
    if (s.slice(end).trim() !== "") throw fail(lineNo, "text after a flow collection");
    return v;
  }
  return s;
}

function yamlFlow(s, i, lineNo, fail) {
  const skip = () => {
    while (s[i] === " ") i++;
  };
  const scalar = (stops) => {
    skip();
    if (s[i] === '"' || s[i] === "'") {
      const [v, end] = yamlQuoted(s, i, lineNo, fail);
      i = end;
      return v;
    }
    if (s[i] === "{" || s[i] === "[") {
      const [v, end] = yamlFlow(s, i, lineNo, fail);
      i = end;
      return v;
    }
    let j = i;
    while (j < s.length && !stops(j)) j++;
    const v = s.slice(i, j).trim();
    i = j;
    return v;
  };
  if (s[i] === "{") {
    const out = {};
    i++;
    skip();
    if (s[i] === "}") return [out, i + 1];
    while (i < s.length) {
      const key = scalar((j) => s[j] === ":" && (s[j + 1] === " " || s[j + 1] === "," || s[j + 1] === "}" || s[j + 1] === undefined) || s[j] === "," || s[j] === "}");
      skip();
      let value = null;
      if (s[i] === ":") {
        i++;
        value = scalar((j) => s[j] === "," || s[j] === "}");
      }
      if (typeof key !== "string" || key === "") throw fail(lineNo, "empty key in a flow mapping");
      if (Object.prototype.hasOwnProperty.call(out, key)) throw fail(lineNo, `duplicate key ${JSON.stringify(key)}`);
      out[key] = value;
      skip();
      if (s[i] === ",") {
        i++;
        skip();
        if (s[i] === "}") return [out, i + 1];
        continue;
      }
      if (s[i] === "}") return [out, i + 1];
      if (i >= s.length) break;
      throw fail(lineNo, "can't read a flow mapping");
    }
    throw fail(lineNo, "unterminated flow mapping (multi-line flow collections are not supported)");
  }
  const out = [];
  i++;
  skip();
  if (s[i] === "]") return [out, i + 1];
  while (i < s.length) {
    out.push(scalar((j) => s[j] === "," || s[j] === "]"));
    skip();
    if (s[i] === ",") {
      i++;
      skip();
      if (s[i] === "]") return [out, i + 1];
      continue;
    }
    if (s[i] === "]") return [out, i + 1];
    if (i >= s.length) break;
    throw fail(lineNo, "can't read a flow sequence");
  }
  throw fail(lineNo, "unterminated flow sequence (multi-line flow collections are not supported)");
}

// ================================================================ pnpm-lock.yaml

const SEMVERISH = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// "@scope/name@1.0.0(peer@2.0.0)" -> { name: "@scope/name", rest: "1.0.0(peer@2.0.0)" }
function splitNameAt(s) {
  const at = s.indexOf("@", s.startsWith("@") ? 1 : 0);
  if (at <= 0) return null;
  return { name: s.slice(0, at), rest: s.slice(at + 1) };
}

/** A packages/snapshots key -> { name, version, registry }. */
function pnpmKey(key, major) {
  let k = key;
  if (major < 9) {
    if (!k.startsWith("/")) return { name: key, version: null, registry: false };
    k = k.slice(1);
  }
  let name;
  let version;
  if (major === 5) {
    const parts = k.split("/");
    const n = k.startsWith("@") ? 2 : 1;
    name = parts.slice(0, n).join("/");
    version = parts.slice(n).join("/").split("_")[0];
  } else {
    const split = splitNameAt(k.replace(/\(.*$/, ""));
    if (!split) return { name: key, version: null, registry: false };
    name = split.name;
    version = split.rest;
  }
  return { name, version, registry: SEMVERISH.test(version) };
}

// An importer's or package's dependency reference -> the key of the package it resolves to; null for a link.
function pnpmRef(name, ref, major) {
  if (typeof ref !== "string" || ref === "") return undefined;
  if (ref.startsWith("link:")) return null;
  if (major === 5) return ref.startsWith("/") ? ref : /^\d/.test(ref) ? `/${name}/${ref}` : ref;
  if (major === 6) return ref.startsWith("/") ? ref : /^\d/.test(ref) ? `/${name}@${ref}` : ref;
  if (/^\d/.test(ref)) return `${name}@${ref}`;
  if (/^(@[^/@]+\/)?[^/@:]+@/.test(ref)) return ref; // an npm alias: "lodash@4.17.21"
  return `${name}@${ref}`;
}

const refOf = (v) => (isObj(v) ? v.version : v);

function parsePnpm(text, warnings) {
  const docs = parseYamlSubset(text, "pnpm-lock.yaml");
  const doc = docs.find((d) => isObj(d) && ("importers" in d || "packages" in d || "snapshots" in d || "dependencies" in d)) ?? docs.find(isObj);
  if (!isObj(doc)) throw new Error("pnpm-lock.yaml: not a pnpm lockfile");
  const lv = String(doc.lockfileVersion ?? "");
  const major = Number.parseInt(lv, 10);
  if (![5, 6, 9].includes(major)) throw new Error(`pnpm-lock.yaml lockfileVersion ${lv || "unknown"} not supported (5.x, 6.x or 9.x)`);

  // Nodes: every installed package occurrence (one per peer-resolved variant), keyed as the lockfile keys them.
  const nodeSource = major === 9 ? (isObj(doc.snapshots) ? doc.snapshots : doc.packages) : doc.packages;
  const pkgInfo = isObj(doc.packages) ? doc.packages : {};
  const nodes = new Map();
  for (const [key, entry] of Object.entries(isObj(nodeSource) ? nodeSource : {})) {
    const e = isObj(entry) ? entry : {};
    const parsed = pnpmKey(key, major);
    const info = major === 9 ? (isObj(pkgInfo[key.replace(/\(.*$/, "")]) ? pkgInfo[key.replace(/\(.*$/, "")] : {}) : e;
    const res = isObj(info.resolution) ? info.resolution : {};
    const local = res.type === "git" || res.type === "directory" || "repo" in res || "directory" in res || /^file:/.test(res.tarball ?? "");
    nodes.set(key, {
      key,
      name: parsed.name,
      version: parsed.version,
      registry: parsed.registry && !local,
      deps: { ...(isObj(e.dependencies) ? e.dependencies : {}), ...(isObj(e.optionalDependencies) ? e.optionalDependencies : {}) },
      devFlag: e.dev === "true" ? true : e.dev === "false" ? false : undefined,
    });
  }

  const importers = isObj(doc.importers) ? doc.importers : { ".": doc };
  let complete = true;
  const missing = [];
  const resolve = (name, ref) => {
    const id = pnpmRef(name, refOf(ref), major);
    if (id === null) return null; // a workspace link: the App's own code
    if (id === undefined || !nodes.has(id)) {
      complete = false;
      missing.push(`${name}@${refOf(ref)}`);
      return null;
    }
    return id;
  };
  const prodRoots = [];
  const allRoots = [];
  for (const imp of Object.keys(importers).sort(byName)) {
    const e = isObj(importers[imp]) ? importers[imp] : {};
    const prod = { ...(isObj(e.dependencies) ? e.dependencies : {}), ...(isObj(e.optionalDependencies) ? e.optionalDependencies : {}) };
    const dev = isObj(e.devDependencies) ? e.devDependencies : {};
    for (const n of Object.keys(prod).sort(byName)) {
      const id = resolve(n, prod[n]);
      if (id) prodRoots.push(id), allRoots.push(id);
    }
    for (const n of Object.keys(dev).sort(byName)) {
      const id = resolve(n, dev[n]);
      if (id) allRoots.push(id);
    }
  }
  const edges = new Map();
  for (const node of nodes.values()) {
    const out = [];
    for (const n of Object.keys(node.deps).sort(byName)) {
      const id = resolve(n, node.deps[n]);
      if (id && !out.includes(id)) out.push(id);
    }
    edges.set(node.key, out);
  }
  if (!complete) {
    warnings.push(`pnpm-lock.yaml: ${missing.length} dependency reference(s) point at no package entry (first: ${missing[0]}); via${major === 9 ? " and dev are" : " is"} left out`);
  }

  // dev: lockfile 5 and 6 record it per package (absent means used by both). Lockfile 9 dropped the field; it is
  // whether the package is reachable from any importer's dependencies or optionalDependencies, which needs the
  // whole graph.
  let isDev;
  if (major === 9) {
    if (complete) {
      const reach = new Set(prodRoots);
      const queue = [...reach];
      for (let i = 0; i < queue.length; i++) for (const n of edges.get(queue[i]) ?? []) if (!reach.has(n)) reach.add(n), queue.push(n);
      isDev = (id) => !reach.has(id);
    }
  } else {
    isDev = (id) => nodes.get(id).devFlag === true;
  }
  const direct = new Set(allRoots);
  const via = complete
    ? shortestVia({ label: (id) => nodes.get(id).name, edges: (id) => edges.get(id) ?? [], prodRoots, allRoots, isDev: isDev ?? (() => false) })
    : null;

  const out = [];
  for (const node of nodes.values()) {
    if (!node.registry) {
      warnings.push(`${node.key} is not from the npm registry (git, tarball or local directory); not listed`);
      continue;
    }
    const e = { name: node.name, version: node.version, direct: direct.has(node.key) };
    if (isDev) e.dev = isDev(node.key);
    if (via) e.via = e.direct ? [] : (via.get(node.key) ?? []);
    out.push(e);
  }
  return out;
}

// ================================================================ yarn.lock (classic v1 and Berry)

function parseYarn(text, warnings) {
  if (/^__metadata:\s*$/m.test(text)) return parseYarnBerry(text, warnings);
  if (!/^# yarn lockfile v1\s*$/m.test(text)) {
    throw new Error("yarn.lock: neither a Yarn 1 lockfile (no \"# yarn lockfile v1\" line) nor a Yarn Berry one (no __metadata)");
  }
  return parseYarnV1(text, warnings);
}

// "a" "b", or plain tokens; JSON-style double-quoted strings.
function yarnTokens(s, lineNo) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === " ") {
      i++;
      continue;
    }
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) throw new Error(`yarn.lock: line ${lineNo}: unterminated string`);
      out.push(JSON.parse(s.slice(i, j + 1)));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== " ") j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

function parseYarnV1(text, warnings) {
  const entries = [];
  let cur = null;
  let nested = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const lineNo = i + 1;
    if (/^\s*(#|$)/.test(raw)) return;
    const indent = /^ */.exec(raw)[0].length;
    const line = raw.trim();
    if (indent === 0) {
      if (!line.endsWith(":")) throw new Error(`yarn.lock: line ${lineNo}: expected a package key ending in ":"`);
      const specs = [];
      for (const part of line.slice(0, -1).split(/,\s*/)) {
        const t = yarnTokens(part.trim(), lineNo);
        if (t.length !== 1) throw new Error(`yarn.lock: line ${lineNo}: can't read the key ${JSON.stringify(part)}`);
        specs.push(t[0]);
      }
      cur = { specs, fields: {}, lineNo };
      entries.push(cur);
      nested = false;
      return;
    }
    if (!cur) throw new Error(`yarn.lock: line ${lineNo}: indented line outside a package`);
    if (indent === 2) {
      nested = false;
      if (line.endsWith(":")) {
        nested = true; // dependencies:, optionalDependencies: — not needed for names and versions
        return;
      }
      const t = yarnTokens(line, lineNo);
      if (t.length !== 2) throw new Error(`yarn.lock: line ${lineNo}: expected "field value"`);
      cur.fields[t[0]] = t[1];
      return;
    }
    if (indent === 4 && nested) return;
    throw new Error(`yarn.lock: line ${lineNo}: unexpected indentation`);
  });

  const out = [];
  for (const e of entries) {
    const d = splitNameAt(e.specs[0]);
    if (!d) throw new Error(`yarn.lock: line ${e.lineNo}: can't read the package name in ${JSON.stringify(e.specs[0])}`);
    let { name, rest: range } = d;
    const version = e.fields.version;
    if (typeof version !== "string") throw new Error(`yarn.lock: line ${e.lineNo}: ${e.specs[0]} has no version`);
    const alias = /^npm:(.+)$/.exec(range);
    if (alias) {
      const real = splitNameAt(alias[1]) ?? { name: alias[1], rest: "" };
      name = real.name;
      range = real.rest;
    }
    // The specifier says where it comes from: a range or tag is the registry; git, file and URL specs are not.
    const src = npmSource(range);
    if (src !== "registry") {
      warnings.push(`${e.specs[0]} comes from ${SOURCE_WORDS[src]}, not the npm registry; not listed`);
      continue;
    }
    out.push({ name, version });
  }
  return out;
}

function parseYarnBerry(text, warnings) {
  const [doc] = parseYamlSubset(text, "yarn.lock");
  if (!isObj(doc)) throw new Error("yarn.lock: not a Yarn Berry lockfile");
  const out = [];
  for (const [key, e] of Object.entries(doc)) {
    if (key === "__metadata") continue;
    if (!isObj(e) || typeof e.resolution !== "string") throw new Error(`yarn.lock: ${key} has no resolution`);
    const r = splitNameAt(e.resolution);
    if (!r) throw new Error(`yarn.lock: can't read the resolution ${JSON.stringify(e.resolution)}`);
    const protocol = /^([a-z]+):/.exec(r.rest)?.[1] ?? "";
    if (protocol === "npm") {
      const version = r.rest.slice(4);
      if (!SEMVERISH.test(version)) throw new Error(`yarn.lock: ${e.resolution} has no version`);
      out.push({ name: r.name, version });
    } else if (protocol === "workspace") {
      continue; // the App's own workspace
    } else if (protocol === "patch") {
      // "resolve@patch:resolve@npm%3A1.22.8#optional!builtin<compat/resolve>::version=1.22.8&hash=c3c19d": the npm
      // package with a patch applied. Listed by the version it patches (its plain npm entry is usually there too).
      const inner = decodeURIComponent(r.rest.slice(6).replace(/#.*$/, ""));
      const p = splitNameAt(inner);
      if (p && p.rest.startsWith("npm:") && SEMVERISH.test(p.rest.slice(4))) {
        out.push({ name: p.name, version: p.rest.slice(4) });
        if (!/builtin</.test(r.rest)) warnings.push(`${p.name} ${p.rest.slice(4)} is patched locally (${key}); listed by the version it patches`);
      } else {
        warnings.push(`${e.resolution} patches something that is not an npm release; not listed`);
      }
    } else {
      const src = protocol === "file" || protocol === "link" || protocol === "portal" || protocol === "exec" ? "file" : protocol === "http" || protocol === "https" ? npmSource(r.rest) : "git";
      warnings.push(`${e.resolution} comes from ${SOURCE_WORDS[src === "registry" ? "url" : src]}, not the npm registry; not listed`);
    }
  }
  return out;
}

// ================================================================ bun.lock

/** JSONC -> JSON: drops // and /* *\/ comments and trailing commas, outside strings. */
function stripJsonc(text) {
  let out = "";
  let i = 0;
  const s = String(text);
  const skipTrivia = (j) => {
    while (j < s.length) {
      if (/\s/.test(s[j])) j++;
      else if (s[j] === "/" && s[j + 1] === "/") while (j < s.length && s[j] !== "\n") j++;
      else if (s[j] === "/" && s[j + 1] === "*") {
        const end = s.indexOf("*/", j + 2);
        j = end === -1 ? s.length : end + 2;
      } else break;
    }
    return j;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) {
      i = skipTrivia(i);
      out += " ";
    } else if (c === ",") {
      const j = skipTrivia(i + 1);
      if (s[j] !== "}" && s[j] !== "]") out += ",";
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function parseBun(text, warnings) {
  let lock;
  try {
    lock = JSON.parse(stripJsonc(text));
  } catch (err) {
    throw new Error(`bun.lock is not valid JSONC: ${err.message}`);
  }
  if (!isObj(lock) || !isObj(lock.packages)) throw new Error("bun.lock: no packages object");
  if (lock.lockfileVersion !== 0 && lock.lockfileVersion !== 1) warnings.push(`bun.lock lockfileVersion ${lock.lockfileVersion} is not one agentprime knows (0 or 1); read as 1`);
  // Direct dependencies by the packages key they occupy: the root's are top-level keys; a workspace member's are
  // "<member name>/<dep>" when not hoisted, else the top-level key.
  const declared = new Map(); // key -> { prod, dev }
  const declare = (key, isDev) => {
    const d = declared.get(key) ?? { prod: false, dev: false };
    if (isDev) d.dev = true;
    else d.prod = true;
    declared.set(key, d);
  };
  for (const [path, ws] of Object.entries(isObj(lock.workspaces) ? lock.workspaces : {})) {
    if (!isObj(ws)) continue;
    for (const [field, isDev] of [["dependencies", false], ["optionalDependencies", false], ["peerDependencies", false], ["devDependencies", true]]) {
      for (const dep of Object.keys(isObj(ws[field]) ? ws[field] : {})) {
        const nested = path !== "" && ws.name ? `${ws.name}/${dep}` : null;
        declare(nested && nested in lock.packages ? nested : dep, isDev);
      }
    }
  }
  const out = [];
  for (const [key, value] of Object.entries(lock.packages)) {
    if (!Array.isArray(value) || typeof value[0] !== "string") throw new Error(`bun.lock: package ${key} is not [ "name@version", ... ]`);
    const id = splitNameAt(value[0]);
    if (!id) throw new Error(`bun.lock: can't read ${JSON.stringify(value[0])}`);
    if (id.rest.startsWith("workspace:")) continue;
    if (!SEMVERISH.test(id.rest)) {
      const src = npmSource(id.rest.replace(/^npm:/, ""));
      warnings.push(`${key} (${value[0]}) comes from ${SOURCE_WORDS[src === "registry" ? "url" : src]}, not the npm registry; not listed`);
      continue;
    }
    const d = declared.get(key);
    const e = { name: id.name, version: id.rest, direct: Boolean(d) };
    if (d) e.dev = !d.prod;
    out.push(e);
  }
  return out;
}

// ================================================================ Python

/** PEP 503 normalised name: lowercase, runs of -, _ and . become one -. */
export const pep503 = (name) => String(name).toLowerCase().replace(/[-_.]+/g, "-");

const PEP508_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$/;
const IGNORED_PIP_OPTIONS = /^(-i|--index-url|--extra-index-url|--no-index|-f|--find-links|--trusted-host|--pre|--prefer-binary|--only-binary|--no-binary|--require-hashes|--use-feature|--no-deps|--progress-bar|--upgrade-strategy)(?=[\s=]|$)/;

function parseRequirements(text, warnings) {
  // Join backslash continuations, keeping the first line's number.
  const logical = [];
  let buf = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const cont = /(^|[^\\])\\$/.test(raw) && !/(^|\s)#/.test(raw);
    const piece = cont ? raw.slice(0, -1) : raw;
    if (buf) buf.text += " " + piece;
    else buf = { text: piece, lineNo: i + 1 };
    if (!cont) logical.push(buf), (buf = null);
  });
  if (buf) logical.push(buf);

  const out = [];
  const marked = [];
  for (const { text: rawLine, lineNo } of logical) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("-")) {
      const opt = /^(-r|--requirement|-c|--constraint|-e|--editable)(?:\s+|=)?(.*)$/.exec(line);
      if (opt && /^-r|^--requirement/.test(opt[1])) warnings.push(`line ${lineNo}: includes ${opt[2].trim() || "another file"}, which was not read; check that file too`);
      else if (opt && /^-c|^--constraint/.test(opt[1])) warnings.push(`line ${lineNo}: constraints file ${opt[2].trim() || ""} was not read`.trimEnd());
      else if (opt) warnings.push(`line ${lineNo}: editable install ${opt[2].trim()} is not a PyPI release; not listed`);
      else if (!IGNORED_PIP_OPTIONS.test(line)) warnings.push(`line ${lineNo}: option ${line.split(/[\s=]/)[0]} not understood; line skipped`);
      continue;
    }
    // Per-requirement options (--hash=..., --config-settings ...) follow the requirement after whitespace.
    const spec = line.split(/\s+(?=--?[A-Za-z])/)[0].trim();
    if (/^(git\+|hg\+|svn\+|bzr\+|https?:|file:|\.|\/|~)/i.test(spec) || /^[A-Za-z0-9._-]+(\[[^\]]*\])?\s*@\s*\S/.test(spec)) {
      warnings.push(`line ${lineNo}: ${spec.split(/\s/)[0]} is installed from a URL or path, not a PyPI release; not listed`);
      continue;
    }
    const m = PEP508_NAME.exec(spec);
    if (!m) {
      warnings.push(`line ${lineNo}: can't read ${JSON.stringify(spec)}; line skipped`);
      continue;
    }
    const [, rawName, , tail] = m;
    const semi = tail.indexOf(";");
    let specifiers = (semi === -1 ? tail : tail.slice(0, semi)).trim();
    const marker = semi === -1 ? "" : tail.slice(semi + 1).trim();
    if (/^\(.*\)$/.test(specifiers)) specifiers = specifiers.slice(1, -1).trim();
    const name = pep503(rawName);
    const clauses = specifiers.split(",").map((c) => c.trim()).filter(Boolean);
    if (!clauses.length) {
      warnings.push(`line ${lineNo}: ${rawName} is not pinned (no ==version); not listed`);
      continue;
    }
    const exact = clauses.map((c) => /^(===?)\s*([^\s*]+)$/.exec(c)).find(Boolean);
    if (!exact) {
      warnings.push(`line ${lineNo}: ${rawName}${specifiers} is not an exact == pin; not listed`);
      continue;
    }
    const [, op, version] = exact;
    if (op === "==" && !isVersion("PyPI", version)) {
      warnings.push(`line ${lineNo}: ${rawName}==${version} is not a PEP 440 version; not listed`);
      continue;
    }
    if (clauses.length > 1) warnings.push(`line ${lineNo}: ${rawName}${specifiers} has clauses besides the pin; listed as ${version}`);
    if (marker) marked.push(`line ${lineNo}: ${rawName} ; ${marker}`);
    out.push({ name, version });
  }
  if (marked.length) {
    warnings.push(`${marked.length} requirement(s) have environment markers and are installed only where the marker holds; they are listed (first: ${marked[0]})`);
  }
  return out;
}

function parsePipfileLock(text, warnings) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (err) {
    throw new Error(`Pipfile.lock is not valid JSON: ${err.message}`);
  }
  if (!isObj(lock) || (!isObj(lock.default) && !isObj(lock.develop))) throw new Error("Pipfile.lock: no default or develop section");
  const out = [];
  for (const [section, dev] of [["default", false], ["develop", true]]) {
    for (const [rawName, e] of Object.entries(isObj(lock[section]) ? lock[section] : {})) {
      if (!isObj(e)) throw new Error(`Pipfile.lock: ${section}.${rawName} is not an object`);
      if (typeof e.version !== "string") {
        const how = e.git ? "a git repository" : e.path || e.file ? "a local path or file" : e.editable ? "an editable install" : "somewhere other than an index";
        warnings.push(`${rawName} (${section}) comes from ${how}, not a PyPI release; not listed`);
        continue;
      }
      const m = /^===?\s*(\S+)$/.exec(e.version.trim());
      if (!m) {
        warnings.push(`${rawName} (${section}) has version ${JSON.stringify(e.version)}, not an exact pin; not listed`);
        continue;
      }
      out.push({ name: pep503(rawName), version: m[1], dev });
    }
  }
  return out;
}

// ================================================================ a small TOML reader (poetry.lock, uv.lock, Cargo.lock)

/**
 * TOML 1.0 as these lockfiles write it: tables, arrays of tables, dotted and quoted keys, basic and literal strings
 * (one-line and multi-line), integers, floats, booleans, dates (kept as strings), arrays and inline tables (which
 * may span lines). Anything else is rejected with the line number.
 */
export function parseTomlSubset(text, what = "TOML") {
  const s = String(text).replace(/^﻿/, "");
  let i = 0;
  const lineAt = (pos) => {
    let n = 1;
    for (let k = 0; k < pos && k < s.length; k++) if (s[k] === "\n") n++;
    return n;
  };
  const fail = (msg, pos = i) => new Error(`${what}: line ${lineAt(pos)}: ${msg}`);
  const root = {};
  const explicitTables = new Set();
  let current = root;

  const ws = () => {
    while (s[i] === " " || s[i] === "\t") i++;
  };
  const comment = () => {
    if (s[i] === "#") while (i < s.length && s[i] !== "\n") i++;
  };
  const eol = () => {
    ws();
    comment();
    if (s[i] === "\r") i++;
    if (i < s.length && s[i] !== "\n") throw fail(`unexpected ${JSON.stringify(s[i])}`);
    i++;
  };
  const blank = () => {
    // whitespace, comments and newlines (inside arrays and inline tables)
    for (;;) {
      ws();
      comment();
      if (s[i] === "\r" || s[i] === "\n") i++;
      else return;
    }
  };

  const basicString = () => {
    i++;
    let out = "";
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\n") throw fail("newline in a string");
      if (s[i] === "\\") out += escape();
      else out += s[i++];
    }
    if (s[i] !== '"') throw fail("unterminated string");
    i++;
    return out;
  };
  const escape = () => {
    const n = s[i + 1];
    const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (n in simple) {
      i += 2;
      return simple[n];
    }
    const len = n === "u" ? 4 : n === "U" ? 8 : 0;
    const hex = s.slice(i + 2, i + 2 + len);
    if (!len || hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) throw fail(`bad escape \\${n}`);
    i += 2 + len;
    return String.fromCodePoint(parseInt(hex, 16));
  };
  const literalString = () => {
    const end = s.indexOf("'", i + 1);
    const nl = s.indexOf("\n", i + 1);
    if (end === -1 || (nl !== -1 && nl < end)) throw fail("unterminated literal string");
    const out = s.slice(i + 1, end);
    i = end + 1;
    return out;
  };
  const multiline = (q) => {
    i += 3;
    if (s[i] === "\r" && s[i + 1] === "\n") i += 2;
    else if (s[i] === "\n") i++;
    let out = "";
    while (i < s.length) {
      if (s.startsWith(q.repeat(3), i)) {
        // up to two quotes may sit right before the closing three
        let extra = 0;
        while (s[i + 3 + extra] === q && extra < 2) extra++;
        out += q.repeat(extra);
        i += 3 + extra;
        return out;
      }
      if (q === '"' && s[i] === "\\") {
        if (/^\\[ \t]*\r?\n/.test(s.slice(i, i + 64))) {
          i++;
          while (/[\s]/.test(s[i] ?? "")) i++;
          continue;
        }
        out += escape();
        continue;
      }
      out += s[i++];
    }
    throw fail("unterminated multi-line string");
  };

  const key = () => {
    const parts = [];
    for (;;) {
      ws();
      if (s[i] === '"') parts.push(basicString());
      else if (s[i] === "'") parts.push(literalString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i, i + 256));
        if (!m) throw fail("expected a key");
        parts.push(m[0]);
        i += m[0].length;
      }
      ws();
      if (s[i] === ".") {
        i++;
        continue;
      }
      return parts;
    }
  };

  const value = () => {
    ws();
    const c = s[i];
    if (s.startsWith('"""', i)) return multiline('"');
    if (s.startsWith("'''", i)) return multiline("'");
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === "[") {
      i++;
      const arr = [];
      for (;;) {
        blank();
        if (s[i] === "]") {
          i++;
          return arr;
        }
        arr.push(value());
        blank();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "]") {
          i++;
          return arr;
        }
        throw fail("expected , or ] in an array");
      }
    }
    if (c === "{") {
      i++;
      const obj = {};
      blank();
      if (s[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        blank();
        const k = key();
        if (s[i] !== "=") throw fail("expected = in an inline table");
        i++;
        assign(obj, k, value());
        blank();
        if (s[i] === ",") {
          i++;
          blank();
          if (s[i] === "}") {
            i++;
            return obj;
          }
          continue;
        }
        if (s[i] === "}") {
          i++;
          return obj;
        }
        throw fail("expected , or } in an inline table");
      }
    }
    const m = /^[A-Za-z0-9_+\-.:]+/.exec(s.slice(i, i + 128));
    if (!m) throw fail(`can't read a value at ${JSON.stringify(s.slice(i, i + 20))}`);
    i += m[0].length;
    const t = m[0];
    if (t === "true") return true;
    if (t === "false") return false;
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(t)) return Number(t.replaceAll("_", ""));
    if (/^0x[0-9a-fA-F_]+$|^0o[0-7_]+$|^0b[01_]+$/.test(t)) return Number(t.replaceAll("_", ""));
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(t)) return Number(t.replaceAll("_", ""));
    if (/^\d{4}-\d{2}-\d{2}([Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(t)) return t;
    throw fail(`can't read the value ${JSON.stringify(t)}`);
  };

  const assign = (table, parts, v) => {
    let node = table;
    for (const p of parts.slice(0, -1)) {
      if (!Object.prototype.hasOwnProperty.call(node, p)) node[p] = {};
      node = node[p];
      if (!isObj(node)) throw fail(`${parts.join(".")} redefines a value`);
    }
    const last = parts[parts.length - 1];
    if (Object.prototype.hasOwnProperty.call(node, last)) throw fail(`duplicate key ${parts.join(".")}`);
    node[last] = v;
  };

  const header = () => {
    const isArray = s[i + 1] === "[";
    i += isArray ? 2 : 1;
    const parts = key();
    if (isArray ? !s.startsWith("]]", i) : s[i] !== "]") throw fail("unterminated table header");
    i += isArray ? 2 : 1;
    let node = root;
    for (const p of parts.slice(0, -1)) {
      if (!Object.prototype.hasOwnProperty.call(node, p)) node[p] = {};
      node = node[p];
      if (Array.isArray(node)) node = node[node.length - 1];
      if (!isObj(node)) throw fail(`${parts.join(".")} is not a table`);
    }
    const last = parts[parts.length - 1];
    if (isArray) {
      if (!Object.prototype.hasOwnProperty.call(node, last)) node[last] = [];
      if (!Array.isArray(node[last])) throw fail(`${parts.join(".")} is not an array of tables`);
      const t = {};
      node[last].push(t);
      current = t;
    } else {
      if (!Object.prototype.hasOwnProperty.call(node, last)) node[last] = {};
      if (!isObj(node[last])) throw fail(`${parts.join(".")} is not a table`);
      current = node[last];
      if (explicitTables.has(current)) throw fail(`table [${parts.join(".")}] defined twice`);
      explicitTables.add(current);
    }
  };

  while (i < s.length) {
    blank();
    if (i >= s.length) break;
    if (s[i] === "[") {
      header();
      eol();
      continue;
    }
    const k = key();
    if (s[i] !== "=") throw fail("expected =");
    i++;
    assign(current, k, value());
    eol();
  }
  return root;
}

function parsePoetry(text, warnings) {
  const doc = parseTomlSubset(text, "poetry.lock");
  if (!Array.isArray(doc.package)) throw new Error("poetry.lock: no [[package]] entries");
  const out = [];
  for (const p of doc.package) {
    if (typeof p.name !== "string" || typeof p.version !== "string") throw new Error("poetry.lock: a [[package]] without name or version");
    const type = p.source?.type;
    if (type && type !== "legacy" && type !== "pypi") {
      warnings.push(`${p.name} ${p.version} comes from a ${type} source${p.source.url ? ` (${p.source.url})` : ""}, not a PyPI release; not listed`);
      continue;
    }
    if (type === "legacy") warnings.push(`${p.name} ${p.version} comes from the index ${p.source.url ?? p.source.reference ?? "?"}, not only PyPI; listed by name, which may be a different package from the PyPI one`);
    const e = { name: pep503(p.name), version: p.version };
    if (typeof p.category === "string") e.dev = p.category === "dev";
    else if (Array.isArray(p.groups)) e.dev = !p.groups.includes("main");
    out.push(e);
  }
  return out;
}

function parseUv(text, warnings) {
  const doc = parseTomlSubset(text, "uv.lock");
  if (!Array.isArray(doc.package)) throw new Error("uv.lock: no [[package]] entries");
  if (doc.version !== undefined && doc.version !== 1) warnings.push(`uv.lock version ${doc.version} is not one agentprime knows (1); read as 1`);
  const own = doc.package.filter((p) => isObj(p.source) && ("editable" in p.source || "virtual" in p.source));
  const direct = new Set();
  const names = (list) => (Array.isArray(list) ? list : []).map((d) => d?.name).filter((n) => typeof n === "string");
  for (const p of own) {
    for (const n of names(p.dependencies)) direct.add(pep503(n));
    for (const field of ["optional-dependencies", "dev-dependencies"]) {
      for (const group of Object.values(isObj(p[field]) ? p[field] : {})) for (const n of names(group)) direct.add(pep503(n));
    }
  }
  const out = [];
  for (const p of doc.package) {
    if (typeof p.name !== "string" || typeof p.version !== "string") {
      if (own.includes(p)) continue;
      throw new Error("uv.lock: a [[package]] without name or version");
    }
    const src = isObj(p.source) ? p.source : {};
    if (own.includes(p)) continue; // the project and its workspace members
    if (typeof src.registry !== "string") {
      const kind = Object.keys(src)[0] ?? "unknown";
      warnings.push(`${p.name} ${p.version} comes from a ${kind} source (${Object.values(src)[0] ?? "?"}), not a PyPI release; not listed`);
      continue;
    }
    const e = { name: pep503(p.name), version: p.version };
    if (own.length) e.direct = direct.has(e.name); // the project's own entry says what it requires
    out.push(e);
  }
  return out;
}

// ================================================================ Cargo.lock

const CRATES_IO = new Set(["registry+https://github.com/rust-lang/crates.io-index", "sparse+https://index.crates.io/"]);

function parseCargo(text, warnings) {
  const doc = parseTomlSubset(text, "Cargo.lock");
  if (!Array.isArray(doc.package)) throw new Error("Cargo.lock: no [[package]] entries");
  if (doc.version !== undefined && ![1, 2, 3, 4].includes(doc.version)) warnings.push(`Cargo.lock version ${doc.version} is not one agentprime knows (1 to 4); read as 4`);
  const out = [];
  for (const p of doc.package) {
    if (typeof p.name !== "string" || typeof p.version !== "string") throw new Error("Cargo.lock: a [[package]] without name or version");
    if (p.source === undefined) continue; // a workspace member or path dependency: the App's own code
    if (CRATES_IO.has(p.source)) {
      out.push({ name: p.name, version: p.version });
    } else if (String(p.source).startsWith("git+")) {
      warnings.push(`${p.name} ${p.version} comes from a git repository (${String(p.source).replace(/#.*$/, "")}), not crates.io; not listed`);
    } else {
      warnings.push(`${p.name} ${p.version} comes from the registry ${p.source}, not crates.io; not listed`);
    }
  }
  return out;
}

// ================================================================ Go

const goVersion = (v) => (v.startsWith("v") ? v : "v" + v);

function parseGoSum(text, warnings) {
  const out = [];
  const versions = new Map();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    if (parts.length !== 3 || !/^h\d+:/.test(parts[2])) throw new Error(`go.sum: line ${i + 1}: expected "module version hash"`);
    const [mod, ver] = parts;
    if (ver.endsWith("/go.mod")) return; // only the module's go.mod was needed, not its code
    if (!isVersion("Go", ver)) throw new Error(`go.sum: line ${i + 1}: ${ver} is not a Go module version`);
    const v = goVersion(ver);
    out.push({ name: mod, version: v });
    if (!versions.has(mod)) versions.set(mod, new Set());
    versions.get(mod).add(v);
  });
  const multi = [...versions].filter(([, set]) => set.size > 1);
  if (multi.length) {
    const [mod, set] = multi[0];
    warnings.push(`go.sum lists more than one version of ${multi.length} module(s) (first: ${mod} ${[...set].join(", ")}); the build uses one, which go.mod says; all are listed`);
  }
  return out;
}

function goUnquote(tok, lineNo) {
  if (tok.startsWith('"')) {
    try {
      return JSON.parse(tok);
    } catch {
      throw new Error(`go.mod: line ${lineNo}: bad quoted string`);
    }
  }
  if (tok.startsWith("`")) return tok.slice(1, -1);
  return tok;
}

function parseGoMod(text, warnings) {
  const requires = [];
  const replaces = new Map();
  let goDirective = null;
  let block = null;
  const directive = (verb, args, comment, lineNo) => {
    if (verb === "require") {
      if (args.length !== 2) throw new Error(`go.mod: line ${lineNo}: require needs a module path and a version`);
      requires.push({ path: goUnquote(args[0], lineNo), version: args[1], indirect: /^indirect(\s*;|\s*$)/.test(comment), lineNo });
    } else if (verb === "replace") {
      const arrow = args.indexOf("=>");
      if (arrow < 1 || arrow > 2 || args.length - arrow - 1 < 1 || args.length - arrow - 1 > 2) throw new Error(`go.mod: line ${lineNo}: can't read the replace directive`);
      const from = goUnquote(args[0], lineNo);
      const fromVersion = arrow === 2 ? args[1] : null;
      const to = goUnquote(args[arrow + 1], lineNo);
      const toVersion = args[arrow + 2] ?? null;
      replaces.set(fromVersion ? `${from}@${fromVersion}` : from, { path: to, version: toVersion });
    } else if (verb === "go") {
      goDirective = args[0] ?? null;
    } else if (!["module", "toolchain", "exclude", "retract", "godebug", "tool", "ignore"].includes(verb)) {
      warnings.push(`go.mod: line ${lineNo}: directive ${verb} not understood; ignored`);
    }
  };
  text.split(/\r?\n/).forEach((raw, i) => {
    const lineNo = i + 1;
    const ci = raw.indexOf("//");
    const comment = ci === -1 ? "" : raw.slice(ci + 2).trim();
    const line = (ci === -1 ? raw : raw.slice(0, ci)).trim();
    if (!line) return;
    if (block) {
      if (line === ")") {
        block = null;
        return;
      }
      directive(block, line.split(/\s+/), comment, lineNo);
      return;
    }
    const tokens = line.split(/\s+/);
    if (tokens[1] === "(" && tokens.length === 2) {
      block = tokens[0];
      return;
    }
    if (tokens[1] === "(") throw new Error(`go.mod: line ${lineNo}: text after "("`);
    directive(tokens[0], tokens.slice(1), comment, lineNo);
  });
  if (block) throw new Error(`go.mod: unterminated ${block} ( block`);

  const goParts = /^(\d+)\.(\d+)/.exec(goDirective ?? "");
  if (!goParts || Number(goParts[1]) < 1 || (Number(goParts[1]) === 1 && Number(goParts[2]) < 17)) {
    warnings.push(`go.mod ${goDirective ? `says go ${goDirective}` : "has no go directive"}: before Go 1.17 it lists only some of the modules the build uses; check go.sum as well`);
  }
  const out = [];
  for (const r of requires) {
    if (!isVersion("Go", r.version)) throw new Error(`go.mod: line ${r.lineNo}: ${r.version} is not a Go module version`);
    const rep = replaces.get(`${r.path}@${r.version}`) ?? replaces.get(r.path);
    if (rep && rep.version === null) {
      warnings.push(`${r.path} ${r.version} is replaced by the local directory ${rep.path}; not listed`);
      continue;
    }
    if (rep) {
      if (!isVersion("Go", rep.version)) throw new Error(`go.mod: the replacement ${rep.path} ${rep.version} is not a Go module version`);
      warnings.push(`${r.path} ${r.version} is replaced by ${rep.path} ${rep.version}; listed as the replacement`);
      out.push({ name: rep.path, version: goVersion(rep.version), direct: !r.indirect });
      continue;
    }
    out.push({ name: r.path, version: goVersion(r.version), direct: !r.indirect });
  }
  return out;
}

// ================================================================ Gemfile.lock

const RUBYGEMS_ORG = /^https?:\/\/rubygems\.org\/?$/i;

function parseGemfileLock(text, warnings) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const directNames = new Set();
  let section = null;
  let remotes = [];
  let inSpecs = false;
  let sawDependencies = false;
  let sawGem = false;
  const flush = () => {
    remotes = [];
    inSpecs = false;
  };
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (raw.trim() === "") return;
    if (/^[A-Z][A-Z ]*$/.test(raw)) {
      section = raw.trim();
      flush();
      if (section === "DEPENDENCIES") sawDependencies = true;
      if (section === "GEM") sawGem = true;
      return;
    }
    if (section === "GEM" || section === "GIT" || section === "PATH" || section === "PLUGIN SOURCE") {
      const field = /^ {2}([a-z_]+):(?: (.*))?$/.exec(raw);
      if (field) {
        if (field[1] === "remote") remotes.push(field[2] ?? "");
        inSpecs = field[1] === "specs";
        return;
      }
      if (inSpecs && /^ {6}\S/.test(raw)) return; // a spec's own dependency
      const spec = /^ {4}(\S+) \(([^)]+)\)$/.exec(raw);
      if (!inSpecs || !spec) throw new Error(`Gemfile.lock: line ${lineNo}: can't read ${JSON.stringify(raw.trim())} in ${section}`);
      const [, name, full] = spec;
      // Bundler writes "version-platform" (1.16.2-x86_64-linux); a gem version itself never has "-" here.
      const dash = full.indexOf("-");
      const version = dash === -1 ? full : full.slice(0, dash);
      if (section !== "GEM") {
        if (!(section === "PATH" && remotes.every((r) => r === "." || r === "./"))) {
          warnings.push(`${name} ${version} comes from ${section === "GIT" ? "a git repository" : section === "PATH" ? "a local path" : "a plugin source"} (${remotes.join(", ") || "?"}), not rubygems.org; not listed`);
        }
        return;
      }
      if (!isVersion("RubyGems", version)) throw new Error(`Gemfile.lock: line ${lineNo}: ${version} is not a RubyGems version`);
      out.push({ name, version });
      return;
    }
    if (section === "DEPENDENCIES") {
      const dep = /^ {2}(\S+?)(!)?(?: \(.*\))?$/.exec(raw);
      if (!dep) throw new Error(`Gemfile.lock: line ${lineNo}: can't read ${JSON.stringify(raw.trim())} in DEPENDENCIES`);
      directNames.add(dep[1]);
    }
    // PLATFORMS, RUBY VERSION, BUNDLED WITH, CHECKSUMS: nothing to list
  });
  if (!sawGem && !out.length && !sawDependencies) throw new Error("Gemfile.lock: no GEM, GIT, PATH or DEPENDENCIES section");
  const otherRemotes = new Set();
  // Re-read the GEM remotes to warn once about gem servers other than rubygems.org.
  let gemSection = false;
  for (const raw of lines) {
    if (/^[A-Z][A-Z ]*$/.test(raw)) gemSection = raw.trim() === "GEM";
    const r = gemSection && /^ {2}remote: (.*)$/.exec(raw);
    if (r && !RUBYGEMS_ORG.test(r[1].trim())) otherRemotes.add(r[1].trim());
  }
  if (otherRemotes.size) warnings.push(`gems also come from ${[...otherRemotes].join(", ")}, not only rubygems.org; they are listed by name, which may be a different gem from the rubygems.org one`);
  if (sawDependencies) for (const e of out) e.direct = directNames.has(e.name);
  return out;
}

// ================================================================ mix.lock

/** An Elixir term reader for mix.lock: maps, tuples, lists, keyword lists, strings, atoms, numbers. */
function parseElixirTerm(text) {
  const s = String(text);
  let i = 0;
  const lineAt = (pos) => s.slice(0, pos).split("\n").length;
  const fail = (msg) => new Error(`mix.lock: line ${lineAt(i)}: ${msg}`);
  const ws = () => {
    for (;;) {
      while (/\s/.test(s[i] ?? "")) i++;
      if (s[i] === "#") while (i < s.length && s[i] !== "\n") i++;
      else return;
    }
  };
  const string = () => {
    i++;
    let out = "";
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\") {
        const n = s[i + 1];
        out += { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "#": "#" }[n] ?? n;
        i += 2;
        continue;
      }
      if (s[i] === "#" && s[i + 1] === "{") throw fail("string interpolation is not supported");
      out += s[i++];
    }
    if (s[i] !== '"') throw fail("unterminated string");
    i++;
    return out;
  };
  const value = () => {
    ws();
    const c = s[i];
    if (s.startsWith("%{", i)) {
      i += 2;
      const map = new Map();
      for (;;) {
        ws();
        if (s[i] === "}") {
          i++;
          return { map };
        }
        let k;
        // "key": value  |  key: value  |  key => value
        if (s[i] === '"') {
          k = string();
          if (s[i] === ":" && /\s/.test(s[i + 1] ?? "")) i++;
          else {
            ws();
            if (!s.startsWith("=>", i)) throw fail("expected => or : after a map key");
            i += 2;
          }
        } else {
          const m = /^([a-z_][A-Za-z0-9_?!]*): /.exec(s.slice(i, i + 256));
          if (m) {
            k = { atom: m[1] };
            i += m[0].length;
          } else {
            k = value();
            ws();
            if (!s.startsWith("=>", i)) throw fail("expected => after a map key");
            i += 2;
          }
        }
        map.set(typeof k === "string" ? k : JSON.stringify(k), value());
        ws();
        if (s[i] === ",") i++;
        else if (s[i] !== "}") throw fail("expected , or } in a map");
      }
    }
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      const items = [];
      for (;;) {
        ws();
        if (s[i] === close) {
          i++;
          return c === "{" ? { tuple: items } : items;
        }
        const kw = c === "[" && /^([a-z_][A-Za-z0-9_?!]*): /.exec(s.slice(i, i + 256));
        if (kw) {
          i += kw[0].length;
          items.push({ tuple: [{ atom: kw[1] }, value()] });
        } else items.push(value());
        ws();
        if (s[i] === ",") i++;
        else if (s[i] !== close) throw fail(`expected , or ${close}`);
      }
    }
    if (c === '"') return string();
    if (c === ":") {
      i++;
      if (s[i] === '"') return { atom: string() };
      const m = /^[A-Za-z_][A-Za-z0-9_@?!]*/.exec(s.slice(i, i + 256));
      if (!m) throw fail("can't read an atom");
      i += m[0].length;
      return { atom: m[0] };
    }
    const m = /^(true|false|nil|-?\d[\d_]*(\.\d+)?)/.exec(s.slice(i, i + 64));
    if (m) {
      i += m[0].length;
      return m[1] === "true" ? true : m[1] === "false" ? false : m[1] === "nil" ? null : Number(m[0].replaceAll("_", ""));
    }
    throw fail(`can't read ${JSON.stringify(s.slice(i, i + 20))}`);
  };
  const v = value();
  ws();
  if (i < s.length) throw fail("text after the map");
  return v;
}

function parseMixLock(text, warnings) {
  const term = parseElixirTerm(text);
  if (!term || !(term.map instanceof Map)) throw new Error("mix.lock: not a map");
  const out = [];
  for (const [key, v] of term.map) {
    const t = v?.tuple;
    if (!Array.isArray(t) || !t[0]?.atom) throw new Error(`mix.lock: ${key} is not a {:hex | :git | :path, ...} tuple`);
    const kind = t[0].atom;
    if (kind === "hex") {
      const name = t[1]?.atom;
      const version = t[2];
      if (typeof name !== "string" || typeof version !== "string") throw new Error(`mix.lock: ${key} has no package name or version`);
      const repo = typeof t[6] === "string" ? t[6] : "hexpm";
      if (repo !== "hexpm") {
        warnings.push(`${name} ${version} comes from the Hex repository ${repo}, not hex.pm; not listed`);
        continue;
      }
      out.push({ name, version });
    } else {
      warnings.push(`${key} comes from ${kind === "git" ? `a git repository (${typeof t[1] === "string" ? t[1] : "?"})` : kind === "path" ? "a local path" : `a ${kind} source`}, not hex.pm; not listed`);
    }
  }
  return out;
}

// ================================================================ packages.lock.json (NuGet)

function parseNugetLock(text, warnings) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (err) {
    throw new Error(`packages.lock.json is not valid JSON: ${err.message}`);
  }
  if (!isObj(lock) || !isObj(lock.dependencies)) throw new Error("packages.lock.json: no dependencies object");
  if (lock.version !== 1 && lock.version !== 2) warnings.push(`packages.lock.json version ${lock.version} is not one agentprime knows (1 or 2); read as 2`);
  const out = [];
  for (const [tfm, deps] of Object.entries(lock.dependencies)) {
    if (!isObj(deps)) throw new Error(`packages.lock.json: dependencies.${tfm} is not an object`);
    for (const [name, e] of Object.entries(deps)) {
      if (!isObj(e)) throw new Error(`packages.lock.json: ${tfm}/${name} is not an object`);
      if (e.type === "Project") continue; // another project in the solution: the App's own code
      if (typeof e.resolved !== "string") {
        warnings.push(`${name} (${tfm}) has no resolved version; not listed`);
        continue;
      }
      out.push({ name, version: e.resolved, direct: e.type === "Direct" });
    }
  }
  return out;
}

// ================================================================ gradle.lockfile (Maven coordinates)

function parseGradle(text) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^empty=/.test(line)) return;
    const m = /^([^:=\s]+):([^:=\s]+):([^:=\s]+)(?:=(\S*))?$/.exec(line);
    if (!m) throw new Error(`gradle.lockfile: line ${i + 1}: expected group:artifact:version[=configurations]`);
    out.push({ name: `${m[1]}:${m[2]}`, version: m[3] });
  });
  return out;
}

// ================================================================ dispatch

const PARSERS = {
  "composer.lock": parseComposer,
  "package-lock.json": parsePackageLockText,
  "npm-shrinkwrap.json": parsePackageLockText,
  "pnpm-lock.yaml": parsePnpm,
  "yarn.lock": parseYarn,
  "bun.lock": parseBun,
  "requirements.txt": parseRequirements,
  "poetry.lock": parsePoetry,
  "uv.lock": parseUv,
  "Pipfile.lock": parsePipfileLock,
  "Cargo.lock": parseCargo,
  "go.sum": parseGoSum,
  "go.mod": parseGoMod,
  "Gemfile.lock": parseGemfileLock,
  "mix.lock": parseMixLock,
  "packages.lock.json": parseNugetLock,
  "gradle.lockfile": parseGradle,
};
