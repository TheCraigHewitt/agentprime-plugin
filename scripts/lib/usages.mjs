// Candidate usage locations of a package in an App, from registry metadata. Reads the App's own files only:
// never vendor/ or node_modules/, never .env, never another App nested inside this one.
// See scripts/CONTRACT.md. Owner: network.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { LOCKFILES, isSkippedDir, toPosix } from "./apps.mjs";
import { resolvePaths } from "./args.mjs";
import { configureFetch } from "./fetch.mjs";
import { sha256 } from "./hash.mjs";
import { ecosystemName } from "./osv.mjs";
import { compare } from "./semver.mjs";
import { npmMetadata, packagistMetadata } from "./registry.mjs";

const TEXT_EXTENSIONS = [".php", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".json", ".yaml", ".yml"];
const TEXT_NAMES = new Set([".env.example"]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 200;

const isTextFile = (name) => name !== ".env" && (TEXT_NAMES.has(name) || TEXT_EXTENSIONS.some((ext) => name.endsWith(ext)));

/**
 * listAppFiles(appDir, { roots? }) -> relative POSIX paths of the text files usages searches, sorted.
 * `roots` (relative POSIX directories) limits the walk to those directories of the App; one that is missing,
 * a link, skipped, outside the App or a nested App is left out.
 */
export function listAppFiles(appDir, { roots } = {}) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = toPosix(relative(appDir, abs));
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (isSkippedDir(rel)) continue;
        // a nested directory with its own lockfile is a separate App
        if (Object.keys(LOCKFILES).some((l) => safeIsFile(join(abs, l)))) continue;
        walk(abs);
      } else if (e.isFile() && isTextFile(e.name) && !(e.name in LOCKFILES)) {
        out.push(rel);
      }
    }
  };
  if (!roots) {
    walk(appDir);
    return out.sort();
  }
  const starts = [...new Set(roots.map((r) => toPosix(String(r)).replace(/^(\.\/)+/, "").replace(/\/+$/, "")))].filter(
    (r) => r !== "" && r !== "." && !r.split("/").includes("..") && !r.startsWith("/"),
  );
  // a root inside another root would be walked twice
  // Each directory on the way to a root must be one the full walk would enter: a real directory, not skipped,
  // not a nested App.
  const enterable = (rel) => {
    try {
      if (!lstatSync(join(appDir, rel)).isDirectory()) return false;
    } catch {
      return false;
    }
    return !isSkippedDir(rel) && !Object.keys(LOCKFILES).some((l) => safeIsFile(join(appDir, rel, l)));
  };
  for (const r of starts.filter((r) => !starts.some((o) => o !== r && r.startsWith(o + "/")))) {
    const parts = r.split("/");
    if (parts.every((_, i) => enterable(parts.slice(0, i + 1).join("/")))) walk(join(appDir, r));
  }
  return [...new Set(out)].sort();
}

function safeIsFile(p) {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const JS_FILE = /\.(m?js|cjs|tsx?|jsx|vue)$/;
const IMPORT_LINE = /\bimport\b|\brequire\s*\(|\bfrom\b|\bexport\b/;
const MANIFEST_OR_CI = (f) => /(^|\/)(package|composer)\.json$/.test(f) || /\.ya?ml$/.test(f);

// npm: the quoted specifiers that name a package or a path inside it ('name', "name/sub", `name`), and the lines
// that can import one (an import, require, from or export line in a JS-like file).
const npmSpecifiers = (name) => ["'", '"', "`"].flatMap((q) => [`${q}${name}${q}`, `${q}${name}/`]);
const isImportLine = (file, line) => JS_FILE.test(file) && IMPORT_LINE.test(line);

/**
 * importsPackage(file, line, name) -> true when `line` of `file` imports the npm package `name` or a path inside
 * it: `import … from 'name'`, `import 'name/sub'`, `require("name")`, `import(`name`)`, `export … from 'name'`.
 * The test `usages` applies to JS-like files, shared so that `inventory`'s `bundled` agrees with it.
 */
export function importsPackage(file, line, name) {
  return isImportLine(file, line) && npmSpecifiers(name).some((p) => line.includes(p));
}

/** The directories an App's client (browser) source conventionally lives in. */
export const CLIENT_DIRS = ["resources", "src", "assets", "app/javascript", "frontend"];
const BUNDLER_CONFIGS = [
  ...["js", "mjs", "cjs", "ts", "mts", "cts"].map((x) => `vite.config.${x}`),
  ...["js", "mjs", "cjs", "ts"].map((x) => `webpack.config.${x}`),
  "webpack.mix.js",
];
const ENTRY_PATH = /(['"`])(?:\.\/)?((?:[\w@-][\w@.-]*\/)*[\w@.-]+\.(?:m?js|cjs|tsx?|jsx|vue))\1/g;

/**
 * clientRoots(appDir) -> CLIENT_DIRS plus the directory of every entry point a vite or webpack config names as a
 * quoted relative path (`input: ['resources/js/app.js']`, `entry: './client/main.ts'`). The config is read as
 * text, never run.
 */
export function clientRoots(appDir) {
  const roots = new Set(CLIENT_DIRS);
  for (const name of BUNDLER_CONFIGS) {
    let text;
    try {
      if (!lstatSync(join(appDir, name)).isFile()) continue;
      text = readFileSync(join(appDir, name), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(ENTRY_PATH)) {
      const dir = m[2].includes("/") ? m[2].slice(0, m[2].lastIndexOf("/")) : null;
      if (dir && !dir.split("/").some((p) => p === ".." || p === "." || p === "node_modules")) roots.add(dir);
    }
  }
  return [...roots];
}

// A quoted specifier's package name: '@scope/name' or 'name', whatever path follows.
const SPECIFIER = /(['"`])((?:@[^'"`/\s]+\/)?[^'"`/\s]+)(?=\1|\/)/g;

/**
 * clientImports(appDir, names) -> Set of the npm package names in `names` that the App's client source imports
 * (JS-like files under clientRoots), by the same test `usages` uses (importsPackage). Never reads node_modules.
 */
export function clientImports(appDir, names) {
  const wanted = new Set(names);
  const found = new Set();
  if (!wanted.size) return found;
  for (const file of listAppFiles(appDir, { roots: clientRoots(appDir) })) {
    if (!JS_FILE.test(file)) continue;
    let text;
    try {
      const abs = join(appDir, file);
      if (lstatSync(abs).size > MAX_FILE_BYTES) continue;
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!isImportLine(file, line)) continue;
      for (const m of line.matchAll(SPECIFIER)) {
        const name = m[2];
        if (wanted.has(name) && !found.has(name) && importsPackage(file, line, name)) found.add(name);
      }
    }
  }
  return found;
}

/**
 * buildMatchers({ package, ecosystem, metadata }) -> [{ pattern, test(file, line) }]
 * Packagist (case-insensitive, as PHP is): each PSR-4/PSR-0 namespace prefix as written and JSON/string-escaped,
 * each provider class, each facade alias as `Alias::` and `use Alias;`, each facade class, the package name.
 * npm: quoted specifiers 'name', "name", `name`, 'name/, "name/, `name/ on import/require/export lines in JS-like
 * files, and "name" anywhere in package.json. Both: bin names as words in package.json/composer.json/YAML.
 */
export function buildMatchers({ package: name, ecosystem, metadata }) {
  const m = [];
  const add = (pattern, test) => {
    if (!m.some((x) => x.pattern === pattern)) m.push({ pattern, test });
  };
  const anywhere = (pattern, ci) => {
    const needle = ci ? pattern.toLowerCase() : pattern;
    add(pattern, (_f, line, lower) => (ci ? lower : line).includes(needle));
  };
  if (ecosystem === "Packagist") {
    for (const ns of metadata.namespaces) {
      anywhere(ns, true);
      if (ns.includes("\\")) anywhere(ns.replaceAll("\\", "\\\\"), true);
    }
    for (const p of metadata.providers) anywhere(p, true);
    for (const [alias, cls] of Object.entries(metadata.aliases)) {
      anywhere(`${alias}::`, true);
      const re = new RegExp(`\\buse\\s+\\\\?${escapeRe(alias)}\\s*;`, "i");
      add(`use ${alias};`, (_f, line) => re.test(line));
      anywhere(cls, true);
    }
    anywhere(name, true);
  } else {
    const PACKAGE_JSON = /(^|\/)package\.json$/;
    for (const pattern of npmSpecifiers(name)) {
      const inManifest = pattern === `"${name}"`; // the bare name in package.json (dependencies, overrides)
      add(pattern, (f, line) => line.includes(pattern) && (isImportLine(f, line) || (inManifest && PACKAGE_JSON.test(f))));
    }
  }
  for (const b of metadata.bin) {
    const word = basename(b);
    if (!word) continue;
    const re = new RegExp(`(^|[^\\w./-])${escapeRe(word)}($|[^\\w-])`);
    add(`bin:${word}`, (f, line) => MANIFEST_OR_CI(f) && re.test(line));
  }
  return m;
}

function searchFiles(appDir, files, matchers) {
  const locations = [];
  for (const file of files) {
    let text;
    try {
      const abs = join(appDir, file);
      if (lstatSync(abs).size > MAX_FILE_BYTES) continue;
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // binary
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();
      for (const { pattern, test } of matchers) {
        if (test(file, line, lower)) {
          locations.push({ file, line: i + 1, pattern, text: line.trim().slice(0, MAX_TEXT) });
        }
      }
    }
  }
  return locations;
}

/** usagesHash(locations) -> sha256 over the sorted unique "file:line:pattern" strings, newline-joined. */
export function usagesHash(locations) {
  const keys = [...new Set(locations.map((l) => `${l.file}:${l.line}:${l.pattern}`))].sort();
  return sha256(keys.join("\n"));
}

/** registryMetadata(name, ecosystem, version) -> { namespaces, providers, aliases, bin } (npm fills only bin) */
export async function registryMetadata(name, ecosystem, version) {
  if (ecosystem === "Packagist") return packagistMetadata(name, version);
  if (ecosystem === "npm") {
    const { bin, exports } = await npmMetadata(name, version);
    return { namespaces: [], providers: [], aliases: {}, bin, exports };
  }
  throw new Error(`unknown ecosystem ${ecosystem}; use Packagist or npm`);
}

/**
 * findUsages(appDir, { package, ecosystem, version }) -> Usages
 * Deterministic for the same files, metadata and version. `version` picks the registry metadata
 * (omitted: Packagist's newest version, npm's "latest"); it does not decide whether the package is installed.
 */
export async function findUsages(appDir, { package: name, ecosystem, version } = {}) {
  if (!name) throw new Error("usages: give a package name");
  if (ecosystem !== "Packagist" && ecosystem !== "npm") throw new Error(`usages: ecosystem must be Packagist or npm, not ${ecosystem}`);
  const metadata = await registryMetadata(name, ecosystem, version);
  const matchers = buildMatchers({ package: name, ecosystem, metadata });
  const locations = searchFiles(appDir, listAppFiles(appDir), matchers).sort(
    (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0)),
  );
  return {
    package: name,
    ecosystem,
    version: version ?? null,
    metadata,
    patterns: matchers.map((x) => x.pattern),
    locations,
    hash: usagesHash(locations),
  };
}

/**
 * usageTarget(inventory, name, ecosystem?) -> { package, ecosystem, version, installed }
 * What `usages` searches for: the ecosystem from the inventory when not given (error if the name is installed
 * in both), and the highest installed version. Not installed: ecosystem guessed from the name (vendor/package
 * is Packagist, anything else npm) unless given, version null.
 */
export function usageTarget(inventory, name, ecosystem) {
  const eco = ecosystem ? ecosystemName(ecosystem) : undefined;
  if (ecosystem && eco !== "Packagist" && eco !== "npm") throw new Error(`--ecosystem must be Packagist or npm, not ${ecosystem}`);
  const hits = (inventory?.packages ?? []).filter((p) => p.name.toLowerCase() === String(name).toLowerCase() && (!eco || p.ecosystem === eco));
  const ecos = [...new Set(hits.map((p) => p.ecosystem))];
  if (ecos.length > 1) throw new Error(`${name} is installed as both a Packagist and an npm package; pass --ecosystem`);
  if (!hits.length) {
    const guess = eco ?? (/^[^@][^/]*\/[^/]+$/.test(name) ? "Packagist" : "npm");
    return { package: name, ecosystem: guess, version: null, installed: false };
  }
  const version = hits.map((p) => p.version).sort(compare).at(-1);
  return { package: hits[0].name, ecosystem: ecos[0], version, installed: true };
}

/** agentprime usages <package> [--app p] [--ecosystem E] */
export async function run(args) {
  const { flags = {}, positional = [] } = args;
  const name = positional[0];
  if (!name) throw new Error("usage: agentprime usages <package> [--app p] [--ecosystem Packagist|npm]");
  const { cwd, appDir } = resolvePaths(flags);
  configureFetch({ cwd });
  const { readInventory } = await import("./inventory.mjs");
  const inventory = await readInventory(appDir, { cwd });
  const target = usageTarget(inventory, name, typeof flags.ecosystem === "string" ? flags.ecosystem : undefined);
  const usages = await findUsages(appDir, target);
  if (!target.installed) usages.installed = false;
  return usages;
}
