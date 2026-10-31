// Matching installed package versions against Advisories, for every OSV ecosystem agentprime knows. The one
// implementation shared by the service's POST /v1/match, the accounts app, osv.mjs's range checks outside
// Packagist and npm, and plan.mjs. Browser-safe: pure ESM, no `node:` imports, no fs, no network.
// See scripts/CONTRACT.md "Lockfiles, versions and upgrade plans (browser-safe)". Owner: core.
import { ECOSYSTEMS, compareVersions, isReliable, isVersion, normaliseVersion } from "./versions.mjs";

// ---------------------------------------------------------------- ecosystems and names

// OSV's names, and the aliases GitHub and package managers use, case-insensitively.
const ALIASES = {
  packagist: "Packagist",
  composer: "Packagist",
  npm: "npm",
  pypi: "PyPI",
  pip: "PyPI",
  "crates.io": "crates.io",
  rust: "crates.io",
  cargo: "crates.io",
  go: "Go",
  golang: "Go",
  rubygems: "RubyGems",
  gem: "RubyGems",
  hex: "Hex",
  erlang: "Hex",
  nuget: "NuGet",
  maven: "Maven",
};

/**
 * ecosystemOf(s) -> the OSV ecosystem name ("Packagist", "npm", "PyPI", "crates.io", "Go", "RubyGems", "Hex",
 * "NuGet", "Maven") or null. Takes OSV's names and GitHub's aliases in any case. An ecosystem with a suffix or
 * qualifier ("Packagist:https://packages.drupal.org/8", "Debian:12") is null: it is a different package namespace.
 */
export function ecosystemOf(s) {
  if (typeof s !== "string") return null;
  return Object.prototype.hasOwnProperty.call(ALIASES, s.trim().toLowerCase()) ? ALIASES[s.trim().toLowerCase()] : null;
}

/**
 * nameKey(ecosystem, name) -> the form two names of one package share: PyPI by PEP 503 (lowercase, runs of
 * - _ . as one -); Packagist and NuGet lowercased (case-insensitive registries); npm, crates.io, Go, RubyGems, Hex
 * and Maven as written.
 */
export function nameKey(ecosystem, name) {
  const s = String(name ?? "");
  const e = ecosystemOf(ecosystem);
  if (e === "PyPI") return s.toLowerCase().replace(/[-_.]+/g, "-");
  if (e === "Packagist" || e === "NuGet") return s.toLowerCase();
  return s;
}

// ---------------------------------------------------------------- ranges

const isZero = (v) => v === undefined || v === null || v === "0" || v === "";
const evaluable = (r) => r && (r.type === undefined || r.type === "ECOSYSTEM" || r.type === "SEMVER");
const eventVersion = (ev) => ev.introduced ?? ev.fixed ?? ev.last_affected ?? ev.limit;

/**
 * eventsToIntervals(ecosystem, events) -> [{ introduced, fixed? | last_affected? }] or null when an event's
 * version can't be read (the range is then not evaluated). Events in `compareVersions` order, as the OSV schema
 * specifies; a fixed or last_affected event with no open interval closes nothing; limit events are ignored.
 */
export function eventsToIntervals(ecosystem, events = []) {
  const list = (Array.isArray(events) ? events : []).filter((ev) => ev && eventVersion(ev) !== undefined && ev.limit === undefined);
  for (const ev of list) if (!isZero(eventVersion(ev)) && !isVersion(ecosystem, eventVersion(ev))) return null;
  const sorted = list
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => {
      const va = eventVersion(a.ev);
      const vb = eventVersion(b.ev);
      const c = isZero(va) && isZero(vb) ? 0 : isZero(va) ? -1 : isZero(vb) ? 1 : compareVersions(ecosystem, va, vb);
      return c || a.i - b.i;
    })
    .map((x) => x.ev);
  const out = [];
  let open = null;
  for (const ev of sorted) {
    if (ev.introduced !== undefined) {
      if (!open) open = { introduced: ev.introduced };
    } else if (open && (ev.fixed !== undefined || ev.last_affected !== undefined)) {
      if (ev.fixed !== undefined) open.fixed = ev.fixed;
      else open.last_affected = ev.last_affected;
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

// Pairs events as written: for GIT ranges (commits have no order here) and versions the rules can't order.
function pairInRecordOrder(events) {
  const out = [];
  let open = null;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.limit !== undefined) continue;
    if (ev.introduced !== undefined) {
      if (!open) open = { introduced: ev.introduced };
    } else if (open && (ev.fixed !== undefined || ev.last_affected !== undefined)) {
      out.push(ev.fixed !== undefined ? { ...open, fixed: ev.fixed } : { ...open, last_affected: ev.last_affected });
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

/**
 * contractRanges(ecosystem, osvRanges) -> the CONTRACT form of an OSV entry's ranges: one
 * { type, introduced, fixed? | last_affected?, repo? } per interval. ECOSYSTEM and SEMVER events are put in
 * compareVersions order first (record order where the ecosystem has none, Maven, or a version can't be read);
 * GIT ranges are kept, paired in record order with their `repo`, and are never evaluated. `limit` events, which
 * only bound git walks, are dropped.
 */
export function contractRanges(ecosystem, osvRanges) {
  const out = [];
  for (const r of Array.isArray(osvRanges) ? osvRanges : []) {
    if (!r || !Array.isArray(r.events)) continue;
    const type = typeof r.type === "string" ? r.type : "ECOSYSTEM";
    const ivs = type !== "GIT" && isReliable(ecosystem) ? (eventsToIntervals(ecosystem, r.events) ?? pairInRecordOrder(r.events)) : pairInRecordOrder(r.events);
    for (const iv of ivs) out.push({ type, ...iv, ...(type === "GIT" && typeof r.repo === "string" ? { repo: r.repo } : {}) });
  }
  return out;
}

/** The intervals of an affected entry's evaluable ranges: OSV form ({ type, events }) or the CONTRACT form ({ introduced, fixed }). */
function intervals(ecosystem, entry) {
  const out = [];
  for (const r of Array.isArray(entry?.ranges) ? entry.ranges : []) {
    if (!evaluable(r)) continue;
    if (Array.isArray(r.events)) {
      const iv = eventsToIntervals(ecosystem, r.events);
      if (iv) out.push(...iv);
    } else if ("introduced" in r || "fixed" in r || "last_affected" in r) {
      const bounds = [r.introduced, r.fixed, r.last_affected].filter((v) => !isZero(v));
      if (bounds.every((v) => isVersion(ecosystem, v))) out.push({ introduced: r.introduced ?? "0", ...("fixed" in r ? { fixed: r.fixed } : {}), ...("last_affected" in r ? { last_affected: r.last_affected } : {}) });
    }
  }
  return out;
}

function inInterval(ecosystem, r, v) {
  if (!isZero(r.introduced) && compareVersions(ecosystem, v, r.introduced) < 0) return false;
  if (r.fixed !== undefined && compareVersions(ecosystem, v, r.fixed) >= 0) return false;
  if (r.last_affected !== undefined && compareVersions(ecosystem, v, r.last_affected) > 0) return false;
  return true;
}

/**
 * affects(affectedEntry, ecosystem, version) -> boolean. True when `version` is in the entry's explicit
 * `versions[]` (exact match after normaliseVersion), otherwise when it falls in any ECOSYSTEM or SEMVER range
 * (OSV events, or CONTRACT intervals) under compareVersions. GIT ranges are never evaluated. Where isReliable is
 * false (Maven) only `versions[]` counts. A version, or a range bound, the ecosystem's rules can't read is never
 * placed in a range (only `versions[]` can match it).
 */
export function affects(affectedEntry, ecosystem, version) {
  const eco = ecosystemOf(ecosystem) ?? ecosystem;
  const v = String(version ?? "");
  const want = normaliseVersion(eco, v);
  if ((Array.isArray(affectedEntry?.versions) ? affectedEntry.versions : []).some((x) => normaliseVersion(eco, x) === want)) return true;
  if (!isReliable(eco) || !isVersion(eco, v)) return false;
  return intervals(eco, affectedEntry).some((r) => inInterval(eco, r, v));
}

/** rangeContainsFor(ecosystem, affectedEntry, version) -> boolean: `affects` with the ecosystem first (osv.mjs delegates here). */
export const rangeContainsFor = (ecosystem, affectedEntry, version) => affects(affectedEntry, ecosystem, version);

/** sortVersions(ecosystem, versions) -> distinct versions in compareVersions order (as given where it can't order them). */
export function sortVersions(ecosystem, versions) {
  const list = [...new Set(versions)];
  if (!isReliable(ecosystem) || !list.every((v) => isVersion(ecosystem, v))) return list;
  return list.sort((a, b) => compareVersions(ecosystem, a, b));
}

/** fixedVersionsFor(ecosystem, entries) -> the distinct `fixed` versions of the entries' ECOSYSTEM and SEMVER ranges, sorted. */
export function fixedVersionsFor(ecosystem, entries) {
  const out = [];
  for (const e of entries ?? []) {
    for (const r of Array.isArray(e?.ranges) ? e.ranges : []) {
      if (!evaluable(r)) continue;
      if (Array.isArray(r.events)) for (const ev of r.events) if (typeof ev?.fixed === "string" && ev.fixed !== "") out.push(ev.fixed);
      if (typeof r.fixed === "string" && r.fixed !== "") out.push(r.fixed);
    }
  }
  return sortVersions(ecosystem, out);
}

/**
 * formatRanges(ecosystem, entries) -> human form, lowest first, alternatives joined by " || " (">=1.0, <1.2 ||
 * >=2.0, <2.0.3"); with no evaluable range, the explicit versions as "=v". Where versions can't be ordered
 * (Maven), the ranges are listed in record order.
 */
export function formatRanges(ecosystem, entries) {
  const labels = [];
  const seen = new Set();
  const add = (l) => {
    if (!seen.has(l)) seen.add(l), labels.push(l);
  };
  const ivs = [];
  for (const e of entries ?? []) {
    if (isReliable(ecosystem)) ivs.push(...intervals(ecosystem, e));
    else {
      for (const r of Array.isArray(e?.ranges) ? e.ranges : []) {
        if (!evaluable(r)) continue;
        // Record order: without a version order, events are paired as written.
        if (Array.isArray(r.events)) ivs.push(...pairInRecordOrder(r.events));
        else ivs.push(r);
      }
    }
  }
  if (isReliable(ecosystem)) {
    ivs.sort((a, b) => (isZero(a.introduced) ? (isZero(b.introduced) ? 0 : -1) : isZero(b.introduced) ? 1 : compareVersions(ecosystem, a.introduced, b.introduced)));
  }
  for (const r of ivs) {
    const parts = [];
    if (!isZero(r.introduced)) parts.push(`>=${r.introduced}`);
    if (r.fixed !== undefined) parts.push(`<${r.fixed}`);
    else if (r.last_affected !== undefined) parts.push(`<=${r.last_affected}`);
    add(parts.length ? parts.join(", ") : "*");
  }
  if (!labels.length) for (const v of sortVersions(ecosystem, (entries ?? []).flatMap((e) => e?.versions ?? []))) add(`=${v}`);
  return labels.join(" || ");
}

// ---------------------------------------------------------------- matching packages

const isMaliciousId = (a) => [a?.id, ...(Array.isArray(a?.aliases) ? a.aliases : [])].some((x) => /^MAL-/i.test(String(x ?? "")));
/** isMalicious(advisory) -> its `malicious` flag when given, else whether its id or an alias is an OSV MAL- id. */
export const isMalicious = (a) => (typeof a?.malicious === "boolean" ? a.malicious : isMaliciousId(a));
/** isWithdrawn(advisory) -> true for a `withdrawn` timestamp or a state of "withdrawn" or "retracted". */
export const isWithdrawn = (a) => Boolean(a?.withdrawn) || /^(withdrawn|retracted)$/i.test(String(a?.state ?? ""));

/** The entries of an Advisory's `affected` that describe this package. */
export function entriesFor(advisory, ecosystem, name) {
  const eco = ecosystemOf(ecosystem);
  const key = nameKey(eco, name);
  return (Array.isArray(advisory?.affected) ? advisory.affected : []).filter((e) => {
    const entryEco = ecosystemOf(e?.ecosystem ?? e?.package?.ecosystem);
    const entryName = typeof e?.package === "string" ? e.package : e?.package?.name;
    return entryEco === eco && nameKey(eco, entryName) === key;
  });
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * matchPackages(advisories, packages) -> { matches, unsupported }
 * `advisories`: CONTRACT Advisories (with `affected[]`, in either range form). `packages`: [{ ecosystem, name,
 * version }]. One match per Advisory and package (ecosystem and name) with at least one affected version, in the
 * POST /v1/match shape: { advisory: { id, aliases, summary, state, url, affected, fixed_versions, malicious, signals },
 * installed: [{ ecosystem, name, version }] }, `affected` limited to that package's entries and `fixed_versions` to
 * their fixed versions. Withdrawn and retracted Advisories never match. `unsupported` lists the packages whose
 * ecosystem is not one of versions.mjs's ECOSYSTEMS, or whose version that ecosystem's rules can't read (those are
 * still matched by explicit `versions[]`), each with a `reason`. Maven packages are supported but, as isReliable
 * says, matched by explicit `versions[]` only; they are not listed in `unsupported`.
 */
export function matchPackages(advisories, packages) {
  const unsupported = [];
  const seen = new Set();
  const groups = new Map(); // ecosystem\0nameKey -> { ecosystem, name, versions: [{ ecosystem, name, version }] }
  for (const p of Array.isArray(packages) ? packages : []) {
    const eco = ecosystemOf(p?.ecosystem);
    const name = typeof p?.name === "string" ? p.name : "";
    const version = typeof p?.version === "string" ? p.version.trim() : "";
    if (!eco || !ECOSYSTEMS.includes(eco)) {
      unsupported.push({ ecosystem: p?.ecosystem ?? null, name, version, reason: `ecosystem ${JSON.stringify(p?.ecosystem ?? null)} is not supported (${ECOSYSTEMS.join(", ")})` });
      continue;
    }
    if (!name || !version) {
      unsupported.push({ ecosystem: eco, name, version, reason: "a package needs a name and a version" });
      continue;
    }
    const dedupe = `${eco}\u0000${nameKey(eco, name)}\u0000${version}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (isReliable(eco) && !isVersion(eco, version)) {
      unsupported.push({ ecosystem: eco, name, version, reason: `${version} is not a ${eco} version agentprime can order; matched by explicit versions only` });
    }
    const key = `${eco}\u0000${nameKey(eco, name)}`;
    if (!groups.has(key)) groups.set(key, { ecosystem: eco, name, versions: [] });
    groups.get(key).versions.push({ ecosystem: eco, name, version });
  }

  const matches = [];
  for (const a of Array.isArray(advisories) ? advisories : []) {
    if (!a || typeof a.id !== "string" || isWithdrawn(a)) continue;
    for (const g of groups.values()) {
      const entries = entriesFor(a, g.ecosystem, g.name);
      if (!entries.length) continue;
      const hit = g.versions.filter((p) => entries.some((e) => affects(e, g.ecosystem, p.version)));
      if (!hit.length) continue;
      const ordered = sortVersions(g.ecosystem, hit.map((p) => p.version)).map((v) => hit.find((p) => p.version === v));
      const advisory = {
        id: a.id,
        aliases: Array.isArray(a.aliases) ? [...a.aliases] : [],
        summary: typeof a.summary === "string" ? a.summary : "",
        state: a.state ?? null,
        url: a.url ?? null,
        affected: entries,
        fixed_versions: fixedVersionsFor(g.ecosystem, entries),
        malicious: isMalicious(a),
        signals: a.signals ?? null,
      };
      matches.push({ advisory, installed: ordered });
    }
  }
  matches.sort(
    (x, y) =>
      cmpStr(x.installed[0].ecosystem, y.installed[0].ecosystem) ||
      cmpStr(nameKey(x.installed[0].ecosystem, x.installed[0].name), nameKey(y.installed[0].ecosystem, y.installed[0].name)) ||
      cmpStr(x.advisory.id, y.advisory.id),
  );
  return { matches, unsupported };
}
