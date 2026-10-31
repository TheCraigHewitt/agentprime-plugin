// Does a version satisfy a dependency constraint, as Composer or npm reads it? Used by fix_hint to tell
// whether a parent package already allows the fixed version of a transitive dependency. Pure: no network,
// no files. Owner: check.
import { compare, normalise } from "./semver.mjs";

/**
 * A comparator set is a list of { op, version } that must all hold; a constraint is a list of sets, any of
 * which may hold. op is one of ">=", ">", "<=", "<", "=", "!=". An empty set matches every version.
 */

const OPS = /^(>=|<=|==|!=|<>|>|<|=|\^|~)\s*/;

function ecosystemKind(ecosystem) {
  const e = String(ecosystem ?? "").toLowerCase();
  if (e === "packagist" || e === "composer") return "composer";
  if (e === "npm") return "npm";
  throw new Error(`satisfies: unknown ecosystem ${JSON.stringify(ecosystem)} (Packagist or npm)`);
}

const isWild = (p) => p === undefined || p === "*" || p === "x" || p === "X";

/** "1.2.x" -> { parts: [1, 2], pre: "", wild: true } (parts stop at the first wildcard or missing part); null if not a version. */
function parsePartial(text, kind) {
  let s = String(text).trim().replace(/^[vV](?=\d)/, "").replace(/^=+/, "");
  if (kind === "composer") {
    s = s.replace(/#.*$/, ""); // "dev-main#abc123"
    s = s.replace(/\.x-dev$/i, ".x"); // branch alias "2.x-dev" reads as "2.x"
  }
  s = s.replace(/\+.*$/, ""); // build metadata never matters
  const m = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-.]?([0-9A-Za-z.-]+))?$/.exec(s);
  if (!m) return null;
  const raw = [m[1], m[2], m[3], m[4]];
  const parts = [];
  for (const p of raw) {
    if (isWild(p)) break;
    parts.push(Number(p));
  }
  const wild = raw.some((p) => p !== undefined && isWild(p));
  let pre = m[5] ?? "";
  // Composer stability suffixes ("-dev", "-beta2", "-RC1", "-p1") are stripped for comparison.
  if (kind === "composer") pre = "";
  return { parts, pre, wild };
}

const pad = (parts) => [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, ...parts.slice(3)].join(".");
const withPre = (parts, pre) => pad(parts) + (pre ? `-${pre}` : "");
function bump(parts, index) {
  const out = parts.slice(0, index + 1).map((n, i) => (i === index ? n + 1 : n));
  return pad(out);
}

/** The comparators one token stands for ("^1.2", ">=1.0", "1.2.*", "1.2.3"). */
function expandToken(token, kind) {
  const m = OPS.exec(token);
  let op = m ? m[1] : "";
  const rest = m ? token.slice(m[0].length) : token;
  if (op === "==") op = "=";
  if (op === "<>") op = "!=";
  const v = parsePartial(rest, kind);
  if (!v) {
    // A Composer branch ("dev-main") matches only itself.
    if (kind === "composer" && /^dev-/i.test(rest) && (op === "" || op === "=")) return [{ op: "=", version: rest }];
    throw new Error(`satisfies: can't read the constraint ${JSON.stringify(token)}`);
  }
  const { parts, pre, wild: wildcard } = v;
  const n = parts.length;
  const lower = withPre(parts, pre);

  if (op === "^") {
    if (n === 0) return [];
    // The leftmost non-zero given part is fixed: ^1.2.3 <2.0.0, ^0.2.3 <0.3.0, ^0.0.3 <0.0.4, ^0.0 <0.1.0.
    const [M, m2 = 0] = parts;
    const index = M !== 0 || n === 1 ? 0 : m2 !== 0 || n === 2 ? 1 : 2;
    return [{ op: ">=", version: lower }, { op: "<", version: bump(parts, index) }];
  }
  if (op === "~") {
    if (n === 0) return [];
    // Composer: the last given part may move ("~1.2" is >=1.2 <2.0, "~1.2.3" is <1.3). npm: the patch may move
    // when a minor is given, else the minor ("~1.2" and "~1.2.3" are <1.3.0, "~1" is <2.0.0).
    const index = kind === "composer" ? Math.max(0, n - 2) : n === 1 ? 0 : 1;
    return [{ op: ">=", version: lower }, { op: "<", version: bump(parts, index) }];
  }
  if (op === "" || op === "=") {
    if (n === 0) return [];
    // A wildcard is a range in both; a partial npm version is an X-range ("1.2" is 1.2.x); an exact Composer
    // version, partial or not, means that version ("1.2" is 1.2.0).
    if (wildcard || (kind === "npm" && n < 3)) return [{ op: ">=", version: pad(parts) }, { op: "<", version: bump(parts, n - 1) }];
    return [{ op: "=", version: lower }];
  }
  if (op === "!=") return n === 0 ? [{ op: "<", version: "0" }] : [{ op: "!=", version: lower }];
  if (n === 0) return op === ">=" || op === "<=" ? [] : [{ op: "<", version: "0" }];
  if (kind === "npm" && n < 3) {
    // npm fills a partial comparator as an X-range: ">1.2" is ">=1.3.0", "<=1.2" is "<1.3.0".
    if (op === ">") return [{ op: ">=", version: bump(parts, n - 1) }];
    if (op === "<=") return [{ op: "<", version: bump(parts, n - 1) }];
  }
  return [{ op, version: kind === "composer" ? pad(parts) : lower }];
}

/** "1.2 - 1.5": the lower end padded with zeros; a partial upper end covers that whole line (<1.6). */
function hyphen(from, to, kind) {
  const a = parsePartial(from, kind);
  const b = parsePartial(to, kind);
  if (!a || !b) throw new Error(`satisfies: can't read the range ${from} - ${to}`);
  const set = a.parts.length ? [{ op: ">=", version: withPre(a.parts, a.pre) }] : [];
  if (b.parts.length >= 3) set.push({ op: "<=", version: withPre(b.parts, b.pre) });
  else if (b.parts.length) set.push({ op: "<", version: bump(b.parts, b.parts.length - 1) });
  return set;
}

/** parseConstraintSets(constraint, ecosystem) -> comparator sets (exported for tests). */
export function parseConstraintSets(constraint, ecosystem) {
  const kind = ecosystemKind(ecosystem);
  let text = String(constraint ?? "").trim();
  if (kind === "composer") {
    // "dev-main as 2.1.x-dev": the alias is what other packages see.
    text = text.replace(/\S+\s+as\s+(\S+)/gi, "$1");
    text = text.replace(/@(dev|alpha|beta|rc|stable)\b/gi, ""); // stability flags
  }
  const alternatives = text.split(kind === "composer" ? /\s*\|\|?\s*/ : /\s*\|\|\s*/);
  return alternatives.map((alt) => {
    alt = alt.trim();
    if (alt === "" || alt === "*" || alt === "x" || alt === "X") return [];
    const h = /^(\S+)\s+-\s+(\S+)$/.exec(alt);
    if (h) return hyphen(h[1], h[2], kind);
    // Join an operator to its version (">= 1.2" -> ">=1.2"), then split on spaces (and commas for Composer).
    const joined = alt.replace(/(>=|<=|==|!=|<>|>|<|=|\^|~)\s+/g, "$1");
    const tokens = joined.split(kind === "composer" ? /\s*,\s*|\s+/ : /\s+/).filter(Boolean);
    return tokens.flatMap((t) => expandToken(t, kind));
  });
}

function holds({ op, version }, v) {
  const c = compare(v, version);
  switch (op) {
    case ">=": return c >= 0;
    case ">": return c > 0;
    case "<=": return c <= 0;
    case "<": return c < 0;
    case "=": return c === 0;
    case "!=": return c !== 0;
    default: return false;
  }
}

const tuple = (v) => normalise(v).replace(/[-+].*$/, "");
const hasPre = (v) => /-/.test(normalise(v).replace(/\+.*$/, ""));

/**
 * satisfies(version, constraint, ecosystem) -> boolean
 * Composer: ^ ~ * .* x, hyphen ranges, comparators joined by spaces or commas, alternatives by || or |,
 * stability suffixes and @flags ignored for comparison, a leading v. npm: ^ ~ x * X-ranges, hyphen ranges,
 * space-joined comparators, ||, and npm's rule that a pre-release only satisfies a set that names a
 * pre-release of the same major.minor.patch. Throws when the constraint can't be read.
 */
export function satisfies(version, constraint, ecosystem) {
  const kind = ecosystemKind(ecosystem);
  const sets = parseConstraintSets(constraint, ecosystem);
  let v = normalise(version).replace(/\+.*$/, "");
  if (kind === "composer") {
    const p = parsePartial(v, "composer");
    if (p && p.parts.length) v = pad(p.parts); // else a branch ("dev-main"), compared as written
  }
  return sets.some((set) => {
    if (!set.every((c) => holds(c, v))) return false;
    if (kind === "npm" && hasPre(v)) return set.some((c) => hasPre(c.version) && tuple(c.version) === tuple(v));
    return true;
  });
}
