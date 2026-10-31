// Version helpers for fix_hint and upgrade decisions. Not used for Advisory matching (OSV does that).
// See scripts/CONTRACT.md. Owner: core.

/** Strip a leading v/V, collapse Composer's four-part "1.2.3.0" to "1.2.3", keep pre-release and build suffixes. */
export function normalise(v) {
  let s = String(v ?? "").trim();
  s = s.replace(/^[vV](?=\d)/, "");
  s = s.replace(/^(\d+\.\d+\.\d+)\.0(?=$|[-+._a-zA-Z])/, "$1");
  return s;
}

const STABILITY = { dev: 0, alpha: 1, a: 1, beta: 2, b: 2, rc: 3 };

function parse(v) {
  const s = normalise(v);
  const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(s);
  if (!m) return { numeric: false, parts: [], pre: s, raw: s };
  const parts = m[1].split(".").map(Number);
  let rest = m[2].replace(/\+.*$/, ""); // build metadata never affects precedence
  rest = rest.replace(/^[-._]/, "");
  return { numeric: true, parts, pre: rest, raw: s };
}

// "beta10" -> ["beta", 10]; "rc.1" -> ["rc", 1]
function preTokens(pre) {
  return (pre.toLowerCase().match(/[a-z]+|\d+/g) ?? []).map((t) => (/^\d+$/.test(t) ? Number(t) : t));
}

function cmpToken(a, b) {
  const an = typeof a === "number";
  const bn = typeof b === "number";
  if (an && bn) return a === b ? 0 : a < b ? -1 : 1;
  if (an) return -1; // numeric identifiers sort before alphanumeric ones (semver)
  if (bn) return 1;
  const ar = STABILITY[a];
  const br = STABILITY[b];
  if (ar !== undefined && br !== undefined) return ar === br ? 0 : ar < br ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** compare(a, b) -> -1 | 0 | 1. Numeric on dot parts (missing parts are 0); a pre-release sorts before its release. */
export function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa.numeric || !pb.numeric) {
    if (pa.numeric !== pb.numeric) return pa.numeric ? 1 : -1; // e.g. "dev-main" sorts before any numbered version
    return pa.raw === pb.raw ? 0 : pa.raw < pb.raw ? -1 : 1;
  }
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const x = pa.parts[i] ?? 0;
    const y = pb.parts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const ta = preTokens(pa.pre);
  const tb = preTokens(pb.pre);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    if (ta[i] === undefined) return -1;
    if (tb[i] === undefined) return 1;
    const c = cmpToken(ta[i], tb[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/** bumpClass(from, to) -> "patch" | "minor" | "major". 0.x minor changes count as major. */
export function bumpClass(from, to) {
  const a = parse(from).parts;
  const b = parse(to).parts;
  const [a0 = 0, a1 = 0] = a;
  const [b0 = 0, b1 = 0] = b;
  if (a0 !== b0) return "major";
  if (a1 !== b1) return a0 === 0 ? "major" : "minor";
  return "patch";
}
