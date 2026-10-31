// `agentprime note`: per-package usage notes. A note records how the App uses one package (where untrusted
// input enters, where the App calls it, config, wiring, and what is absent), so a later Assessment of another
// Advisory for the same package starts from facts an earlier run gathered. A note is a map of where to look,
// never evidence: the skill re-reads every cited line, and `check` validates each Verdict on its own.
// See scripts/CONTRACT.md "Package usage notes". Owner: check.
// Reads the App's own files only. Never runs anything in the App. Notes live in <app>/.agentprime/notes/ and
// never leave it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { toPosix } from "./apps.mjs";
import { resolvePaths } from "./args.mjs";
import { documentInput, entryKey, installedEntry, lineCount, locateEvidence, readHead } from "./check.mjs";
import { configureFetch } from "./fetch.mjs";
import { readInventory } from "./inventory.mjs";
import { findUsages, usageTarget } from "./usages.mjs";

export const FACT_KINDS = ["entry_point", "call", "config", "wiring", "absence"];
export const MAX_FACTS = 60;
export const MAX_FACT_NOTE = 300;
export const MAX_SUMMARY = 800;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// "vendor/name" (Packagist), "name" or "@scope/name" (npm). The name becomes a file name under .agentprime/notes/.
const SAFE_NAME = /^(?:@[A-Za-z0-9][\w.-]*\/[A-Za-z0-9_][\w.-]*|[A-Za-z0-9][\w.-]*(?:\/[A-Za-z0-9][\w.-]*)?)$/;
const NOTE_KEYS = new Set(["package", "ecosystem", "installed", "commit", "usages_hash", "facts", "summary", "written_at", "from_advisories"]);
// Written by the script on save, whatever the model sent.
const SCRIPT_KEYS = ["installed", "commit", "usages_hash", "written_at"];
const FACT_KEYS = new Set(["file", "line", "kind", "note"]);

const isNonEmptyString = (s) => typeof s === "string" && s.trim() !== "";
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** notePath(appDir, ecosystem, package) -> <app>/.agentprime/notes/<ecosystem>/<package with / replaced by __>.json */
export function notePath(appDir, ecosystem, name) {
  if (ecosystem !== "Packagist" && ecosystem !== "npm") throw new Error(`ecosystem must be Packagist or npm, not ${ecosystem}`);
  if (!SAFE_NAME.test(String(name))) throw new Error(`${JSON.stringify(name)} is not a package name`);
  return join(resolve(appDir), ".agentprime", "notes", ecosystem, `${String(name).replaceAll("/", "__")}.json`);
}

/** The package as the inventory names it (usageTarget), with a name safe to use as a file name. */
function target(inventory, name, ecosystem) {
  if (!isNonEmptyString(name)) throw new Error("give a package name");
  const t = usageTarget(inventory, name, ecosystem);
  if (!SAFE_NAME.test(t.package)) throw new Error(`${JSON.stringify(name)} is not a package name`);
  return t;
}

/** The inventory's entries for the package, in the Verdict's `installed` form (the comparison check uses). */
function currentInstalled(inventory, t) {
  return inventory.packages.filter((p) => sameName(p.name, t.package) && p.ecosystem === t.ecosystem).map(installedEntry);
}
const sameInstalled = (a, b) => {
  const x = (Array.isArray(a) ? a : []).map(entryKey).sort();
  const y = (Array.isArray(b) ? b : []).map(entryKey).sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
};

const fileless = (f) => f.kind === "absence" && (f.file === undefined || f.file === null) && (f.line === undefined || f.line === null);
// A fact with a location is keyed by file, line and kind; an absence resting on the usages search (no file) by its words.
const factKey = (f) => (fileless(f) ? `absence\u0000\u0000${String(f.note ?? "").trim().toLowerCase()}` : `${f.kind}\u0000${f.file}\u0000${f.line}`);
const byLocation = (a, b) => {
  const fa = a.file ?? "";
  const fb = b.file ?? "";
  if (fa !== fb) return fa < fb ? -1 : 1;
  if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return String(a.note) < String(b.note) ? -1 : String(a.note) > String(b.note) ? 1 : 0;
};

/**
 * Why a stored note no longer describes the App, or null when it is fresh: the note is for this package, the
 * inventory's entries for it are the note's `installed`, every cited file exists with the line inside it, and a
 * fresh `usages` hash equals the note's `usages_hash` (computed only when everything else holds, unless given).
 */
async function staleReason(note, { appDir, inventory, t, usagesHash }) {
  if (!isObject(note)) return "the stored note is not a JSON object";
  if (!sameName(note.package, t.package) || note.ecosystem !== t.ecosystem) return `the stored note is for ${note.package} (${note.ecosystem})`;
  if (!t.installed) return `${t.package} is no longer installed`;
  if (!sameInstalled(note.installed, currentInstalled(inventory, t))) return "installed changed";
  const facts = Array.isArray(note.facts) ? note.facts : [];
  for (const f of facts) {
    if (!isObject(f)) return "the stored note has a fact that is not an object";
    if (fileless(f)) continue;
    const where = locateEvidence(appDir, f.file);
    if (where.problem) return `a cited ${where.problem}`;
    const lines = lineCount(readFileSync(where.abs, "utf8"));
    if (!Number.isInteger(f.line) || f.line < 1 || f.line > lines) return `line ${f.line} of ${where.rel} is past its end (${lines} lines)`;
  }
  const hash = usagesHash ?? (await findUsages(appDir, t)).hash;
  if (note.usages_hash !== hash) return "usages changed";
  return null;
}

/**
 * noteState(appDir, { package, ecosystem?, inventory?, cwd? })
 *   -> { fresh: true, note } | { fresh: false, reason }   (reason "none" when no note is stored)
 * A stale note is reported, never deleted.
 */
export async function noteState(appDir, { package: name, ecosystem, inventory, cwd, usagesHash } = {}) {
  appDir = resolve(appDir ?? ".");
  cwd = resolve(cwd ?? appDir);
  inventory ??= readInventory(appDir, { cwd });
  const t = target(inventory, name, ecosystem);
  const file = notePath(appDir, t.ecosystem, t.package);
  if (!existsSync(file)) return { fresh: false, reason: "none" };
  let note;
  try {
    note = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { fresh: false, reason: "the stored note is not valid JSON" };
  }
  const why = await staleReason(note, { appDir, inventory, t, usagesHash });
  return why ? { fresh: false, reason: why } : { fresh: true, note };
}

/** "fresh" | "stale" | "none", for report rows. A note that can't be judged (the registry failed) is "stale". */
export async function noteLabel(appDir, options) {
  try {
    const s = await noteState(appDir, options);
    return s.fresh ? "fresh" : s.reason === "none" ? "none" : "stale";
  } catch {
    try {
      const inventory = options.inventory ?? readInventory(appDir, { cwd: options.cwd });
      const t = target(inventory, options.package, options.ecosystem);
      return existsSync(notePath(appDir, t.ecosystem, t.package)) ? "stale" : "none";
    } catch {
      return "none";
    }
  }
}

/** Validate the model-written part of a note. Returns { problems, warnings, facts, summary, from }. */
function validate(doc, { appDir }) {
  const problems = [];
  const warnings = [];
  const facts = [];
  if (!Array.isArray(doc.facts)) {
    problems.push("facts must be a list of { file, line, kind, note }");
  } else {
    if (doc.facts.length > MAX_FACTS) problems.push(`facts has ${doc.facts.length} entries; at most ${MAX_FACTS}`);
    const extra = new Set();
    doc.facts.forEach((f, i) => {
      const at = `facts[${i}]`;
      if (!isObject(f)) return problems.push(`${at} must be an object with file, line, kind and note`);
      for (const k of Object.keys(f)) if (!FACT_KEYS.has(k)) extra.add(k);
      let ok = true;
      if (!FACT_KINDS.includes(f.kind)) {
        problems.push(`${at} kind ${JSON.stringify(f.kind)} must be one of ${FACT_KINDS.join(", ")}`);
        ok = false;
      }
      if (!isNonEmptyString(f.note)) {
        problems.push(`${at} note must be a non-empty string`);
        ok = false;
      } else if (f.note.length > MAX_FACT_NOTE) {
        problems.push(`${at} note is ${f.note.length} characters; at most ${MAX_FACT_NOTE} (paraphrase, never quote code)`);
        ok = false;
      }
      if (fileless(f)) {
        if (ok) facts.push({ file: null, line: null, kind: f.kind, note: f.note.trim() });
        return;
      }
      const where = locateEvidence(appDir, f.file);
      if (where.problem) {
        problems.push(`${at} ${where.problem}`);
        return;
      }
      const lines = lineCount(readFileSync(where.abs, "utf8"));
      if (!Number.isInteger(f.line) || f.line < 1 || f.line > lines) {
        problems.push(`${at} line ${JSON.stringify(f.line)} is not a line of ${where.rel} (1..${lines})`);
        return;
      }
      if (ok) facts.push({ file: where.rel, line: f.line, kind: f.kind, note: f.note.trim() });
    });
    if (extra.size) warnings.push(`dropped fields that are not part of a fact: ${[...extra].join(", ")}`);
  }
  if (typeof doc.summary !== "string" || doc.summary.trim() === "") problems.push("summary must be a non-empty string");
  else if (doc.summary.length > MAX_SUMMARY) problems.push(`summary is ${doc.summary.length} characters; at most ${MAX_SUMMARY}`);
  let from = [];
  if (doc.from_advisories !== undefined) {
    if (!Array.isArray(doc.from_advisories) || !doc.from_advisories.every((x) => typeof x === "string" && SAFE_ID.test(x))) {
      problems.push("from_advisories must be a list of advisory ids");
    } else {
      from = [...new Set(doc.from_advisories)];
    }
  }
  const scriptOnly = SCRIPT_KEYS.filter((k) => k in doc);
  if (scriptOnly.length) warnings.push(`ignored ${scriptOnly.join(", ")}: the script writes them`);
  const dropped = Object.keys(doc).filter((k) => !NOTE_KEYS.has(k));
  if (dropped.length) warnings.push(`dropped fields that are not part of a note: ${dropped.join(", ")}`);
  return { problems, warnings, facts, summary: typeof doc.summary === "string" ? doc.summary.trim() : "", from };
}

/** De-duplicate by key; a later fact replaces an earlier one with the same key. */
function dedupe(facts) {
  const map = new Map();
  for (const f of facts) map.set(factKey(f), f);
  return [...map.values()];
}

function writeAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

/**
 * saveNote(doc, { appDir, cwd, ecosystem? })
 *   -> { ok: true, path, saved: "created"|"merged"|"replaced", stale_reason?, facts, warnings? } | { ok: false, problems, warnings? }
 * Validates the model-written part (facts, summary, from_advisories) and fills installed, usages_hash, commit and
 * written_at. A fresh stored note is merged (facts unioned by file+line+kind, the new note text winning;
 * from_advisories unioned; summary replaced); a stale one is replaced.
 */
export async function saveNote(doc, { appDir, cwd, ecosystem } = {}) {
  appDir = resolve(appDir ?? ".");
  cwd = resolve(cwd ?? appDir);
  if (!isObject(doc)) return { ok: false, problems: ["the note is not a JSON object"] };
  if (!isNonEmptyString(doc.package)) return { ok: false, problems: ["package must be a non-empty string"] };
  const inventory = readInventory(appDir, { cwd });
  let t;
  try {
    t = target(inventory, doc.package, ecosystem ?? doc.ecosystem);
  } catch (err) {
    return { ok: false, problems: [err.message] };
  }
  const { problems, warnings, facts: given, summary, from } = validate(doc, { appDir });
  if (!t.installed) problems.unshift(`package not installed: ${doc.package} is not in ${inventory.app.lockfiles.join(" or ")}`);
  if (problems.length) return { ok: false, problems, ...(warnings.length ? { warnings } : {}) };

  const usagesHash = (await findUsages(appDir, t)).hash;
  const state = await noteState(appDir, { package: t.package, ecosystem: t.ecosystem, inventory, cwd, usagesHash });
  const fresh = dedupe(given);
  let facts = fresh;
  let fromAll = from;
  let saved = "created";
  if (state.fresh) {
    saved = "merged";
    const newKeys = new Set(fresh.map(factKey));
    const kept = (state.note.facts ?? []).filter((f) => isObject(f) && !newKeys.has(factKey(f)));
    facts = [...fresh, ...kept];
    if (facts.length > MAX_FACTS) {
      warnings.push(`the merged note would have ${facts.length} facts; kept the ${MAX_FACTS} newest (${facts.length - MAX_FACTS} older facts dropped)`);
      facts = facts.slice(0, MAX_FACTS);
    }
    fromAll = [...new Set([...(Array.isArray(state.note.from_advisories) ? state.note.from_advisories : []), ...from])];
  } else if (state.reason !== "none") {
    saved = "replaced";
  }

  let commit = null;
  try {
    commit = readHead(cwd)?.commit ?? null;
  } catch {
    commit = null;
  }
  const note = {
    package: t.package,
    ecosystem: t.ecosystem,
    installed: currentInstalled(inventory, t),
    commit,
    usages_hash: usagesHash,
    facts: [...facts].sort(byLocation),
    summary,
    written_at: new Date().toISOString(),
    from_advisories: fromAll,
  };
  const file = notePath(appDir, t.ecosystem, t.package);
  writeAtomic(file, note);
  return {
    ok: true,
    path: toPosix(relative(cwd, file)),
    saved,
    ...(saved === "replaced" ? { stale_reason: state.reason } : {}),
    facts: note.facts.length,
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * agentprime note <package> [--app p] [--ecosystem E]               -> { fresh: true, note } | { fresh: false, reason }
 * agentprime note save <-|file> | --json '<note>' [--app p] [--ecosystem E] -> { path, saved, facts, ... }; exit 2 on problems
 */
export async function run(args) {
  const { flags = {}, positional = [] } = args;
  const { cwd, appDir } = resolvePaths(flags);
  configureFetch({ cwd });
  const ecosystem = typeof flags.ecosystem === "string" ? flags.ecosystem : undefined;
  if (positional[0] === "save") {
    const doc = documentInput(flags, positional[1], "note");
    const res = await saveNote(doc, { appDir, cwd, ecosystem });
    if (!res.ok) {
      process.stdout.write(JSON.stringify({ ok: false, problems: res.problems, ...(res.warnings ? { warnings: res.warnings } : {}) }, null, 2) + "\n");
      const err = new Error(`note rejected: ${res.problems.length} problem${res.problems.length === 1 ? "" : "s"} (listed on stdout)`);
      err.exitCode = 2;
      throw err;
    }
    const { ok, ...out } = res;
    return out;
  }
  const name = positional[0];
  if (!name) throw new Error("usage: agentprime note <package> [--app p] [--ecosystem E] | agentprime note save <-|file> | --json '<note>' [--app p]");
  if (flags.json !== undefined) throw new Error("--json goes with agentprime note save");
  return noteState(appDir, { package: name, ecosystem, cwd });
}
