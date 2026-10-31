// Advisory resolution and version matching through OSV. See scripts/CONTRACT.md. Owner: network.
import { resolvePaths } from "./args.mjs";
import { configureFetch, fetchJson } from "./fetch.mjs";
import { sha256 } from "./hash.mjs";
import { compare, normalise } from "./semver.mjs";
import { contractRanges, ecosystemOf, fixedVersionsFor, formatRanges, nameKey, rangeContainsFor } from "./match.mjs";

const OSV = "https://api.osv.dev/v1";
const GITHUB_ADVISORIES = "https://api.github.com/advisories";
// The ecosystems the skill assesses (inventory, matchInventory, resolveAdvisory, provisional Advisories). Records for
// every other OSV ecosystem ecosystemName knows are kept by normaliseOsv and range-checked through match.mjs.
const ECOSYSTEMS = ["Packagist", "npm"];
const isSkillEcosystem = (e) => ECOSYSTEMS.includes(e);
const BATCH_SIZE = 1000;

const GHSA_RE = /GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/i;
const CVE_RE = /CVE-\d{4}-\d{4,}/i;

const isGhsa = (id) => /^GHSA-/i.test(id);
const canonGhsa = (id) => "GHSA-" + id.slice(5).toLowerCase();
const isZero = (v) => v === undefined || v === null || v === "0" || v === "";

/**
 * ecosystemName(e) -> "Packagist" | "npm" | "PyPI" | "crates.io" | "Go" | "RubyGems" | "Hex" | "NuGet" | "Maven" | null.
 * OSV's names and GitHub's aliases (composer, pip, rust, cargo, go, golang, rubygems, gem, erlang, hex, nuget,
 * maven), in any case; an ecosystem with a suffix ("Packagist:https://…", "Debian:12") is null. match.mjs's ecosystemOf.
 */
export function ecosystemName(e) {
  return ecosystemOf(e);
}

// --- normalising an OSV record ------------------------------------------------------------------------

const eventVersion = (ev) => ev.introduced ?? ev.fixed ?? ev.last_affected ?? ev.limit;

/**
 * OSV range events -> [{ introduced, fixed? | last_affected? }], one interval per introduced event.
 * Events are evaluated in version order, as the OSV schema specifies; a fixed or last_affected event with
 * no open interval closes nothing.
 */
function eventsToRanges(events = []) {
  const sorted = events
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => {
      const va = eventVersion(a.ev);
      const vb = eventVersion(b.ev);
      const c = isZero(va) && isZero(vb) ? 0 : isZero(va) ? -1 : isZero(vb) ? 1 : compare(va, vb);
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
    // "limit" events only bound git walks; ignored here
  }
  if (open) out.push(open);
  return out;
}

function rangeLabel(r) {
  const parts = [];
  if (!isZero(r.introduced)) parts.push(`>=${r.introduced}`);
  if (r.fixed !== undefined) parts.push(`<${r.fixed}`);
  else if (r.last_affected !== undefined) parts.push(`<=${r.last_affected}`);
  return parts.length ? parts.join(", ") : "*";
}

function lowerBound(r) {
  return isZero(r.introduced) ? "0" : r.introduced;
}

/**
 * Human form of the ranges, lowest first, alternatives joined by " || ". Explicit versions as "=v". Entries outside
 * Packagist and npm (OSV-form ranges) are formatted by match.mjs's formatRanges, in compareVersions order.
 */
export function formatAffectedRange(entries) {
  if (entries.length && !entries.some((e) => isSkillEcosystem(e.ecosystem))) return formatRanges(entries[0].ecosystem, entries);
  const ranges = entries.flatMap((e) => e.ranges);
  const seen = new Set();
  const labels = [];
  for (const r of [...ranges].sort((a, b) => compare(lowerBound(a), lowerBound(b)))) {
    const l = rangeLabel(r);
    if (!seen.has(l)) labels.push(l), seen.add(l);
  }
  if (!labels.length) {
    const versions = [...new Set(entries.flatMap((e) => e.versions ?? []))].sort(compare);
    labels.push(...versions.map((v) => `=${v}`));
  }
  return labels.join(" || ");
}

function affectedEntries(record) {
  const out = [];
  for (const a of record.affected ?? []) {
    const ecosystem = ecosystemName(a.package?.ecosystem);
    if (!ecosystem || !a.package?.name) continue;
    if (!isSkillEcosystem(ecosystem)) {
      // CONTRACT intervals that keep each range's type (GIT ranges too, never evaluated), ordered by the
      // ecosystem's own compareVersions (match.mjs), and the explicit versions unchanged.
      const entry = { package: a.package.name, ecosystem, ranges: contractRanges(ecosystem, a.ranges) };
      if (Array.isArray(a.versions)) entry.versions = [...a.versions];
      out.push(entry);
      continue;
    }
    const ranges = (a.ranges ?? [])
      .filter((r) => r.type === "ECOSYSTEM" || r.type === "SEMVER")
      .flatMap((r) => eventsToRanges(r.events));
    const entry = { package: a.package.name, ecosystem, ranges };
    if (Array.isArray(a.versions) && a.versions.length) entry.versions = [...a.versions];
    out.push(entry);
  }
  return out;
}

const samePackage = (a, name, ecosystem) =>
  (isSkillEcosystem(a.ecosystem) ? a.package.toLowerCase() === String(name).toLowerCase() : nameKey(a.ecosystem, a.package) === nameKey(a.ecosystem, name)) &&
  (!ecosystem || a.ecosystem === ecosystemName(ecosystem));

/**
 * normaliseOsv(record, { package?, ecosystem? }) -> Advisory
 * `package` picks which affected entry the Advisory is about; without it, the first Packagist/npm entry, else the
 * first entry of any ecosystem ecosystemName knows. Packagist and npm entries carry intervals
 * ({ introduced, fixed? | last_affected? }, ECOSYSTEM and SEMVER only); every other ecosystem's entries carry
 * intervals that also keep `type` (GIT included, with `repo`), from match.mjs's contractRanges, and `versions` as written.
 */
export function normaliseOsv(record, { package: pkg, ecosystem } = {}) {
  if (!record || typeof record.id !== "string") throw new Error("not an OSV record (no id)");
  const ids = [record.id, ...(record.aliases ?? [])];
  const ghsa = isGhsa(record.id) ? null : (record.aliases ?? []).find(isGhsa);
  const id = ghsa ?? record.id;
  const aliases = [...new Set(ids.filter((x) => x !== id))];

  const affected = affectedEntries(record);
  let primary;
  if (pkg) {
    primary = affected.find((a) => samePackage(a, pkg, ecosystem));
    if (!primary) throw new Error(`${id} has no affected entry for ${pkg}${ecosystem ? ` in ${ecosystem}` : ""} (in any ecosystem agentprime reads)`);
  } else {
    primary = affected.find((a) => isSkillEcosystem(a.ecosystem)) ?? affected[0];
  }
  const forPackage = primary ? affected.filter((a) => samePackage(a, primary.package, primary.ecosystem)) : [];
  const fixedEvents = (record.affected ?? [])
    .filter((a) => primary && ecosystemName(a.package?.ecosystem) && samePackage({ package: a.package.name, ecosystem: ecosystemName(a.package.ecosystem) }, primary.package, primary.ecosystem))
    .flatMap((a) => (a.ranges ?? []).filter((r) => r.type === "ECOSYSTEM" || r.type === "SEMVER"))
    .flatMap((r) => (r.events ?? []).map((e) => e.fixed))
    .filter((v) => typeof v === "string" && v !== "");
  const fixed = !primary || isSkillEcosystem(primary.ecosystem) ? [...new Set(fixedEvents)].sort(compare) : fixedVersionsFor(primary.ecosystem, forPackage);

  const advisory = {
    id,
    aliases,
    package: primary?.package ?? null,
    ecosystem: primary?.ecosystem ?? null,
    affected_range: formatAffectedRange(forPackage),
    fixed_versions: fixed,
    affected,
    modified: record.modified ?? null,
  };
  if (record.published) advisory.published = record.published;
  advisory.withdrawn = record.withdrawn ?? null;
  advisory.summary = record.summary ?? firstLine(record.details);
  if (record.details) advisory.details = record.details;
  advisory.references = (record.references ?? []).map((r) => ({ type: r.type, url: r.url }));
  advisory.provisional = false;
  return advisory;
}

function firstLine(text) {
  const line = String(text ?? "").trim().split(/\r?\n/)[0] ?? "";
  return line.length > 200 ? line.slice(0, 197) + "..." : line;
}

// --- range checks --------------------------------------------------------------------------------------

function inRange(r, version) {
  if (!isZero(r.introduced) && compare(version, r.introduced) < 0) return false;
  if (r.fixed !== undefined && compare(version, r.fixed) >= 0) return false;
  if (r.last_affected !== undefined && compare(version, r.last_affected) > 0) return false;
  return true;
}

/**
 * rangeContains(advisoryOrAffected, version, packageName?, ecosystem?) -> boolean
 * True when `version` is in any affected range (or explicit versions list) of `packageName`'s entries.
 * Takes an Advisory (packageName defaults to advisory.package) or an Advisory's `affected` array.
 */
export function rangeContains(advisoryOrAffected, version, packageName, ecosystem) {
  const isArray = Array.isArray(advisoryOrAffected);
  const affected = isArray ? advisoryOrAffected : advisoryOrAffected?.affected ?? [];
  const name = packageName ?? (isArray ? undefined : advisoryOrAffected?.package);
  const eco = ecosystem ?? (isArray || packageName ? undefined : advisoryOrAffected?.ecosystem);
  const v = normalise(version);
  return affected
    .filter((a) => !name || samePackage(a, name, eco))
    .some((a) =>
      a.ecosystem && !isSkillEcosystem(a.ecosystem)
        ? rangeContainsFor(a.ecosystem, a, version) // other ecosystems: their own version order (match.mjs)
        : (a.versions ?? []).some((x) => normalise(x) === v) || (a.ranges ?? []).some((r) => inRange(r, v)),
    );
}

// --- resolving an id or URL ----------------------------------------------------------------------------

/** parseAdvisoryRef(idOrUrl) -> an OSV-style id (GHSA canonical case, CVE upper case). */
export function parseAdvisoryRef(input) {
  const s = String(input ?? "").trim();
  if (!s) throw new Error("advisory: give a GHSA, CVE or OSV id, or an advisory URL");
  if (/^https?:\/\//i.test(s)) {
    let url;
    try {
      url = new URL(s);
    } catch {
      throw new Error(`advisory: not a valid URL: ${s}`);
    }
    const ghsa = GHSA_RE.exec(s);
    if (ghsa) return canonGhsa(ghsa[0]);
    if (/(^|\.)osv\.dev$/i.test(url.hostname)) {
      const m = /\/(?:vulnerability|v1\/vulns)\/([^/?#]+)/.exec(url.pathname);
      if (m) return decodeURIComponent(m[1]);
    }
    const cve = CVE_RE.exec(s);
    if (cve) return cve[0].toUpperCase();
    throw new Error(`advisory: no GHSA, CVE or OSV id in ${s}; for a page with no id yet, use --provisional`);
  }
  if (GHSA_RE.test(s) && GHSA_RE.exec(s)[0].length === s.length) return canonGhsa(s);
  if (/^CVE-\d{4}-\d{4,}$/i.test(s)) return s.toUpperCase();
  if (/^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9._:-]+$/.test(s)) return s;
  throw new Error(`advisory: not an advisory id or URL: ${s}`);
}

async function fetchOsv(id) {
  return fetchJson(`${OSV}/vulns/${encodeURIComponent(id)}`);
}

async function ghsaForCve(cve) {
  const list = await fetchJson(`${GITHUB_ADVISORIES}?cve_id=${encodeURIComponent(cve)}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  const hit = (Array.isArray(list) ? list : []).find((a) => a?.ghsa_id);
  return hit ? canonGhsa(hit.ghsa_id) : null;
}

const hasSupportedEntry = (record) => (record.affected ?? []).some((a) => isSkillEcosystem(ecosystemName(a.package?.ecosystem)));

/**
 * resolveAdvisory(idOrUrl, { package?, ecosystem? }) -> Advisory
 * OSV by id. For a CVE id that OSV doesn't know, or whose OSV record has no Packagist/npm entry (OSV's own
 * CVE records describe git ranges), the GitHub Advisory Database gives the GHSA id, and OSV is asked again.
 */
export async function resolveAdvisory(idOrUrl, options = {}) {
  const id = parseAdvisoryRef(idOrUrl);
  let record = null;
  try {
    record = await fetchOsv(id);
  } catch (err) {
    if (err.status !== 404) throw err;
    if (!/^CVE-/.test(id)) throw new Error(`OSV has no advisory ${id}`);
  }
  if (/^CVE-/.test(id) && (!record || !hasSupportedEntry(record))) {
    const fromRecord = (record?.aliases ?? []).concat(record?.related ?? []).find(isGhsa);
    let ghsa = fromRecord ? canonGhsa(fromRecord) : null;
    if (!ghsa) {
      try {
        ghsa = await ghsaForCve(id);
      } catch (err) {
        if (!record) throw new Error(`OSV has no advisory ${id}, and the GitHub lookup failed: ${err.message}`);
      }
    }
    if (ghsa) {
      try {
        record = await fetchOsv(ghsa);
      } catch (err) {
        if (err.status !== 404 || !record) throw err.status === 404 ? new Error(`OSV has no advisory ${ghsa} (from ${id})`) : err;
      }
    }
    if (!record) throw new Error(`no advisory found for ${id} in OSV or the GitHub Advisory Database`);
  }
  if (!hasSupportedEntry(record)) {
    // An Advisory with no package is useless downstream; fail here, at the cause.
    const covered = [...new Set((record.affected ?? []).map((a) => a.package?.ecosystem).filter(Boolean))].sort();
    const what = covered.length ? `it covers ${covered.join(", ")} only` : "it names no package ecosystem (git ranges only)";
    const shown = record.id === id ? id : `${record.id} (from ${id})`;
    throw new Error(`${shown} has no Packagist or npm affected entry; ${what}`);
  }
  return normaliseOsv(record, options);
}

// --- provisional advisories ----------------------------------------------------------------------------

/**
 * parseConstraint("<1.2.3" | ">=1.0.0, <1.2.3" | "<=1.2.3" | "=1.2.3" | "a || b", { label? }) -> { ranges, versions }
 * `label` names the input in error messages (default "--affected").
 */
export function parseConstraint(text, { label = "--affected" } = {}) {
  const ranges = [];
  const versions = [];
  for (const alt of String(text ?? "").split("||")) {
    const tokens = alt.split(/[,\s]+/).filter(Boolean);
    if (!tokens.length) continue;
    const r = {};
    for (let i = 0; i < tokens.length; i++) {
      let t = tokens[i];
      if (/^(>=|<=|<|=|==)$/.test(t) && tokens[i + 1]) t += tokens[++i]; // ">= 1.0.0"
      const m = /^(>=|<=|<|==|=)?v?(\d[\w.+-]*)$/.exec(t);
      if (!m) throw new Error(`${label}: can't read "${t}"; use forms like "<1.2.3", ">=1.0.0, <1.2.3", "<=1.2.3"`);
      const [, op = "=", v] = m;
      if (op === ">=") r.introduced = v;
      else if (op === "<") r.fixed = v;
      else if (op === "<=") r.last_affected = v;
      else versions.push(v);
    }
    if (r.introduced !== undefined || r.fixed !== undefined || r.last_affected !== undefined) {
      if (r.fixed !== undefined && r.last_affected !== undefined) throw new Error(`${label}: "${alt.trim()}" has both < and <=`);
      ranges.push({ introduced: r.introduced ?? "0", ...(r.fixed !== undefined ? { fixed: r.fixed } : {}), ...(r.last_affected !== undefined ? { last_affected: r.last_affected } : {}) });
    }
  }
  if (!ranges.length && !versions.length) throw new Error(`${label}: empty constraint`);
  return { ranges, versions };
}

/** buildProvisional({ package, ecosystem, affected, fixed?, summary, url? }) -> Advisory with provisional: true. No network. */
export function buildProvisional({ package: pkg, ecosystem, affected, fixed, summary, url } = {}) {
  const missing = ["package", "ecosystem", "affected", "summary"].filter(
    (k) => typeof { package: pkg, ecosystem, affected, summary }[k] !== "string" || !{ package: pkg, ecosystem, affected, summary }[k].trim(),
  );
  if (missing.length) throw new Error(`advisory --provisional needs ${missing.map((k) => "--" + k).join(", ")}`);
  const eco = ecosystemName(ecosystem);
  if (!isSkillEcosystem(eco)) throw new Error(`--ecosystem must be Packagist or npm, not ${ecosystem}`);
  const { ranges, versions } = parseConstraint(affected);
  const urlText = typeof url === "string" ? url : "";
  const hex = sha256(`${pkg}\n${affected}\n${urlText}`).replace(/^sha256:/, "");
  const fromFlag = typeof fixed === "string" ? fixed.split(/[,\s]+/).filter(Boolean) : [];
  const fixedVersions = [...new Set(fromFlag.length ? fromFlag : ranges.map((r) => r.fixed).filter(Boolean))].sort(compare);
  const entry = { package: pkg, ecosystem: eco, ranges };
  if (versions.length) entry.versions = versions;
  return {
    id: `PROV-${hex.slice(0, 12)}`,
    aliases: [],
    package: pkg,
    ecosystem: eco,
    affected_range: affected.trim(),
    fixed_versions: fixedVersions,
    affected: [entry],
    modified: new Date().toISOString(),
    withdrawn: null,
    summary: summary.trim(),
    references: urlText ? [{ type: "WEB", url: urlText }] : [],
    provisional: true,
  };
}

// --- matching an inventory -----------------------------------------------------------------------------

async function queryBatch(queries) {
  const results = [];
  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const chunk = queries.slice(i, i + BATCH_SIZE);
    const res = await fetchJson(`${OSV}/querybatch`, { method: "POST", body: { queries: chunk } });
    const got = res?.results ?? [];
    if (got.length !== chunk.length) throw new Error(`OSV querybatch returned ${got.length} results for ${chunk.length} queries`);
    for (let j = 0; j < chunk.length; j++) {
      const vulns = [...(got[j]?.vulns ?? [])];
      let token = got[j]?.next_page_token;
      while (token) {
        const more = await fetchJson(`${OSV}/querybatch`, { method: "POST", body: { queries: [{ ...chunk[j], page_token: token }] } });
        vulns.push(...(more?.results?.[0]?.vulns ?? []));
        token = more?.results?.[0]?.next_page_token;
      }
      results.push(vulns);
    }
  }
  return results;
}

/**
 * matchInventory(inventory, { package? }) -> Match[]
 * One OSV query per distinct (ecosystem, name, version); each matched record fetched once; withdrawn ones
 * dropped. One Match per (Advisory, package), with `installed` the inventory entries OSV matched.
 */
export async function matchInventory(inventory, { package: only } = {}) {
  const pkgs = (inventory?.packages ?? []).filter(
    (p) => ECOSYSTEMS.includes(p.ecosystem) && (!only || p.name.toLowerCase() === String(only).toLowerCase()),
  );
  const groups = new Map();
  for (const p of pkgs) {
    const key = `${p.ecosystem}\0${p.name}\0${p.version}`;
    if (!groups.has(key)) groups.set(key, { query: { package: { name: p.name, ecosystem: p.ecosystem }, version: p.version }, entries: [] });
    groups.get(key).entries.push(p);
  }
  const list = [...groups.values()];
  if (!list.length) return [];
  const results = await queryBatch(list.map((g) => g.query));

  const records = new Map();
  const byAdvisory = new Map(); // `${vulnId}\0${ecosystem}\0${name}` -> { id, name, ecosystem, installed }
  list.forEach((g, i) => {
    for (const v of results[i]) {
      const key = `${v.id}\0${g.query.package.ecosystem}\0${g.query.package.name}`;
      if (!byAdvisory.has(key)) byAdvisory.set(key, { id: v.id, name: g.query.package.name, ecosystem: g.query.package.ecosystem, installed: [] });
      byAdvisory.get(key).installed.push(...g.entries);
      records.set(v.id, null);
    }
  });
  // Each distinct record once, all at the same time; ids sorted so the requests and the output are deterministic.
  const ids = [...records.keys()].sort();
  const fetched = await Promise.all(ids.map((id) => fetchOsv(id)));
  ids.forEach((id, i) => records.set(id, fetched[i]));

  const matches = [];
  for (const m of byAdvisory.values()) {
    const record = records.get(m.id);
    if (record.withdrawn) continue;
    let advisory;
    try {
      advisory = normaliseOsv(record, { package: m.name, ecosystem: m.ecosystem });
    } catch {
      advisory = normaliseOsv(record); // OSV matched it under an alias of the name; keep the record's own entry
    }
    matches.push({ advisory, installed: m.installed });
  }
  return matches.sort(
    (a, b) => (a.advisory.package ?? "").localeCompare(b.advisory.package ?? "") || a.advisory.id.localeCompare(b.advisory.id),
  );
}

// --- CLI -----------------------------------------------------------------------------------------------

/** agentprime advisory <id|url> [--package name] | advisory --provisional --package --ecosystem --affected --fixed --summary [--url] */
export async function runAdvisory(args) {
  const { flags = {}, positional = [] } = args;
  const { cwd } = resolvePaths(flags);
  configureFetch({ cwd });
  const str = (k) => (typeof flags[k] === "string" ? flags[k] : undefined);
  if (flags.provisional) {
    return buildProvisional({
      package: str("package"),
      ecosystem: str("ecosystem"),
      affected: str("affected"),
      fixed: str("fixed"),
      summary: str("summary"),
      url: str("url") ?? positional[0],
    });
  }
  if (!positional[0]) throw new Error("usage: agentprime advisory <id|url> [--package name]");
  return resolveAdvisory(positional[0], { package: str("package"), ecosystem: str("ecosystem") });
}

/** agentprime match [--app p] [--package name] -> { app, matches: Match[] } */
export async function runMatch(args) {
  const { flags = {} } = args;
  const { cwd, appDir } = resolvePaths(flags);
  configureFetch({ cwd });
  const { readInventory } = await import("./inventory.mjs");
  const inventory = readInventory(appDir, { cwd });
  const matches = await matchInventory(inventory, { package: typeof flags.package === "string" ? flags.package : undefined });
  return { app: inventory.app, matches };
}
