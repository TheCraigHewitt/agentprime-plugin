// Package metadata from the Packagist and npm registries (never from vendor/ or node_modules/).
// See scripts/CONTRACT.md. Owner: network.
import { fetchJson } from "./fetch.mjs";
import { compare, normalise } from "./semver.mjs";

const PACKAGIST = "https://repo.packagist.org/p2";
const NPM = "https://registry.npmjs.org";

/**
 * expandMinified(versions) -> versions
 * Packagist p2 "composer/2.0" minified lists: each entry holds only the keys that changed from the previous
 * (expanded) entry, and "__unset" removes a key. Same algorithm as Composer's MetadataMinifier::expand.
 */
export function expandMinified(versions) {
  const out = [];
  let current = null;
  for (const v of versions ?? []) {
    if (current === null) {
      current = { ...v };
    } else {
      current = { ...current };
      for (const [k, val] of Object.entries(v)) {
        if (val === "__unset") delete current[k];
        else current[k] = val;
      }
    }
    out.push(current);
  }
  return out;
}

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** pickVersion(entries, version) -> the entry for `version`, else the nearest lower one, else the first. */
export function pickVersion(entries, version) {
  if (!entries.length) return null;
  if (version === undefined || version === null || version === "") return entries[0];
  const want = normalise(version);
  const exact = entries.find((e) => normalise(e.version_normalized ?? "") === want || normalise(e.version ?? "") === want);
  if (exact) return exact;
  let best = null;
  for (const e of entries) {
    if (compare(e.version, want) < 0 && (!best || compare(e.version, best.version) > 0)) best = e;
  }
  return best ?? entries[0];
}

const stringMap = (v) => Object.fromEntries(Object.entries(obj(v)).filter(([, c]) => typeof c === "string"));

/**
 * Adds `key` without making it enumerable, so the object keeps the contract's Usages `metadata` shape
 * (and its JSON) while callers that ask for the field can still read it.
 */
const withHidden = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: true });

/**
 * packagistMetadata(name, version) -> { namespaces, providers, aliases, bin, require }
 * `require` is the chosen version's runtime requirements ({ "league/commonmark": "^2.2.1", "php": "^8.2" }), and
 * `version` the version chosen (the nearest lower one when `version` isn't listed). Both are non-enumerable:
 * `usages` embeds this object as its `metadata`, whose shape the contract fixes.
 */
export async function packagistMetadata(name, version) {
  const lower = String(name).toLowerCase();
  if (!/^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/.test(lower)) {
    throw new Error(`"${name}" is not a Packagist package name (vendor/package)`);
  }
  let doc;
  try {
    doc = await fetchJson(`${PACKAGIST}/${lower}.json`);
  } catch (err) {
    if (err.status === 404) throw new Error(`Packagist doesn't know the package ${name}`);
    throw err;
  }
  const raw = doc?.packages?.[lower] ?? [];
  const entries = doc?.minified ? expandMinified(raw) : raw;
  if (!entries.length) throw new Error(`Packagist lists no versions for ${name}`);
  const picked = pickVersion(entries, version);
  const autoload = obj(picked.autoload);
  const namespaces = [...new Set([...Object.keys(obj(autoload["psr-4"])), ...Object.keys(obj(autoload["psr-0"]))])].filter(Boolean);
  const laravel = obj(obj(picked.extra).laravel);
  const out = {
    namespaces,
    providers: Array.isArray(laravel.providers) ? laravel.providers.filter((p) => typeof p === "string") : [],
    aliases: stringMap(laravel.aliases),
    bin: Array.isArray(picked.bin) ? picked.bin.filter((b) => typeof b === "string") : [],
  };
  withHidden(out, "version", String(picked.version ?? ""));
  return withHidden(out, "require", stringMap(picked.require));
}

/**
 * npmMetadata(name, version) -> { bin, exports, dependencies } (version defaults to the "latest" dist-tag)
 * `dependencies` merges the version's `dependencies` and `optionalDependencies` (an optional entry wins, as
 * npm installs it under that constraint), and `version` the version the registry returned. Both are
 * non-enumerable, like packagistMetadata's `require`.
 */
export async function npmMetadata(name, version) {
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(String(name))) {
    throw new Error(`"${name}" is not an npm package name`);
  }
  const v = version ? normalise(version) : "latest";
  const path = String(name).startsWith("@") ? String(name).replace("/", "%2F") : String(name);
  let doc;
  try {
    doc = await fetchJson(`${NPM}/${path}/${encodeURIComponent(v)}`);
  } catch (err) {
    if (err.status === 404) throw new Error(`the npm registry doesn't know ${name}@${v}`);
    throw err;
  }
  let bin = [];
  if (typeof doc?.bin === "string") bin = [String(name).replace(/^@[^/]+\//, "")];
  else bin = Object.keys(obj(doc?.bin));
  const exp = doc?.exports;
  const exportsList = exp && typeof exp === "object" && !Array.isArray(exp) ? Object.keys(exp).filter((k) => k.startsWith("./")) : [];
  const out = withHidden({ bin, exports: exportsList }, "version", String(doc?.version ?? v));
  return withHidden(out, "dependencies", { ...stringMap(doc?.dependencies), ...stringMap(doc?.optionalDependencies) });
}
