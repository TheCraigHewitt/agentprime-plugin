// `agentprime check` and `agentprime save`: validate a model-written Verdict against the facts the script
// produces, fill in what only the script may write, and store the result. See scripts/CONTRACT.md "check rules",
// ADR-0005 (action) and ADR-0006 (checks). Owner: check.
// Reads the App's own files and the Repository's .git metadata, and for vendor evidence only the cited file under
// vendor/laravel/framework, vendor/laravel/nova or vendor/symfony/* and vendor/composer/installed.json.
// Never runs git or anything in the App or in vendor/.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LOCKFILES, toPosix } from "./apps.mjs";
import { resolvePaths } from "./args.mjs";
import { configureFetch } from "./fetch.mjs";
import { hashFiles, sha256 } from "./hash.mjs";
import { readInventory } from "./inventory.mjs";
import { satisfies } from "./constraint.mjs";
import { ecosystemName, parseConstraint, rangeContains, resolveAdvisory } from "./osv.mjs";
import { npmMetadata, packagistMetadata } from "./registry.mjs";
import { bumpClass, compare, normalise } from "./semver.mjs";
import { findUsages, usageTarget } from "./usages.mjs";

const VERDICTS = ["not_affected", "reachable_unproven", "inconclusive"];
// .agentprime/ is agentprime's own output (profiles, Verdicts, package usage notes), never the App's code.
const NEVER_CITE = new Set(["vendor", "node_modules", ".git", ".agentprime"]);
// Files that declare a dependency rather than use it; `usages` reports them, but they need no evidence.
const DECLARATIONS = new Set(["composer.json", "package.json", ...Object.keys(LOCKFILES)]);
// Ids become file names under .agentprime/; nothing that could climb out of that directory.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const isNonEmptyString = (s) => typeof s === "string" && s.trim() !== "";
const posixRel = (p) => String(p).replaceAll("\\", "/").replace(/^(\.\/)+/, "");

// ---------------------------------------------------------------- git HEAD, read from files only

function gitDirAt(dir) {
  const dotGit = join(dir, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  if (st.isFile()) {
    // a worktree or submodule: ".git" is a file holding "gitdir: <path>"
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (m) return resolve(dir, m[1]);
  }
  return null;
}

function readRef(gitDir, commonDir, ref) {
  for (const base of [...new Set([gitDir, commonDir])]) {
    const file = join(base, ...ref.split("/"));
    if (existsSync(file) && statSync(file).isFile()) return readFileSync(file, "utf8").trim();
  }
  const packed = join(commonDir, "packed-refs");
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, "utf8").split(/\r?\n/)) {
      const m = /^([0-9a-f]{40,64}) (.+)$/.exec(line);
      if (m && m[2] === ref) return m[1];
    }
  }
  return null;
}

/**
 * readHead(cwd) -> { commit, gitDir } | null
 * The commit HEAD points at, found the way git finds a repository: `.git` in cwd or the nearest parent, with a
 * `.git` file followed to its gitdir (worktrees, submodules) and refs looked up there, in its commondir, then in
 * packed-refs. null when there is no repository; commit null when HEAD names a ref that doesn't exist yet.
 */
export function readHead(cwd) {
  let dir = resolve(cwd);
  let gitDir = null;
  while (true) {
    gitDir = gitDirAt(dir);
    if (gitDir) break;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  let commonDir = gitDir;
  const commonFile = join(gitDir, "commondir");
  if (existsSync(commonFile)) commonDir = resolve(gitDir, readFileSync(commonFile, "utf8").trim());

  let value = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  for (let depth = 0; depth < 5 && value?.startsWith("ref:"); depth++) {
    value = readRef(gitDir, commonDir, value.slice(4).trim());
  }
  const commit = value && /^[0-9a-f]{40,64}$/.test(value) ? value : null;
  return { commit, gitDir };
}

// ---------------------------------------------------------------- Advisory

/** An Advisory profile check can't use; checkVerdict reports it as a problem, not an error. */
export class ProfileError extends Error {}

/**
 * parseAffectedRange(text) -> { ranges, versions }, for every form normaliseOsv and buildProvisional write:
 * "*" or "" (every version), ">=1.0.0, <1.2.3", "<=1.2.3", "=1.2.3" / "=v1.2.3", alternatives joined by " || ".
 */
export function parseAffectedRange(text) {
  const whole = String(text ?? "").trim();
  if (whole === "" || whole === "*") return { ranges: [{ introduced: "0" }], versions: [] };
  const ranges = [];
  const versions = [];
  for (const alt of whole.split("||").map((a) => a.trim())) {
    if (alt === "") continue;
    if (alt === "*") {
      ranges.push({ introduced: "0" });
      continue;
    }
    const parsed = parseConstraint(alt, { label: "affected_range" });
    ranges.push(...parsed.ranges);
    versions.push(...parsed.versions);
  }
  return { ranges, versions };
}

/** Accepts an Advisory, or an Advisory profile (whose `advisory` block is used). Fills `affected` from `affected_range` when a profile block lacks it. */
export function advisoryFromProfile(input) {
  if (!input || typeof input !== "object") throw new Error("the Advisory profile is not a JSON object");
  const advisory = input.advisory && typeof input.advisory === "object" ? { ...input.advisory } : { ...input };
  if (!isNonEmptyString(advisory.id)) throw new Error("the Advisory profile has no advisory.id");
  if (!isNonEmptyString(advisory.package)) throw new Error("the Advisory profile has no advisory.package");
  if (!Array.isArray(advisory.affected) || !advisory.affected.length) {
    if (typeof advisory.affected_range !== "string") throw new Error("the Advisory profile has neither affected nor affected_range");
    let parsed;
    try {
      parsed = parseAffectedRange(advisory.affected_range);
    } catch (err) {
      throw new ProfileError(`the Advisory profile for ${advisory.id} has an affected_range check can't read (${err.message}); give advisory.affected instead`);
    }
    const { ranges, versions } = parsed;
    advisory.affected = [{ package: advisory.package, ecosystem: advisory.ecosystem, ranges, ...(versions.length ? { versions } : {}) }];
  }
  advisory.aliases = Array.isArray(advisory.aliases) ? advisory.aliases : [];
  advisory.fixed_versions = Array.isArray(advisory.fixed_versions) ? advisory.fixed_versions.map(String) : [];
  return advisory;
}

const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Which package the Verdict is about: installed[0].name, else the Advisory's package. */
function verdictPackage(verdict, advisory) {
  const fromVerdict = Array.isArray(verdict.installed) ? verdict.installed.find((e) => e && isNonEmptyString(e.name)) : null;
  if (fromVerdict) return { name: fromVerdict.name, ecosystem: fromVerdict.ecosystem ?? undefined };
  return { name: advisory.package, ecosystem: advisory.ecosystem ?? undefined };
}

async function resolveForVerdict(verdict, { appDir, inventory }) {
  const id = verdict.advisory_id;
  if (/^PROV-/i.test(id)) {
    const saved = join(appDir, ".agentprime", "profiles", `${id}.json`);
    if (!existsSync(saved)) throw new Error(`${id} is a Provisional Advisory; pass --advisory <profile.json>`);
    return advisoryFromProfile(JSON.parse(readFileSync(saved, "utf8")));
  }
  const named = Array.isArray(verdict.installed) ? verdict.installed.find((e) => e && isNonEmptyString(e.name)) : null;
  if (named) return resolveAdvisory(id, { package: named.name, ecosystem: named.ecosystem });
  // No name in the Verdict: the affected entry the App has installed, else the record's first.
  const first = await resolveAdvisory(id);
  const hit = (first.affected ?? []).find((a) => (inventory?.packages ?? []).some((p) => sameName(p.name, a.package) && p.ecosystem === a.ecosystem));
  if (hit && !(sameName(hit.package, first.package) && hit.ecosystem === first.ecosystem)) {
    return resolveAdvisory(id, { package: hit.package, ecosystem: hit.ecosystem });
  }
  return first;
}

// ---------------------------------------------------------------- installed, fix_hint, action

// npm entries carry `bundled` (imported from client source); Packagist entries never do.
export const installedEntry = (p) => ({
  version: normalise(p.version), lockfile: p.lockfile, direct: p.direct === true, dev: p.dev === true, via: [...(p.via ?? [])],
  ...(p.ecosystem === "npm" || typeof p.bundled === "boolean" ? { bundled: p.bundled === true } : {}),
});
export const entryKey = (e) => JSON.stringify([normalise(e?.version), e?.lockfile, e?.direct === true, e?.dev === true, Array.isArray(e?.via) ? e.via : [], e?.bundled === true]);
const describeEntry = (e) =>
  `${normalise(e?.version)} in ${e?.lockfile} (${e?.direct ? "direct" : "transitive"}${e?.dev ? ", dev" : ""}${e?.bundled ? ", bundled" : ""}${e?.via?.length ? `, via ${e.via.join(" > ")}` : ""})`;

// A reason that clears a package because it is dev-only or build tooling. `dev` only says devDependencies; a
// bundler ships whatever client code imports, so that reason fails for a package the client source imports.
const DEV_ONLY_REASON = /dev[- ]only|devDependenc|build[- ]tool|build[- ]time/i;

/** lowestFix(version, advisory, name, ecosystem) -> the lowest fixed version above `version` that is not itself affected, or null. */
export function lowestFix(version, advisory, name, ecosystem) {
  const candidates = (advisory.fixed_versions ?? [])
    .map(normalise)
    .filter((f) => compare(f, version) > 0 && !rangeContains(advisory.affected ?? [], f, name, ecosystem))
    .sort(compare);
  return candidates[0] ?? null;
}

/**
 * parentConstraint(parent, parentVersion, name, ecosystem) -> the constraint `parent` at `parentVersion` puts on
 * `name`, from the registry. Throws when the registry can't say (lookup failed, version not listed, no such
 * requirement).
 */
async function parentConstraint(parent, parentVersion, name, ecosystem) {
  const meta = ecosystem === "npm" ? await npmMetadata(parent, parentVersion) : await packagistMetadata(parent, parentVersion);
  if (normalise(meta.version) !== normalise(parentVersion)) {
    throw new Error(`the registry lists no ${parent} ${normalise(parentVersion)}`);
  }
  const requires = (ecosystem === "npm" ? meta.dependencies : meta.require) ?? {};
  const key = Object.keys(requires).find((k) => sameName(k, name));
  if (key === undefined) throw new Error(`${parent} ${normalise(parentVersion)} does not list ${name} among its requirements`);
  return requires[key];
}

/**
 * fixHint(name, entries, advisory, ecosystem?, { inventory?, warnings? }?) -> Promise<one sentence>
 * `entries` are the affected installed entries. For a transitive entry, the immediate parent (the last of
 * `via`) is looked up at its installed version (from `inventory`, same lockfile) and its constraint on `name`
 * read: if it already allows the fixed version, the hint is a targeted update of `name`; if not, it names the
 * constraint that blocks it. When the lookup fails the hint names `via[0]` unchecked and a line is pushed to
 * `warnings`.
 */
export async function fixHint(name, entries, advisory, ecosystem, { inventory, warnings } = {}) {
  const eco = ecosystemName(ecosystem ?? advisory?.ecosystem) ?? "Packagist";
  const tool = eco === "npm" ? "npm" : "composer";
  const warn = (w) => {
    if (Array.isArray(warnings) && !warnings.includes(w)) warnings.push(w);
  };
  const parts = [];
  for (const e of entries) {
    const from = normalise(e.version);
    const to = lowestFix(e.version, advisory, name, ecosystem);
    let text;
    if (!to) {
      text = `No fixed version published; ${name} ${from} stays in the affected range until a fixed release exists, so remove or replace it, or wait for one`;
    } else if (e.direct || !e.via?.length) {
      // A transitive entry with no `via` (the lockfile didn't say how it is pulled in): the direct wording,
      // flagged, since there is no parent to check.
      if (!e.direct) warn(`fix_hint: could not resolve how ${name} is pulled in; the hint assumes it is updated directly`);
      text = `Upgrade ${name} to ${to} (${bumpClass(e.version, to)} release)`;
    } else {
      const cls = bumpClass(e.version, to);
      const parent = e.via[e.via.length - 1];
      const unchecked = `Upgrade ${e.via[0]} to pull in ${name} ${to}, or add an override (${cls} release)`;
      const parentVersions = [
        ...new Set(
          (inventory?.packages ?? [])
            .filter((p) => sameName(p.name, parent) && ecosystemName(p.ecosystem) === eco && (!e.lockfile || p.lockfile === e.lockfile))
            .map((p) => normalise(p.version)),
        ),
      ];
      let checked = [];
      try {
        if (!parentVersions.length) throw new Error(`${parent} is not in the inventory${e.lockfile ? ` of ${e.lockfile}` : ""}`);
        for (const pv of parentVersions) {
          const constraint = await parentConstraint(parent, pv, name, eco);
          checked.push({ pv, constraint, allows: satisfies(to, constraint, eco) });
        }
      } catch (err) {
        checked = null;
        warn(`fix_hint: could not read ${parent}'s constraint on ${name} (${err.message}); the hint for ${name} ${from} names ${e.via[0]} without checking whether ${parent} already allows ${to}`);
      }
      if (!checked) {
        text = unchecked;
      } else {
        const blocking = checked.find((c) => !c.allows);
        if (!blocking) {
          const shown = checked.map((c) => `${parent} ${c.pv} allows it (${c.constraint})`).join("; ");
          text = `Run \`${tool} update ${name}\` to move ${name} from ${from} to ${to} (${cls} release); ${shown}`;
        } else {
          const label = e.via.length > 1 ? `${parent} (via ${e.via.slice(0, -1).join(" > ")})` : parent;
          text = `Upgrade ${label} to pull in ${name} ${to}, or add an override (${cls} release); ${parent} ${blocking.pv} requires ${name} ${blocking.constraint}, which does not allow ${to}`;
        }
      }
    }
    if (!parts.includes(text)) parts.push(text);
  }
  return parts.join("; ");
}

/** action(verdict, entries, advisory, name, ecosystem?) -> "none" | "upgrade" (ADR-0005). */
export function computeAction(verdict, entries, advisory, name, ecosystem) {
  if (verdict === "reachable_unproven") return "upgrade";
  if (verdict === "inconclusive") {
    const upgradable = entries.some((e) => {
      if (!e.direct) return false;
      const to = lowestFix(e.version, advisory, name, ecosystem);
      return to !== null && ["patch", "minor"].includes(bumpClass(e.version, to));
    });
    return upgradable ? "upgrade" : "none";
  }
  return "none";
}

// ---------------------------------------------------------------- evidence

export function lineCount(text) {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/** Validate one evidence path; returns { abs, rel } (rel: canonical POSIX path relative to the App) or { problem }. */
export function locateEvidence(appDir, file) {
  if (!isNonEmptyString(file)) return { problem: "has no file" };
  const rel = posixRel(file);
  if (isAbsolute(file) || /^[A-Za-z]:/.test(rel)) return { problem: `file ${file} must be relative to the App directory` };
  const abs = resolve(appDir, rel);
  const back = relative(appDir, abs);
  if (back === "" || back.startsWith("..") || isAbsolute(back)) return { problem: `file ${file} is outside the App` };
  const parts = back.split(sep);
  const banned = parts.find((p) => NEVER_CITE.has(p));
  if (banned === ".agentprime") return { problem: `file ${file} is under .agentprime/, agentprime's own output (a note or a Verdict is never evidence); cite the App's code` };
  if (banned) return { problem: `file ${file} is under ${banned}/, which is never read or cited` };
  const name = parts.at(-1);
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return { problem: `file ${file} is a secrets file, which is never read or cited` };
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { problem: `file ${file} does not exist in the App` };
  }
  if (st.isSymbolicLink()) {
    let real;
    try {
      real = realpathSync(abs);
    } catch {
      return { problem: `file ${file} is a broken link` };
    }
    const realBack = relative(realpathSync(appDir), real);
    if (realBack.startsWith("..") || isAbsolute(realBack)) return { problem: `file ${file} links outside the App` };
    st = statSync(abs);
  }
  if (!st.isFile()) return { problem: `file ${file} is not a file` };
  // The canonical spelling ("app/Http/../Http/X.php" and "app//X.php" are the same file), so coverage and
  // hashes don't depend on how the model wrote the path.
  return { abs, rel: toPosix(back) };
}

// ---------------------------------------------------------------- vendor evidence (ADR-0006, amended 2026-10-31)

// The only installed packages whose code an Assessment may read and cite, because framework behaviour often
// decides a Verdict. Read, never run. Every other directory under vendor/ stays closed.
const VENDOR_PACKAGES = new Set(["laravel/framework", "laravel/nova"]);
const PACKAGE_NAME = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** isVendorPackage(name) -> true for laravel/framework, laravel/nova and any symfony/* package name. */
export function isVendorPackage(name) {
  return typeof name === "string" && PACKAGE_NAME.test(name) && (VENDOR_PACKAGES.has(name) || name.startsWith("symfony/"));
}

// The public repository a vendor evidence link may point to. laravel/nova is a paid, private package: none.
const publicRepo = (name) => (name === "laravel/framework" || name.startsWith("symfony/") ? `https://github.com/${name}` : null);

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** What composer.lock says about one package: { version, reference, url } (reference a 40-hex commit or null), or null. */
function lockedSource(lock, name) {
  const all = [...(Array.isArray(lock?.packages) ? lock.packages : []), ...(Array.isArray(lock?.["packages-dev"]) ? lock["packages-dev"] : [])];
  const p = all.find((x) => x && sameName(x.name, name));
  if (!p) return null;
  const source = p.source && typeof p.source === "object" ? p.source : {};
  const reference = [source.reference, p.dist?.reference].find((r) => typeof r === "string" && COMMIT.test(r)) ?? null;
  return { version: normalise(p.version), reference, url: typeof source.url === "string" ? source.url : null };
}

/**
 * The packages vendor/composer/installed.json says are on disk, as { name -> { version, reference } }, or
 * { problem }. Composer 2 writes { packages: [...] }, Composer 1 a bare list. The file must be the App's own,
 * reached through no link.
 */
function installedOnDisk(appDir) {
  const abs = join(appDir, "vendor", "composer", "installed.json");
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return { problem: "vendor/composer/installed.json does not exist, so which versions vendor/ holds can't be told" };
  }
  if (real !== join(realpathSync(appDir), "vendor", "composer", "installed.json")) return { problem: "vendor/composer/installed.json links outside the App's vendor/" };
  const doc = readJsonFile(real);
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.packages) ? doc.packages : null;
  if (!list) return { problem: "vendor/composer/installed.json is not a list of installed packages" };
  const out = new Map();
  for (const p of list) {
    if (!p || typeof p.name !== "string") continue;
    const reference = [p.source?.reference, p.dist?.reference].find((r) => typeof r === "string" && COMMIT.test(r)) ?? null;
    out.set(p.name.toLowerCase(), { version: normalise(p.version), reference });
  }
  return { packages: out };
}

/**
 * locateVendorFile(appDir, name, file) -> { abs, rel } | { problem }
 * `file` is relative to vendor/<name>/. It may not climb out (`..`), be absolute, name vendor/ again, pass
 * through .git or node_modules, be a secrets file, or resolve through any link to a place outside vendor/<name>/
 * (so a linked vendor/ or package directory is refused too).
 */
export function locateVendorFile(appDir, name, file) {
  const base = `vendor/${name}/`;
  if (!isNonEmptyString(file)) return { problem: "has no file" };
  const rel = posixRel(file);
  if (isAbsolute(file) || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return { problem: `file ${file} must be relative to ${base}` };
  if (rel.startsWith("vendor/")) return { problem: `file ${file} must be relative to ${base}, without vendor/${name}/ in front` };
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length) return { problem: "has no file" };
  if (parts.includes("..")) return { problem: `file ${file} climbs out of ${base}` };
  const banned = parts.find((p) => NEVER_CITE.has(p));
  if (banned) return { problem: `file ${file} is under ${banned}/, which is never read or cited` };
  const last = parts.at(-1);
  if (last === ".env" || (last.startsWith(".env.") && last !== ".env.example")) return { problem: `file ${file} is a secrets file, which is never read or cited` };
  const abs = join(appDir, "vendor", ...name.split("/"), ...parts);
  let real;
  try {
    lstatSync(abs);
    real = realpathSync(abs);
  } catch {
    return { problem: `file ${file} does not exist under ${base}` };
  }
  const root = join(realpathSync(appDir), "vendor", ...name.split("/"));
  if (!real.startsWith(root + sep)) return { problem: `file ${file} links outside ${base}` };
  if (!statSync(real).isFile()) return { problem: `file ${file} is not a file` };
  return { abs: real, rel: parts.join("/") };
}

/** A permalink to the cited line in the package's public repository at the commit composer.lock installs, or null. */
function vendorLink(name, source, rel, line) {
  const repo = publicRepo(name);
  if (!repo || !source?.reference || !source.url) return null;
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(source.url);
  if (!m || m[1].toLowerCase() !== name) return null;
  return `${repo}/blob/${source.reference}/${rel.split("/").map(encodeURIComponent).join("/")}#L${line}`;
}

/**
 * Checks one vendor evidence entry { package, version, file, line, note }. Pushes problems and warnings; returns
 * the stored entry (canonical package, version and file, and the script's `link`) or null when it is rejected.
 * `ctx` caches composer.lock and installed.json across entries.
 */
function checkVendorEntry(e, at, { appDir, inventory, problems, warnings, ctx }) {
  const given = isNonEmptyString(e.package) ? e.package.trim().toLowerCase() : null;
  if (!given) {
    problems.push(`${at} package must be a package name`);
    return null;
  }
  if (!isVendorPackage(given)) {
    problems.push(`${at} package ${e.package} is not one whose code may be cited: only laravel/framework, laravel/nova and symfony/* are read from vendor/`);
    return null;
  }
  const before = problems.length;
  const pkg = inventory.packages.find((p) => p.ecosystem === "Packagist" && sameName(p.name, given));
  if (!pkg) {
    problems.push(`${at} package ${given} is not installed: composer.lock does not list it`);
  } else if (!isNonEmptyString(e.version)) {
    problems.push(`${at} version must be the version of ${given} composer.lock installs (${pkg.version})`);
  } else if (normalise(e.version) !== normalise(pkg.version)) {
    problems.push(`${at} version ${e.version} is not the version of ${given} composer.lock installs (${pkg.version})`);
  } else {
    ctx.disk ??= installedOnDisk(appDir);
    const onDisk = ctx.disk.packages?.get(given);
    if (ctx.disk.problem) {
      problems.push(`${at} ${ctx.disk.problem}`);
    } else if (!onDisk) {
      problems.push(`${at} vendor/composer/installed.json does not list ${given}; vendor/ is out of step with composer.lock`);
    } else if (onDisk.version !== normalise(pkg.version)) {
      problems.push(`${at} vendor/ holds ${given} ${onDisk.version}, but composer.lock installs ${pkg.version}; vendor/ is out of step with composer.lock, so its lines are not the installed version's`);
    } else {
      ctx.lock ??= readJsonFile(join(appDir, "composer.lock"));
      const locked = lockedSource(ctx.lock, given);
      if (locked?.reference && onDisk.reference && locked.reference !== onDisk.reference) {
        problems.push(`${at} vendor/ holds ${given} at commit ${onDisk.reference}, but composer.lock installs ${locked.reference}; vendor/ is out of step with composer.lock`);
      }
    }
  }
  const where = locateVendorFile(appDir, given, e.file);
  if (where.problem) {
    problems.push(`${at} ${where.problem}`);
  } else {
    const lines = lineCount(readFileSync(where.abs, "utf8"));
    if (!Number.isInteger(e.line) || e.line < 1 || e.line > lines) {
      problems.push(`${at} line ${JSON.stringify(e.line)} is not a line of vendor/${given}/${where.rel} (1..${lines})`);
    }
  }
  if (problems.length > before) return null;

  ctx.lock ??= readJsonFile(join(appDir, "composer.lock"));
  const link = vendorLink(given, lockedSource(ctx.lock, given), where.rel, e.line);
  if (!link && publicRepo(given)) {
    warnings.push(`${at}: composer.lock does not name ${given}'s public GitHub repository and an installed commit, so this evidence has no link`);
  }
  ctx.manifest ??= readJsonFile(join(appDir, "composer.json")) ?? {};
  const patches = ctx.manifest.extra?.patches;
  if ((patches && typeof patches === "object" && Object.keys(patches).some((k) => sameName(k, given))) || ctx.manifest.extra?.["patches-file"]) {
    warnings.push(`${at}: composer.json applies patches to vendor/ (composer-patches), so the copy check read may differ from the released ${given} ${pkg.version} the link shows`);
  }
  const { link: _ignored, ...rest } = e;
  return { ...rest, package: given, version: pkg.version, file: where.rel, link };
}

/** "; to cite <package> code, …" when an App evidence path points into an allowed vendor package, else "". */
function vendorHint(file) {
  const m = /^vendor\/([^/]+\/[^/]+)\/(.+)$/.exec(posixRel(file ?? ""));
  if (!m || !isVendorPackage(m[1].toLowerCase())) return "";
  return `; to cite ${m[1]} code, give it as vendor evidence: package ${m[1]}, version (the installed one), file ${m[2]} (relative to vendor/${m[1]}/), line and note`;
}

/**
 * evidenceHash(appDir, evidence) -> "sha256:<hex>", the Verdict cache's hashes.evidence.
 * With App evidence only it is hashFiles over the distinct files, as before vendor evidence existed. With vendor
 * evidence it also covers, per entry, the package, the version and commit composer.lock installs now, the file
 * and that file's content (or "<missing>"), so a new lockfile version or a changed vendor/ copy is a miss.
 */
export function evidenceHash(appDir, evidence) {
  const list = (Array.isArray(evidence) ? evidence : []).filter((e) => e && typeof e === "object");
  const isVendor = (e) => e.package !== undefined && e.package !== null;
  const appHash = hashFiles(appDir, [...new Set(list.filter((e) => !isVendor(e)).map((e) => e.file).filter((f) => typeof f === "string"))]);
  const vendor = list.filter(isVendor);
  if (!vendor.length) return appHash;
  const lock = readJsonFile(join(appDir, "composer.lock"));
  const parts = vendor.map((e) => {
    const name = String(e.package).trim().toLowerCase();
    const locked = lockedSource(lock, name);
    const where = isVendorPackage(name) ? locateVendorFile(appDir, name, e.file) : { problem: "not allowed" };
    const content = where.problem ? "<missing>" : sha256(readFileSync(where.abs));
    return JSON.stringify([name, locked?.version ?? null, locked?.reference ?? null, where.rel ?? String(e.file), content]);
  });
  return sha256(JSON.stringify({ app: appHash, vendor: [...new Set(parts)].sort() }));
}

// ---------------------------------------------------------------- the check

const KNOWN_KEYS = new Set([
  "advisory_id", "app", "installed", "verdict", "reason", "evidence", "fix_hint", "action", "pr_url", "hashes",
  "assessed_at", "commit", "warnings",
]);
// Part of a stored Verdict, but written only by `report` after the run, from the run's own result; whatever a
// model wrote there is dropped.
const REPORT_KEYS = ["cost_usd", "turns"];

/**
 * checkVerdict(verdict, { appDir, cwd, advisory? }) -> { ok: true, verdict } | { ok: false, problems: string[] }
 * `advisory` is an Advisory or an Advisory profile; without it the Advisory is resolved by `verdict.advisory_id`.
 * Every problem is collected; nothing stops at the first. Throws only when the facts themselves can't be read
 * (no lockfile, network failure), which is an error, not a rejection.
 */
export async function checkVerdict(verdict, { appDir, cwd, advisory } = {}) {
  appDir = resolve(appDir ?? ".");
  cwd = resolve(cwd ?? appDir);
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) return { ok: false, problems: ["the Verdict is not a JSON object"] };
  const problems = [];
  const warnings = [];

  if (!isNonEmptyString(verdict.advisory_id)) {
    return { ok: false, problems: ["advisory_id must be a non-empty string"] };
  }
  if (!SAFE_ID.test(verdict.advisory_id)) {
    return { ok: false, problems: [`advisory_id ${JSON.stringify(verdict.advisory_id)} is not an advisory id`] };
  }

  const inventory = readInventory(appDir, { cwd });
  // The inventory's own limits (unsupported lockfiles, a missing manifest) qualify everything below.
  warnings.push(...(inventory.warnings ?? []));
  let adv;
  try {
    adv = advisory ? advisoryFromProfile(advisory) : await resolveForVerdict(verdict, { appDir, inventory });
  } catch (err) {
    if (err instanceof ProfileError) return { ok: false, problems: [err.message], ...(warnings.length ? { warnings } : {}) };
    throw err;
  }
  if (!SAFE_ID.test(adv.id)) {
    problems.push(`the Advisory's id ${JSON.stringify(adv.id)} is not an advisory id`);
  } else if (![adv.id, ...adv.aliases].some((x) => sameName(x, verdict.advisory_id))) {
    problems.push(`advisory_id ${verdict.advisory_id} is not the Advisory given (${adv.id})`);
  } else if (verdict.advisory_id !== adv.id) {
    // Stored under the canonical id, next to the profile; keep what the model wrote.
    const how = sameName(verdict.advisory_id, adv.id) ? "is written differently from" : "is an alias of";
    warnings.push(`advisory_id ${verdict.advisory_id} ${how} the Advisory's id ${adv.id}; the Verdict uses ${adv.id}`);
  }
  if (adv.withdrawn) warnings.push(`the Advisory was withdrawn on ${adv.withdrawn}`);

  // 6. verdict and reason
  if (verdict.verdict === "exploitable") {
    problems.push("verdict exploitable: there is no Sandbox, so it cannot be proven here; use reachable_unproven with the traced path");
  } else if (!VERDICTS.includes(verdict.verdict)) {
    problems.push(`verdict must be one of ${VERDICTS.join(", ")}, not ${JSON.stringify(verdict.verdict)}`);
  }
  if (!isNonEmptyString(verdict.reason)) problems.push("reason must be a non-empty string");

  // app
  const app = { path: inventory.app.path, lockfiles: inventory.app.lockfiles };
  if (verdict.app !== undefined) {
    if (!verdict.app || typeof verdict.app !== "object" || verdict.app.path !== app.path) {
      problems.push(`app.path ${JSON.stringify(verdict.app?.path)} is not the App checked (${app.path}); pass --app`);
    }
  }

  // 1. installed
  const { name: wanted, ecosystem: wantedEco } = verdictPackage(verdict, adv);
  const ecosystem = wantedEco ?? adv.ecosystem;
  const pkgs = inventory.packages.filter((p) => sameName(p.name, wanted) && (!ecosystem || p.ecosystem === ecosystem));
  const name = pkgs[0]?.name ?? wanted;
  const installed = pkgs.map(installedEntry);
  if (!installed.length) {
    // A lockfile the inventory couldn't parse may hold the package: say so rather than "not installed".
    const eco = ecosystemName(ecosystem);
    const unparsed = app.lockfiles.filter(
      (l) => (!eco || LOCKFILES[l] === eco) && (inventory.warnings ?? []).some((w) => w.startsWith(`${l} `) && /not supported/.test(w)),
    );
    if (unparsed.length) {
      for (const l of unparsed) problems.push(`${l} is not supported yet; cannot tell whether ${wanted} is installed`);
    } else {
      problems.push(`package not installed: ${wanted} is not in ${app.lockfiles.join(" or ")}`);
    }
  }
  if (verdict.installed !== undefined) {
    if (!Array.isArray(verdict.installed)) {
      problems.push("installed must be a list; leave it out and check fills it");
    } else {
      const ours = new Map(installed.map((e) => [entryKey(e), e]));
      const theirs = new Map(verdict.installed.map((e) => [entryKey(e), e]));
      const missing = [...ours.keys()].filter((k) => !theirs.has(k)).map((k) => describeEntry(ours.get(k)));
      const extra = [...theirs.keys()].filter((k) => !ours.has(k)).map((k) => describeEntry(theirs.get(k)));
      if (missing.length || extra.length) {
        const parts = [];
        if (extra.length) parts.push(`not in the inventory: ${extra.join("; ")}`);
        if (missing.length) parts.push(`missing from the Verdict: ${missing.join("; ")}`);
        problems.push(`installed differs from the inventory (${parts.join("; ")}); leave installed out and check fills it`);
      }
    }
  }

  // 8 (range). Only installed versions inside the affected range need a Verdict.
  const affectedEntries = installed.filter((e) => rangeContains(adv.affected, e.version, name, ecosystem));
  if (installed.length && !affectedEntries.length) {
    const versions = [...new Set(installed.map((e) => e.version))].join(", ");
    problems.push(`installed version ${versions} is outside the affected range (${adv.affected_range ?? "see the Advisory"}); no Verdict needed`);
  }

  // 3. evidence
  const evidence = verdict.evidence ?? [];
  const evidenceFiles = [];
  const canonicalFiles = []; // by evidence index
  const vendorEntries = []; // by evidence index: the stored form of a vendor evidence entry
  let appEvidenceCount = 0;
  const vendorCtx = {};
  if (!Array.isArray(evidence)) {
    problems.push("evidence must be a list of { file, line, note }");
  } else {
    evidence.forEach((e, i) => {
      const at = `evidence[${i}]`;
      if (!e || typeof e !== "object") return problems.push(`${at} must be an object with file, line and note`);
      // Vendor evidence names its package; App evidence never does (ADR-0006, amended 2026-10-31).
      if (e.package !== undefined && e.package !== null) {
        vendorEntries[i] = checkVendorEntry(e, at, { appDir, inventory, problems, warnings, ctx: vendorCtx });
        if (!isNonEmptyString(e.note)) problems.push(`${at} note must be a non-empty string`);
        return;
      }
      appEvidenceCount++;
      const where = locateEvidence(appDir, e.file);
      if (where.problem) {
        problems.push(`${at} ${where.problem}${vendorHint(e.file)}`);
      } else {
        evidenceFiles.push(where.rel);
        canonicalFiles[i] = where.rel;
        const lines = lineCount(readFileSync(where.abs, "utf8"));
        if (!Number.isInteger(e.line) || e.line < 1 || e.line > lines) {
          problems.push(`${at} line ${JSON.stringify(e.line)} is not a line of ${where.rel} (1..${lines})`);
        }
      }
      if (!isNonEmptyString(e.note)) problems.push(`${at} note must be a non-empty string`);
    });
  }
  const evidenceCount = Array.isArray(evidence) ? evidence.length : 0;

  // usages: rule 4 and hashes.usages
  // (not installed: the Verdict is already rejected, and there is no version to search for)
  const usages = installed.length ? await findUsages(appDir, usageTarget(inventory, name, ecosystem)) : null;

  // 4. not_affected covers every usages file
  if (verdict.verdict === "not_affected" && usages) {
    if (evidenceCount < 1) problems.push("not_affected needs at least one evidence entry");
    const cited = new Set(evidenceFiles);
    const files = [...new Set(usages.locations.map((l) => l.file))].filter((f) => !DECLARATIONS.has(basename(f)));
    const uncovered = files.filter((f) => !cited.has(f));
    if (uncovered.length) {
      problems.push(
        `not_affected must cover every file usages found for ${name}; no evidence for ${uncovered.join(", ")}`,
      );
    }
  }

  // 4b. not_affected because "dev-only" fails for a package the client source imports (bundled)
  if (verdict.verdict === "not_affected" && isNonEmptyString(verdict.reason) && DEV_ONLY_REASON.test(verdict.reason) && installed.some((e) => e.bundled)) {
    const importers = [...new Set((usages?.locations ?? []).filter((l) => !DECLARATIONS.has(basename(l.file))).map((l) => l.file))];
    problems.push(
      `the reason relies on ${name} being dev-only or build tooling, but ${name} is imported from the App's client source` +
        `${importers.length ? ` (${importers.join(", ")})` : ""} (bundled: true), so the browser build ships it whatever package.json says;` +
        " devDependencies does not mean not shipped. Give a reason that holds for shipped code",
    );
  }

  // 5. reachable_unproven is a traced path
  if (verdict.verdict === "reachable_unproven" && evidenceCount < 2) {
    problems.push("reachable_unproven needs at least two evidence entries: where input enters, and the vulnerable call");
  } else if (verdict.verdict === "reachable_unproven" && appEvidenceCount < 1) {
    problems.push("reachable_unproven needs at least one evidence entry in the App's own code: framework code alone is not a path through this App");
  }

  // 2. commit and assessed_at
  let commit = null;
  let head;
  try {
    head = readHead(cwd);
  } catch (err) {
    head = undefined;
    warnings.push(`could not read the Repository's HEAD (${err.message}); commit is null`);
  }
  if (head === null) {
    warnings.push("no git repository at --cwd or above it; commit is null, so evidence was checked against the working tree only");
  } else if (head && !head.commit) {
    warnings.push("HEAD names a branch with no commit yet; commit is null");
  } else if (head) {
    commit = head.commit;
  }
  if (verdict.commit !== undefined && verdict.commit !== null) {
    const given = String(verdict.commit).toLowerCase();
    const matches = commit && (given === commit || (given.length >= 7 && /^[0-9a-f]+$/.test(given) && commit.startsWith(given)));
    if (!matches) {
      problems.push(`commit ${verdict.commit} is not the Repository's HEAD (${commit ?? "unknown"}); the working tree is what check verifies, so leave commit out`);
    }
  }
  let assessedAt = verdict.assessed_at;
  if (assessedAt === undefined || assessedAt === null) assessedAt = new Date().toISOString();
  else if (typeof assessedAt !== "string" || Number.isNaN(Date.parse(assessedAt))) problems.push(`assessed_at ${JSON.stringify(assessedAt)} is not an ISO 8601 time`);

  const dropped = Object.keys(verdict).filter((k) => !KNOWN_KEYS.has(k) && !REPORT_KEYS.includes(k));
  if (dropped.length) warnings.push(`dropped fields that are not part of a Verdict: ${dropped.join(", ")}`);
  const reportOnly = REPORT_KEYS.filter((k) => k in verdict);
  if (reportOnly.length) warnings.push(`dropped ${reportOnly.join(" and ")}: only agentprime report writes them, after a run`);

  if (problems.length) return { ok: false, problems, ...(warnings.length ? { warnings } : {}) };

  // 7, 8. action and fix_hint (always the script's, whatever the model wrote)
  const action = computeAction(verdict.verdict, affectedEntries, adv, name, ecosystem);
  const hint = await fixHint(name, affectedEntries, adv, ecosystem, { inventory, warnings });

  // 9. hashes
  const storedEvidence = evidence.map((e, i) => {
    if (vendorEntries[i]) return vendorEntries[i];
    const { link: _scriptOnly, ...rest } = e; // `link` is written by check, and only on vendor evidence
    return { ...rest, file: canonicalFiles[i] };
  });
  const hashes = { usages: usages.hash, evidence: evidenceHash(appDir, storedEvidence) };
  const appProfile = join(appDir, ".agentprime", "profile.json");
  if (existsSync(appProfile)) hashes.profile = sha256(readFileSync(appProfile, "utf8"));

  const out = {
    advisory_id: adv.id,
    app, // always the script's; a model-supplied app was only compared, above
    installed,
    verdict: verdict.verdict,
    reason: verdict.reason,
    evidence: storedEvidence,
    fix_hint: hint,
    action,
    pr_url: verdict.pr_url ?? null,
    hashes,
    assessed_at: assessedAt,
    commit,
  };
  if (warnings.length) out.warnings = warnings;
  return { ok: true, verdict: out };
}

// ---------------------------------------------------------------- CLI

function readJsonInput(source, what) {
  if (!source) throw new Error(`give the ${what} as a file path, or - to read it from stdin, or with --json '<json>'`);
  let text;
  try {
    text = source === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(source), "utf8");
  } catch (err) {
    throw new Error(`can't read the ${what} from ${source === "-" ? "stdin" : source}: ${err.message}`);
  }
  return parseJsonText(text, what);
}

function parseJsonText(text, what) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`the ${what} is not valid JSON: ${err.message}`);
  }
}

/**
 * The JSON document a command was given: `--json '<string>'` (so the skill passes it as one argument and needs
 * no pipe through echo, cat or printf; ADR-0006), else the positional file path or `-` for stdin. Both at once
 * is an error.
 */
export function documentInput(flags, source, what) {
  if (flags.json === undefined) return readJsonInput(source, what);
  if (typeof flags.json !== "string") throw new Error(`--json needs the ${what} as a JSON string`);
  if (source !== undefined) throw new Error(`give the ${what} either with --json or as ${source}, not both`);
  return parseJsonText(flags.json, what);
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** agentprime check <verdict.json|-> | --json '<verdict>' [--app p] [--cwd c] [--advisory <profile.json>] */
export async function run(args) {
  const { flags = {}, positional = [] } = args;
  const { cwd, appDir } = resolvePaths(flags);
  configureFetch({ cwd });
  const verdict = documentInput(flags, positional[0], "Verdict");
  const advisory = typeof flags.advisory === "string" ? readJsonInput(flags.advisory, "Advisory profile") : undefined;
  const result = await checkVerdict(verdict, { appDir, cwd, advisory });
  if (!result.ok) {
    const report = { ok: false, problems: result.problems, ...(result.warnings ? { warnings: result.warnings } : {}) };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    const err = new Error(`Verdict rejected: ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"} (listed on stdout)`);
    err.exitCode = 2;
    throw err;
  }
  writeJson(join(appDir, ".agentprime", "verdicts", `${result.verdict.advisory_id}.json`), result.verdict);
  return result.verdict;
}

/**
 * agentprime save <profile|verdict> <-|file> | --json '<doc>' [--app p] [--cwd c] -> { path }
 * A profile goes to .agentprime/profiles/<id>.json. A Verdict saved here is unchecked, so it goes to
 * .agentprime/drafts/<id>.json and never to verdicts/, which holds only what `check` accepted.
 */
export async function runSave(args) {
  const { flags = {}, positional = [] } = args;
  const [kind, given] = positional;
  if (kind !== "profile" && kind !== "verdict") throw new Error("usage: agentprime save <profile|verdict> <-|file> | --json '<json>' [--app p]");
  const { cwd, appDir } = resolvePaths(flags);
  const what = kind === "profile" ? "Advisory profile" : "Verdict";
  const doc = flags.json === undefined ? readJsonInput(given ?? "-", what) : documentInput(flags, given, what);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`the ${kind} is not a JSON object`);
  let id;
  if (kind === "profile") {
    id = doc.advisory?.id;
    if (!isNonEmptyString(id)) throw new Error("the Advisory profile has no advisory.id");
  } else {
    id = doc.advisory_id;
    if (!isNonEmptyString(id)) throw new Error("the Verdict has no advisory_id");
    if (!VERDICTS.includes(doc.verdict) && doc.verdict !== "exploitable") {
      throw new Error(`verdict must be one of ${VERDICTS.join(", ")}, exploitable; not ${JSON.stringify(doc.verdict)}`);
    }
  }
  if (!SAFE_ID.test(id)) throw new Error(`${JSON.stringify(id)} is not an advisory id`);
  const file = join(appDir, ".agentprime", kind === "profile" ? "profiles" : "drafts", `${id}.json`);
  writeJson(file, doc);
  return { path: toPosix(relative(cwd, file)) };
}
