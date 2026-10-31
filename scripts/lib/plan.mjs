// A deterministic upgrade plan from a list of Matches: per package, the lowest version that clears its matched
// Advisories, and how many Matches the top packages clear. Reads matchPackages' output (the POST /v1/match shape)
// directly. Browser-safe: pure ESM, no `node:` imports, no fs, no network. See scripts/CONTRACT.md "Lockfiles,
// versions and upgrade plans (browser-safe)". Owner: core.
import { compareVersions, isReliable, isVersion } from "./versions.mjs";
import { affects, ecosystemOf, entriesFor, fixedVersionsFor, isMalicious, isWithdrawn, nameKey, rangeContainsFor, sortVersions } from "./match.mjs";

export { rangeContainsFor };

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const TOP = [1, 3, 5, 10];

/**
 * upgradePlan(matches) -> { packages, malicious, summary, warnings }
 * `matches`: [{ advisory: { id, affected, fixed_versions?, malicious?, state?, ... }, installed: [{ ecosystem, name, version }] }],
 * as matchPackages returns them (other fields are ignored). See CONTRACT.md for the output.
 */
export function upgradePlan(matches) {
  const warnings = [];
  const groups = new Map(); // ecosystem\0nameKey -> { ecosystem, name, versions: Set, advisories: Map<id, { entries, fixed }> }
  const malicious = new Map();
  const records = []; // one per counted Match: { id, keys }
  for (const m of Array.isArray(matches) ? matches : []) {
    const a = m?.advisory;
    if (!a || typeof a.id !== "string") {
      warnings.push("a match without an advisory id was skipped");
      continue;
    }
    if (isWithdrawn(a)) {
      warnings.push(`${a.id} is withdrawn or retracted; its match was skipped`);
      continue;
    }
    const installed = (Array.isArray(m.installed) ? m.installed : []).filter((p) => p && typeof p.name === "string" && typeof p.version === "string");
    if (!installed.length) {
      warnings.push(`${a.id}: a match with no installed package was skipped`);
      continue;
    }
    const byPkg = new Map();
    for (const p of installed) {
      const eco = ecosystemOf(p.ecosystem) ?? String(p.ecosystem ?? "");
      const key = `${eco}\u0000${nameKey(eco, p.name)}`;
      if (!byPkg.has(key)) byPkg.set(key, { ecosystem: eco, name: p.name, versions: [] });
      byPkg.get(key).versions.push(p.version);
    }
    if (isMalicious(a)) {
      // The remedy is removing the package, not upgrading it: never part of the plan or its counts.
      for (const [key, p] of byPkg) {
        if (!malicious.has(key)) malicious.set(key, { ecosystem: p.ecosystem, name: p.name, versions: new Set(), advisories: new Set() });
        const g = malicious.get(key);
        p.versions.forEach((v) => g.versions.add(v));
        g.advisories.add(a.id);
      }
      continue;
    }
    const keys = [];
    for (const [key, p] of byPkg) {
      if (!groups.has(key)) groups.set(key, { ecosystem: p.ecosystem, name: p.name, versions: new Set(), advisories: new Map() });
      const g = groups.get(key);
      p.versions.forEach((v) => g.versions.add(v));
      let entries = entriesFor(a, p.ecosystem, p.name);
      if (!entries.length) {
        // /v1/match limits `affected` to the package's own entries; an entry that names no package still counts.
        entries = (Array.isArray(a.affected) ? a.affected : []).filter((e) => {
          const eco = ecosystemOf(e?.ecosystem ?? e?.package?.ecosystem);
          return eco === null || eco === p.ecosystem;
        });
      }
      const prev = g.advisories.get(a.id);
      const fixed = (Array.isArray(a.fixed_versions) ? a.fixed_versions : []).filter((v) => typeof v === "string" && v !== "");
      if (prev) {
        prev.entries.push(...entries);
        prev.fixed.push(...fixed);
      } else g.advisories.set(a.id, { entries: [...entries], fixed });
      keys.push(key);
    }
    records.push({ id: a.id, keys });
  }

  const cleared = new Map(); // key -> Set of cleared advisory ids
  const packages = [];
  for (const [key, g] of groups) {
    const plan = planPackage(g);
    cleared.set(key, new Set(plan.advisories.filter((id) => plan.fixed_by !== null && !plan.unfixed.includes(id))));
    packages.push({ key, plan });
  }
  packages.sort(
    (x, y) =>
      cleared.get(y.key).size - cleared.get(x.key).size ||
      cmpStr(x.plan.name, y.plan.name) ||
      cmpStr(x.plan.ecosystem, y.plan.ecosystem),
  );

  const ranked = packages.filter((p) => cleared.get(p.key).size > 0);
  const ns = TOP.filter((n) => n <= ranked.length);
  if (ranked.length && ranked.length < 10 && !ns.includes(ranked.length)) ns.push(ranked.length);
  const cleared_by_top = ns.map((n) => {
    const top = ranked.slice(0, n);
    const inTop = new Set(top.map((p) => p.key));
    const advisories = records.filter((r) => r.keys.every((k) => inTop.has(k) && cleared.get(k).has(r.id))).length;
    return { n, packages: top.map((p) => p.plan.name), advisories };
  });

  const maliciousList = [...malicious.values()]
    .map((g) => ({ ecosystem: g.ecosystem, name: g.name, installed: sortVersions(g.ecosystem, [...g.versions]), advisories: [...g.advisories].sort() }))
    .sort((x, y) => cmpStr(x.ecosystem, y.ecosystem) || cmpStr(x.name, y.name));

  return {
    packages: packages.map((p) => p.plan),
    malicious: maliciousList,
    summary: {
      matches: records.length,
      packages: packages.length,
      malicious: maliciousList.reduce((n, g) => n + g.advisories.length, 0),
      cleared_by_top,
    },
    warnings: [...new Set(warnings)],
  };
}

function planPackage(g) {
  const eco = g.ecosystem;
  const installed = sortVersions(eco, [...g.versions]);
  const ids = [...g.advisories.keys()].sort();
  const fixesOf = (adv) => sortVersions(eco, [...fixedVersionsFor(eco, adv.entries), ...adv.fixed]);
  const exact = isReliable(eco) && installed.every((v) => isVersion(eco, v));
  if (!exact) {
    const fixed_versions = {};
    for (const id of ids) fixed_versions[id] = fixesOf(g.advisories.get(id));
    return {
      ecosystem: eco,
      name: g.name,
      installed,
      advisories: ids,
      fixed_by: null,
      unfixed: ids.filter((id) => !fixed_versions[id].length),
      comparison: "unavailable",
      fixed_versions,
    };
  }

  const max = installed[installed.length - 1];
  const contains = (adv, v) => adv.entries.some((e) => affects(e, eco, v));
  // A candidate is never below an installed version: a fix on an older branch is no upgrade for the newer copy.
  // The highest installed version is a candidate too when there are several (the others can move up to it).
  const candidatesFor = (adv) => {
    const list = fixesOf(adv).filter((v) => isVersion(eco, v) && compareVersions(eco, v, max) >= 0);
    if (installed.length > 1) list.push(max);
    return sortVersions(eco, list).filter((v) => !contains(adv, v));
  };
  const fixable = [];
  const candidates = [];
  for (const id of ids) {
    const own = candidatesFor(g.advisories.get(id));
    if (own.length) fixable.push(id), candidates.push(...own);
  }
  // The lowest candidate that clears the most fixable Advisories (all of them when one does).
  let best = null;
  let bestCount = 0;
  for (const c of sortVersions(eco, candidates)) {
    const n = fixable.filter((id) => !contains(g.advisories.get(id), c)).length;
    if (n > bestCount) (best = c), (bestCount = n);
  }
  const clearedIds = new Set(best === null ? [] : fixable.filter((id) => !contains(g.advisories.get(id), best)));
  return {
    ecosystem: eco,
    name: g.name,
    installed,
    advisories: ids,
    fixed_by: best,
    unfixed: ids.filter((id) => !clearedIds.has(id)),
    comparison: "exact",
  };
}
