// Per-ecosystem version order, for upgrade plans and range checks outside Packagist and npm's own path.
// Browser-safe: pure ESM, no `node:` imports, no fs, no network. See scripts/CONTRACT.md "Lockfiles, versions and
// upgrade plans (browser-safe)". Owner: core.
import { compare as composerCompare, normalise as composerNormalise } from "./semver.mjs";

// OSV ecosystem names, in any case, to the comparison used.
const KINDS = {
  npm: "semver",
  "crates.io": "semver",
  hex: "semver",
  go: "go",
  packagist: "composer",
  pypi: "pep440",
  rubygems: "rubygems",
  nuget: "nuget",
  maven: "maven",
};

/** The OSV ecosystem names this module knows, as OSV writes them. */
export const ECOSYSTEMS = ["npm", "crates.io", "Hex", "Go", "Packagist", "PyPI", "RubyGems", "NuGet", "Maven"];

const kindOf = (ecosystem) => KINDS[String(ecosystem ?? "").toLowerCase()] ?? null;

/** isReliable(ecosystem) -> boolean. False for Maven (its order is not implemented) and for unknown ecosystems. */
export function isReliable(ecosystem) {
  const k = kindOf(ecosystem);
  return k !== null && k !== "maven";
}

const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);
const cmpNum = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
const cmpStr = (a, b) => (a === b ? 0 : a < b ? -1 : 1); // code unit order, which is ASCII order for these strings
// Numeric identifiers can be longer than 2^53 (Go pseudo-version timestamps are 14 digits, fine; others are not).
const cmpDigits = (a, b) => {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  return x.length !== y.length ? cmpNum(x.length, y.length) : cmpStr(x, y);
};

class VersionError extends Error {}
const bad = (ecosystem, v) => new VersionError(`not a ${ecosystem} version: ${JSON.stringify(v)}`);

// ---------------------------------------------------------------- SemVer 2.0 (npm, crates.io, Hex) and Go

// "0" is OSV's "from the beginning" and some records write two-part versions; missing parts read as 0. A leading
// v is tolerated (npm's own parser accepts it).
const SEMVER = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function parseSemver(v, ecosystem) {
  const m = SEMVER.exec(String(v ?? "").trim());
  if (!m) throw bad(ecosystem, v);
  const pre = m[4] === undefined ? [] : m[4].split(".");
  if (pre.some((p) => p === "")) throw bad(ecosystem, v);
  return { parts: [m[1], m[2] ?? "0", m[3] ?? "0"], pre };
}

function cmpPreIds(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1; // a shorter set of identifiers is lower when all before are equal
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    const c = an && bn ? cmpDigits(a[i], b[i]) : an ? -1 : bn ? 1 : cmpStr(a[i], b[i]);
    if (c) return c;
  }
  return 0;
}

function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    const c = cmpDigits(a.parts[i], b.parts[i]);
    if (c) return c;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1; // a pre-release is lower than its release
  if (!b.pre.length) return -1;
  return cmpPreIds(a.pre, b.pre);
}

// Go: semver with a leading v (OSV's Go records write it without; both are read). Build metadata such as
// "+incompatible" does not affect order. A pseudo-version (v0.0.0-20230101120000-abcdef123456,
// v1.2.4-0.20230101120000-abcdef123456, v1.2.3-pre.0.20230101120000-abcdef123456) is a pre-release of the version
// it builds on, so it sorts by that base: above the release before it, below the release it precedes, and among
// pseudo-versions of one base by its UTC timestamp. That is plain SemVer precedence; nothing extra is needed.
const parseGo = (v) => parseSemver(v, "Go");

// ---------------------------------------------------------------- Packagist (Composer)

// semver.mjs reads stability suffixes (dev < alpha < beta < RC). Composer also has patch releases ("-p1", "-pl2",
// "-patch3"), which sort above the plain release; semver.mjs would put them below, so they are handled here.
const COMPOSER_PATCH = /^(.*?\d)[-._]?(?:p|pl|patch)[-._]?(\d*)$/i;

function cmpComposer(a, b) {
  const pa = COMPOSER_PATCH.exec(composerNormalise(a));
  const pb = COMPOSER_PATCH.exec(composerNormalise(b));
  if (!pa && !pb) return composerCompare(a, b);
  const base = composerCompare(pa ? pa[1] : a, pb ? pb[1] : b);
  if (base) return base;
  if (!pa) return -1;
  if (!pb) return 1;
  return cmpNum(Number(pa[2] || 0), Number(pb[2] || 0));
}

function checkComposer(v) {
  const s = composerNormalise(v);
  // A branch ("dev-main", "1.x-dev") has no place in a release order.
  if (!/^\d+(\.\d+)*([-._]?(dev|alpha|a|beta|b|rc|p|pl|patch|stable)[-._]?\d*)*$/i.test(s.replace(/\+.*$/, ""))) throw bad("Packagist", v);
  if (/-dev$|^dev-/i.test(s)) throw bad("Packagist", v);
}

// ---------------------------------------------------------------- PyPI (PEP 440)

const PEP440 = new RegExp(
  "^v?" +
    "(?:(\\d+)!)?" + // epoch
    "(\\d+(?:\\.\\d+)*)" + // release
    "(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\\d+)?)?" + // pre
    "(?:-(\\d+)|[-_.]?(post|rev|r)[-_.]?(\\d+)?)?" + // post
    "(?:[-_.]?(dev)[-_.]?(\\d+)?)?" + // dev
    "(?:\\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$", // local
  "i",
);
const PRE_RANK = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };
const NEG = -Infinity;
const POS = Infinity;

function parsePep440(v) {
  const m = PEP440.exec(String(v ?? "").trim());
  if (!m) throw bad("PyPI", v);
  const [, epoch, release, preL, preN, postN1, postL, postN2, devL, devN, local] = m;
  const rel = release.split(".").map(Number);
  while (rel.length > 1 && rel[rel.length - 1] === 0) rel.pop(); // 1.0 == 1.0.0
  const hasPost = postN1 !== undefined || postL !== undefined;
  const hasDev = devL !== undefined;
  // The key `packaging` uses: a dev release with no pre or post sorts before every pre-release of its release.
  let pre;
  if (preL === undefined && !hasPost && hasDev) pre = [NEG];
  else if (preL === undefined) pre = [POS];
  else pre = [PRE_RANK[preL.toLowerCase()], Number(preN ?? 0)];
  const post = hasPost ? Number(postN1 ?? postN2 ?? 0) : NEG;
  const dev = hasDev ? Number(devN ?? 0) : POS;
  const loc = local === undefined ? null : local.toLowerCase().split(/[-_.]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  return { epoch: Number(epoch ?? 0), rel, pre, post, dev, local: loc };
}

function cmpArr(a, b, cmpItem = cmpNum) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const c = cmpItem(a[i], b[i]);
    if (c) return c;
  }
  return 0;
}

function cmpPep440(a, b) {
  return (
    cmpNum(a.epoch, b.epoch) ||
    cmpArr(a.rel, b.rel) ||
    cmpArr(a.pre, b.pre) ||
    cmpNum(a.post, b.post) ||
    cmpNum(a.dev, b.dev) ||
    cmpLocal(a.local, b.local)
  );
}

// No local label sorts first; then segment by segment, a string segment below a number, strings by code unit.
function cmpLocal(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return cmpArr(a, b, (x, y) => {
    const xn = typeof x === "number";
    const yn = typeof y === "number";
    if (xn && yn) return cmpNum(x, y);
    if (xn) return 1;
    if (yn) return -1;
    return cmpStr(x, y);
  });
}

// ---------------------------------------------------------------- RubyGems (Gem::Version)

const GEM = /^[0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseGem(v) {
  let s = String(v ?? "").trim();
  if (s === "") s = "0";
  if (!GEM.test(s)) throw bad("RubyGems", v);
  s = s.replaceAll("-", ".pre.");
  const segs = (s.match(/[0-9]+|[a-z]+/gi) ?? []).map((t) => (/^\d+$/.test(t) ? Number(t) : t));
  // canonical_segments: the numeric run and the rest (from the first letter segment) each lose trailing zeros.
  const firstString = segs.findIndex((x) => typeof x === "string");
  const numeric = firstString === -1 ? segs : segs.slice(0, firstString);
  const rest = firstString === -1 ? [] : segs.slice(firstString);
  const trim = (arr) => {
    const out = [...arr];
    while (out.length && out[out.length - 1] === 0) out.pop();
    return out;
  };
  return [...trim(numeric), ...trim(rest)];
}

function cmpGem(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x === y) continue;
    const xs = typeof x === "string";
    const ys = typeof y === "string";
    if (xs && !ys) return -1; // a letter segment makes it a pre-release
    if (!xs && ys) return 1;
    return xs ? cmpStr(x, y) : cmpNum(x, y);
  }
  return 0;
}

// ---------------------------------------------------------------- NuGet (NuGetVersion)

const NUGET = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function parseNuget(v) {
  const m = NUGET.exec(String(v ?? "").trim());
  if (!m) throw bad("NuGet", v);
  const pre = m[5] === undefined ? [] : m[5].split(".");
  if (pre.some((p) => p === "")) throw bad("NuGet", v);
  return { parts: [m[1], m[2] ?? "0", m[3] ?? "0", m[4] ?? "0"], pre: pre.map((p) => p.toLowerCase()) };
}

function cmpNuget(a, b) {
  for (let i = 0; i < 4; i++) {
    const c = cmpDigits(a.parts[i], b.parts[i]);
    if (c) return c;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  return cmpPreIds(a.pre, b.pre); // labels compared case-insensitively (lowercased above)
}

// ---------------------------------------------------------------- dispatch

const PARSERS = {
  semver: parseSemver,
  go: parseGo,
  pep440: parsePep440,
  rubygems: parseGem,
  nuget: parseNuget,
};
const COMPARERS = { semver: cmpSemver, go: cmpSemver, pep440: cmpPep440, rubygems: cmpGem, nuget: cmpNuget };

function kindOrThrow(ecosystem) {
  const k = kindOf(ecosystem);
  if (k === null) throw new Error(`compareVersions: unknown ecosystem ${JSON.stringify(ecosystem)} (one of ${ECOSYSTEMS.join(", ")})`);
  if (k === "maven") throw new Error("compareVersions: Maven version order is not implemented; check isReliable(ecosystem) first");
  return k;
}

/** isVersion(ecosystem, v) -> boolean: whether compareVersions can place `v` (false for Maven and unknown ecosystems). */
export function isVersion(ecosystem, v) {
  const k = kindOf(ecosystem);
  if (k === null || k === "maven") return false;
  try {
    if (k === "composer") checkComposer(v);
    else PARSERS[k](v, ecosystem);
    return true;
  } catch (err) {
    if (err instanceof VersionError) return false;
    throw err;
  }
}

/**
 * compareVersions(ecosystem, a, b) -> -1 | 0 | 1, in the ecosystem's own order. Throws on an unknown ecosystem,
 * on Maven (not reliable; see isReliable), and on a version the ecosystem's rules can't read.
 */
export function compareVersions(ecosystem, a, b) {
  const k = kindOrThrow(ecosystem);
  if (k === "composer") {
    checkComposer(a);
    checkComposer(b);
    return sign(cmpComposer(a, b));
  }
  const parse = PARSERS[k];
  return sign(COMPARERS[k](parse(a, ecosystem), parse(b, ecosystem)));
}

// ---------------------------------------------------------------- normalised spelling (for exact versions[] matches)

const PRE_CANON = { a: "a", alpha: "a", b: "b", beta: "b", c: "rc", rc: "rc", pre: "rc", preview: "rc" };

/**
 * normaliseVersion(ecosystem, v) -> string: one spelling per version, so an explicit OSV `versions[]` entry and an
 * installed version can be compared as strings. npm, crates.io, Hex, Go: trimmed, leading v dropped (OSV writes
 * Go versions without it). Packagist: semver.mjs `normalise`. PyPI: the PEP 440 normal form ("1.0-post1" ->
 * "1.0.post1", "1.0RC1" -> "1.0rc1"). NuGet: lowercased, build metadata dropped, three parts (a fourth only when
 * not 0). RubyGems, Maven and unknown ecosystems: trimmed. A version the rules can't read is returned trimmed.
 */
export function normaliseVersion(ecosystem, v) {
  const s = String(v ?? "").trim();
  const k = kindOf(ecosystem);
  if (k === "semver" || k === "go") return s.replace(/^[vV](?=\d)/, "");
  if (k === "composer") return composerNormalise(s);
  if (k === "pep440") {
    const m = PEP440.exec(s);
    if (!m) return s.toLowerCase();
    const [, epoch, release, preL, preN, postN1, postL, postN2, devL, devN, local] = m;
    let out = (epoch && Number(epoch) !== 0 ? `${Number(epoch)}!` : "") + release.split(".").map(Number).join(".");
    if (preL !== undefined) out += PRE_CANON[preL.toLowerCase()] + Number(preN ?? 0);
    if (postN1 !== undefined || postL !== undefined) out += `.post${Number(postN1 ?? postN2 ?? 0)}`;
    if (devL !== undefined) out += `.dev${Number(devN ?? 0)}`;
    if (local !== undefined) out += "+" + local.toLowerCase().replace(/[-_]/g, ".");
    return out;
  }
  if (k === "nuget") {
    const m = NUGET.exec(s);
    if (!m) return s.toLowerCase();
    const parts = [m[1], m[2] ?? "0", m[3] ?? "0"].map((p) => String(Number(p)));
    if (m[4] !== undefined && Number(m[4]) !== 0) parts.push(String(Number(m[4])));
    return parts.join(".") + (m[5] ? "-" + m[5].toLowerCase() : "");
  }
  return s;
}
