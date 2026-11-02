// `agentprime report` (the noise report) and `agentprime eval` (the labelled-set gate, PRD §9).
// See scripts/CONTRACT.md "Slice 2" and docs/slices.md slice 2 and "Cost". Owner: report.
// Each Advisory is assessed by one headless Claude Code run of the does-this-affect-me skill. This module only
// starts those runs, reads their JSON result and the Verdict file `check` wrote, and summarises. It never decides
// a Verdict and never executes anything inside the App.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { toPosix } from "./apps.mjs";
import { resolvePaths } from "./args.mjs";
import { checkVerdict, evidenceHash, lowestFix, readHead } from "./check.mjs";
import { configureFetch } from "./fetch.mjs";
import { sha256 } from "./hash.mjs";
import { readInventory } from "./inventory.mjs";
import { noteLabel } from "./notes.mjs";
import { formatAffectedRange, matchInventory, rangeContains, resolveAdvisory } from "./osv.mjs";
import { bumpClass, compare, normalise } from "./semver.mjs";
import { findUsages, usageTarget } from "./usages.mjs";

/** The plugin root: the directory holding scripts/agentprime.mjs. */
export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The domains stage 1 (Advisory analysis) may fetch an Advisory's own references from: the fix commit and the
 * GitHub advisory page on github.com, the OSV record on osv.dev and api.osv.dev. Any other domain is denied in a
 * headless run (nobody is there to approve it). Verified live: see CONTRACT.md "Notes from building the plugin".
 */
export const WEBFETCH_DOMAINS = ["github.com", "osv.dev", "api.osv.dev"];

/**
 * The tools a headless run may use (ADR-0006): the read-only tools, subagents, WebFetch for the Advisory's
 * references on WEBFETCH_DOMAINS only, and Bash only for the agentprime script under this plugin directory, which
 * is how the skill invokes it (unquoted, so the path must not contain whitespace). No echo/cat/printf, no other
 * node: the model can't write a Verdict file itself; only `check` can.
 */
export function allowedTools(pluginDir = PLUGIN_DIR) {
  const fetches = WEBFETCH_DOMAINS.map((d) => `WebFetch(domain:${d})`).join(",");
  return `Read,Grep,Glob,Agent,Task,${fetches},Bash(node ${scriptPath(pluginDir)}:*)`;
}
/**
 * Denied outright, whatever the allow list or a settings file says. WebFetch is not here: a deny rule beats every
 * allow rule, so a blanket `WebFetch` deny would also block the domains allowedTools names. Fetches to any other
 * domain are still refused, because nothing allows them and a headless run has nobody to ask.
 */
export const DISALLOWED_TOOLS = "Write,Edit,MultiEdit,NotebookEdit,WebSearch,Bash(node -e:*)";

function scriptPath(pluginDir) {
  const dir = resolve(pluginDir);
  if (/\s/.test(dir)) throw new Error(`the plugin directory ${JSON.stringify(dir)} contains whitespace; the skill runs the script unquoted, so its path can't have any`);
  return `${dir}/scripts/agentprime.mjs`; // spelled exactly as the skill invokes it: ${CLAUDE_PLUGIN_ROOT}/scripts/agentprime.mjs
}
export const DEFAULT_MAX_TURNS = 25;
export const DEFAULT_TIMEOUT_SECONDS = 900;
/** How long to wait before the one retry of a run the API reported as overloaded. */
export const DEFAULT_RETRY_BACKOFF_SECONDS = 30;
/** The statuses `--retry-errors` re-runs, read from the last report.json. */
export const RETRY_STATUSES = ["error", "limit", "timeout", "not_run"];

const VERDICTS = ["not_affected", "reachable_unproven", "inconclusive"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const KILL_GRACE_MS = 5000;

const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const round = (n) => Math.round(n * 1e6) / 1e6;
const isNum = (n) => typeof n === "number" && Number.isFinite(n);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

const verdictFile = (appDir, id) => join(appDir, ".agentprime", "verdicts", `${id}.json`);
const draftFile = (appDir, id) => join(appDir, ".agentprime", "drafts", `${id}.json`);
const profileFile = (appDir, id) => join(appDir, ".agentprime", "profiles", `${id}.json`);
const appProfileFile = (appDir) => join(appDir, ".agentprime", "profile.json");

// The Verdict form of an inventory entry, exactly as check writes it.
// npm entries carry `bundled` (imported from client source); Packagist entries never do.
const installedEntry = (p) => ({
  version: normalise(p.version), lockfile: p.lockfile, direct: p.direct === true, dev: p.dev === true, via: [...(p.via ?? [])],
  ...(p.ecosystem === "npm" || typeof p.bundled === "boolean" ? { bundled: p.bundled === true } : {}),
});
const entryKey = (e) => JSON.stringify([normalise(e?.version), e?.lockfile, e?.direct === true, e?.dev === true, Array.isArray(e?.via) ? e.via : [], e?.bundled === true]);

// ---------------------------------------------------------------- the Verdict cache

/**
 * cacheState(advisory, appDir, cwd, { inventory? }) -> { cached: true, verdict } | { cached: false, reason }
 * The stored Verdict is reused only when every input is unchanged (CONTRACT "Slice 2" step 2). Anything missing
 * (no profile, no hash) is a miss: reuse is exact or not at all.
 */
export async function cacheState(advisory, appDir, cwd, { inventory } = {}) {
  appDir = resolve(appDir);
  cwd = resolve(cwd ?? appDir);
  const id = advisory?.id;
  if (typeof id !== "string" || !SAFE_ID.test(id)) return { cached: false, reason: "the Advisory has no usable id" };

  const verdict = readJson(verdictFile(appDir, id));
  if (!verdict || typeof verdict !== "object") return { cached: false, reason: "no stored Verdict" };
  if (verdict.advisory_id !== id) return { cached: false, reason: `the stored Verdict is for ${verdict.advisory_id}` };
  if (!VERDICTS.includes(verdict.verdict)) return { cached: false, reason: "the stored Verdict has no valid verdict" };

  const profile = readJson(profileFile(appDir, id));
  if (!profile?.advisory) return { cached: false, reason: "no Advisory profile" };
  const saved = profileRange(profile.advisory, advisory.package, advisory.ecosystem);
  if (saved.affected_range !== advisory.affected_range) {
    return { cached: false, reason: `affected_range changed (${saved.affected_range} -> ${advisory.affected_range})` };
  }
  if (!isDeepStrictEqual(saved.fixed_versions, advisory.fixed_versions)) {
    return { cached: false, reason: "fixed_versions changed" };
  }

  inventory ??= readInventory(appDir, { cwd });
  const ecosystem = advisory.ecosystem;
  const ours = inventory.packages
    .filter((p) => sameName(p.name, advisory.package) && (!ecosystem || p.ecosystem === ecosystem))
    .map((p) => entryKey(installedEntry(p)))
    .sort();
  const theirs = (Array.isArray(verdict.installed) ? verdict.installed : []).map(entryKey).sort();
  if (!ours.length || !isDeepStrictEqual(ours, theirs)) return { cached: false, reason: "installed changed" };

  const hashes = verdict.hashes ?? {};
  if (typeof hashes.usages !== "string") return { cached: false, reason: "the stored Verdict has no usages hash" };
  if (typeof hashes.evidence !== "string") return { cached: false, reason: "the stored Verdict has no evidence hash" };

  // App evidence files, and for vendor evidence the cited vendor/ file with the version composer.lock installs.
  if (evidenceHash(appDir, verdict.evidence) !== hashes.evidence) return { cached: false, reason: "an evidence file changed" };

  // check records hashes.profile whenever an App profile exists, so an App profile that appeared, changed or
  // went away since the Verdict is a changed input too.
  const appProfile = existsSync(appProfileFile(appDir)) ? sha256(readFileSync(appProfileFile(appDir), "utf8")) : null;
  if ((hashes.profile ?? null) !== appProfile) return { cached: false, reason: "the App profile changed" };

  const usages = await findUsages(appDir, usageTarget(inventory, advisory.package, ecosystem));
  if (usages.hash !== hashes.usages) return { cached: false, reason: "usages changed" };

  return { cached: true, verdict };
}

/**
 * What the saved profile says about the Match's package: { affected_range, fixed_versions }. A Match describes
 * the installed package, but a profile's `advisory` block describes one package of a possibly multi-package
 * Advisory, so when the block's `affected` has entries for the Match's package, the range and fixed versions
 * are derived from those (the same way normaliseOsv derives the block's); otherwise the block's own fields.
 */
export function profileRange(block, pkg, ecosystem) {
  const entries = (Array.isArray(block?.affected) ? block.affected : []).filter(
    (a) => a && typeof a === "object" && sameName(a.package, pkg) && (!ecosystem || !a.ecosystem || a.ecosystem === ecosystem),
  );
  if (!entries.length) return { affected_range: block?.affected_range, fixed_versions: block?.fixed_versions };
  const ranges = entries.flatMap((a) => (Array.isArray(a.ranges) ? a.ranges : []));
  const fixed = [...new Set(ranges.map((r) => r?.fixed).filter((v) => typeof v === "string" && v !== ""))].sort(compare);
  return { affected_range: formatAffectedRange(entries.map((a) => ({ ...a, ranges: Array.isArray(a.ranges) ? a.ranges : [] }))), fixed_versions: fixed };
}

/** isCached(advisory, appDir, cwd) -> Promise<boolean> */
export async function isCached(advisory, appDir, cwd) {
  return (await cacheState(advisory, appDir, cwd)).cached;
}

// ---------------------------------------------------------------- one headless run

/**
 * The JSON object `claude -p --output-format json` prints, tolerating stray non-JSON lines before it. An object
 * with `type: "result"` wins over any other JSON on stdout, and a message array (what `--verbose` prints) gives
 * its last result message.
 */
export function parseResult(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
  const resultOf = (v) => (Array.isArray(v) ? v.findLast((m) => isObject(m) && m.type === "result") ?? null : isObject(v) ? v : null);
  let fallback = null;
  const consider = (v) => {
    const r = resultOf(v);
    if (r && r.type === "result") return r;
    fallback ??= r;
    return null;
  };
  try {
    const r = consider(JSON.parse(text));
    if (r) return r;
  } catch {
    // stray lines; look for the object below
  }
  const lines = text.split(/\r?\n/);
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const first = lines[i].trimStart();
    if (!first.startsWith("{") && !first.startsWith("[")) continue;
    try {
      const r = consider(JSON.parse(lines.slice(i, end).join("\n")));
      if (r) return r;
      end = i; // a JSON value that isn't the result: keep looking above it
    } catch {
      // keep looking further up (a pretty-printed object starts on an earlier line)
    }
  }
  return fallback;
}

// Why a run ended without a Verdict, from the skill's final message. A message that reports check problems is
// `rejected` even when it also says the version is outside the range (check found that), so rejection is tested
// first. "No Verdict was written/recorded" appears in both kinds of message, so it only decides when nothing more
// specific does.
const REJECTED = [/\brejected\b/i, /\bcheck\b[^.\n]*\b(?:reject|problem)/i];
const NO_MATCH = [/not a match/i, /outside the affected range/i];
const REJECTED_WEAK = [/no verdict (?:was|is) recorded/i];
const NO_MATCH_WEAK = [/no verdict (?:was|is) written/i];

function snapshot(file) {
  try {
    const st = statSync(file);
    return { mtimeMs: st.mtimeMs, content: readFileSync(file, "utf8") };
  } catch {
    return null;
  }
}

const excerpt = (s, n = 300) => {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n - 3) + "..." : t;
};

/**
 * The prompt for one run. It always names the App (relative to the Repository root), so a headless run never
 * has to pick one or ask, however many Apps the Repository holds.
 */
export function headlessPrompt(advisoryId, cwd, appDir) {
  return `/agentprime:does-this-affect-me ${advisoryId} --app ${toPosix(relative(cwd, appDir)) || "."}`;
}

/**
 * The argument list for `claude` (CONTRACT "Slice 2" step 3). `--max-turns` caps the main conversation's model
 * turns (not subagents', which the agent definitions cap, and not what the result's `num_turns` counts).
 * `--max-budget-usd` is passed only when a cost cap is given; Claude Code checks it against its own cost estimate,
 * subagents included, and a run can pass it by about one response.
 */
export function headlessArgs({ prompt, maxTurns = DEFAULT_MAX_TURNS, pluginDir = PLUGIN_DIR, model, maxCostUsd }) {
  pluginDir = resolve(pluginDir);
  const args = [
    "-p", prompt, "--output-format", "json", "--max-turns", String(maxTurns), "--plugin-dir", pluginDir,
    "--allowedTools", allowedTools(pluginDir), "--disallowedTools", DISALLOWED_TOOLS,
  ];
  if (maxCostUsd !== undefined && maxCostUsd !== null) args.push("--max-budget-usd", String(maxCostUsd));
  if (model) args.push("--model", model);
  return args;
}

// The caps a result subtype says the run hit, as report.json names them.
const LIMIT_SUBTYPES = { error_max_turns: "max_turns", error_max_budget_usd: "max_cost_usd" };

/**
 * What a run that stopped on the account's usage or rate limit says. Claude Code 2.1.314 words a rejected request
 * as "You've hit your <5-hour limit|weekly limit|Opus limit|usage limit|monthly spend limit|…> · resets <time>",
 * "You've reached your …", "You're out of usage credits" or "You're out of extra usage", an API key without
 * credit as "Credit balance is too low", and older releases as "Claude AI usage limit reached|<epoch>"; the API's
 * own error is a 429 `rate_limit_error`. Matched only against what the CLI said (see cliText), never the model's
 * answer, which can discuss an Advisory about rate limiting.
 */
export const USAGE_LIMIT_PATTERNS = [
  /usage limit/i, /rate[\s_-]?limit/i, /limit reached/i, /\bhit your\b/i, /\breached your\b[^\n]{0,40}\blimit\b/i, /\bquota\b/i,
  /\b429\b/, /\bout of (?:extra )?usage\b/i, /\bout of usage credits\b/i, /credit balance (?:is )?too low/i, /spend limit/i,
];
/** A transient API failure, retried once: "API Error: Repeated 529 Overloaded errors", `overloaded_error`. */
export const OVERLOADED_PATTERNS = [/overloaded/i, /\b529\b/];

/** limitKind(text) -> "usage_limit" | "overloaded" | null. A usage limit wins when both match. */
export function limitKind(text) {
  const t = String(text ?? "");
  if (USAGE_LIMIT_PATTERNS.some((re) => re.test(t))) return "usage_limit";
  if (OVERLOADED_PATTERNS.some((re) => re.test(t))) return "overloaded";
  return null;
}

/**
 * The draft the skill saved with `save verdict` when check kept rejecting it, re-checked here: check's own
 * problems are what report.json keeps, never the model's account of them. Each problem is script text (it can
 * name an evidence path or an id the draft gave), cut to 300 characters, at most 20 of them.
 */
async function checkDraft(content, { advisoryId, appDir, cwd }) {
  let doc;
  try {
    doc = JSON.parse(content);
  } catch {
    // JSON.parse's message quotes the text it read, which the model wrote.
    return { ok: false, problems: [`the draft ${advisoryId}.json is not valid JSON`] };
  }
  // A Provisional Advisory is not in OSV; check reads it from the saved profile, as the skill's check does.
  const advisory = /^PROV-/i.test(advisoryId) ? readJson(profileFile(appDir, advisoryId)) ?? undefined : undefined;
  try {
    const res = await checkVerdict(doc, { appDir, cwd, advisory });
    if (res.ok) return { ok: true };
    return { ok: false, problems: res.problems.slice(0, 20).map((p) => excerpt(p, 300)) };
  } catch (err) {
    return { ok: false, problems: [excerpt(`agentprime check could not run on the draft: ${err.message}`, 300)] };
  }
}

/**
 * runHeadless({ advisoryId, cwd, appDir, pluginDir, maxTurns, model, maxCostUsd, timeoutSeconds })
 *   -> { verdict?, cost_usd, turns, status, limit?, error?, cli_subtype?, exit_code?, check_problems?, transient?, result? }
 * status: verdict | no_match | rejected | limit | error | timeout. On `verdict` the Verdict file check wrote gets
 * cost_usd and turns added. `turns` is the result's `num_turns` as reported (CONTRACT "Slice 2" step 3 says what
 * it counts); `limit` is "max_turns" or "max_cost_usd" when the run stopped at that cap. `limit` the status is
 * the account's usage or rate limit (USAGE_LIMIT_PATTERNS). `error` and `limit` carry the CLI's result subtype and
 * exit code; `transient: "overloaded"` marks an error worth one retry. `check_problems` is what check says about
 * a draft the skill saved during this run (CONTRACT "Slice 2" step 3). `result` is the model's final message,
 * for eval's console output only; report.json never stores it.
 */
export async function runHeadless({ advisoryId, cwd, appDir, pluginDir = PLUGIN_DIR, maxTurns = DEFAULT_MAX_TURNS, model, maxCostUsd, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS }) {
  cwd = resolve(cwd);
  appDir = resolve(appDir ?? cwd);
  if (typeof advisoryId !== "string" || !SAFE_ID.test(advisoryId)) {
    return { cost_usd: null, turns: null, status: "error", error: `${JSON.stringify(advisoryId)} is not an advisory id` };
  }
  const file = verdictFile(appDir, advisoryId);
  const draft = draftFile(appDir, advisoryId);
  const before = snapshot(file);
  const draftBefore = snapshot(draft);
  const bin = process.env.AGENTPRIME_CLAUDE ?? "claude";
  let args;
  try {
    args = headlessArgs({ prompt: headlessPrompt(advisoryId, cwd, appDir), maxTurns, pluginDir, model, maxCostUsd });
  } catch (err) {
    return { cost_usd: null, turns: null, status: "error", error: err.message };
  }

  const run = await new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let exited = null;
    let finished = false;
    const finish = (extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killer);
      done({ stdout, stderr, timedOut, code: exited?.code ?? null, signal: exited?.signal ?? null, ...extra });
    };
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (err) {
      done({ stdout, stderr, timedOut, code: null, spawnError: err });
      return;
    }
    let killer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutSeconds * 1000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => finish({ spawnError: err }));
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      // A killed run's grandchildren can hold the pipes open; don't wait for them.
      if (timedOut) finish();
    });
    child.on("close", (code, signal) => {
      exited ??= { code, signal };
      finish();
    });
  });

  const parsed = parseResult(run.stdout);
  const cost_usd = isNum(parsed?.total_cost_usd) ? parsed.total_cost_usd : null;
  const turns = Number.isInteger(parsed?.num_turns) ? parsed.num_turns : null;
  const result = typeof parsed?.result === "string" ? parsed.result : undefined;
  const cap = LIMIT_SUBTYPES[parsed?.subtype];
  const after = snapshot(file);
  const written = after !== null && (before === null || after.content !== before.content || after.mtimeMs !== before.mtimeMs);

  let verdict;
  if (written) {
    try {
      verdict = JSON.parse(after.content);
    } catch (err) {
      return { cost_usd, turns, status: "error", error: `the Verdict file ${advisoryId}.json is not valid JSON: ${err.message}` };
    }
    verdict.cost_usd = cost_usd;
    verdict.turns = turns;
    writeJson(file, verdict);
  }

  // A draft saved during this run (an older one is not this run's) and no Verdict: check is the source of truth
  // for why the Verdict was refused.
  const draftAfter = verdict ? null : snapshot(draft);
  const draftWritten = draftAfter !== null && (draftBefore === null || draftAfter.content !== draftBefore.content || draftAfter.mtimeMs !== draftBefore.mtimeMs);
  const drafted = draftWritten ? await checkDraft(draftAfter.content, { advisoryId, appDir, cwd }) : null;
  const check_problems = drafted && !drafted.ok ? drafted.problems : undefined;

  const out = (status, extra = {}) => ({
    ...(verdict ? { verdict } : {}), cost_usd, turns, status, ...(cap ? { limit: cap } : {}), ...(result !== undefined ? { result: excerpt(result) } : {}),
    ...extra, ...(check_problems ? { check_problems } : {}),
  });
  // The CLI's own diagnostics for an error or limit row: its result subtype and exit code.
  const cli = { cli_subtype: typeof parsed?.subtype === "string" ? parsed.subtype : null, exit_code: run.code ?? null };

  // A Verdict check accepted is the outcome, even if the run then hung or failed: it is on disk and the cache will
  // reuse it, so counting it as a timeout too would put one row in two buckets.
  if (verdict) return out("verdict");
  if (run.timedOut) return out("timeout", { error: `no result after ${timeoutSeconds}s; the run was stopped` });
  if (run.spawnError) return out("error", { error: `could not start ${bin}: ${run.spawnError.message}`, ...cli });
  if (cap === "max_turns") return out("error", { error: `the run stopped at the --max-turns cap (${maxTurns}) without a Verdict`, ...cli });
  if (cap === "max_cost_usd") return out("error", { error: `the run stopped at the --max-cost-usd cap ($${maxCostUsd ?? "?"}) without a Verdict`, ...cli });

  // What the CLI said, never the model: the result text of an error result, or of a run that cost nothing (no
  // model call was made, so no model wrote it), and stderr of a run that failed.
  const failed = !parsed || parsed.is_error === true || run.code !== 0;
  const cliResult = parsed?.is_error === true || cost_usd === 0 ? result ?? "" : "";
  const cliText = [cliResult, failed ? run.stderr : ""].map((t) => t.trim()).filter(Boolean).join(" | ");
  const kind = failed || cost_usd === 0 ? limitKind(cliText) : null;
  if (kind === "usage_limit") return out("limit", { error: `stopped by a usage or rate limit: ${excerpt(cliText)}`, ...cli });
  if (kind === "overloaded") return out("error", { error: `the API was overloaded: ${excerpt(cliText)}`, transient: "overloaded", ...cli });

  if (!parsed) {
    const why = run.code !== 0 ? `${bin} exited with ${run.code ?? run.signal}` : "no JSON result on stdout";
    return out("error", { error: `${why}${run.stderr.trim() ? `: ${excerpt(run.stderr, 200)}` : ""}`, ...cli });
  }
  if (parsed.is_error === true || run.code !== 0) {
    const why = parsed.is_error === true ? `the run ended in an error${parsed.subtype ? ` (${parsed.subtype})` : ""}` : `${bin} exited with ${run.code ?? run.signal}`;
    // An error result's text is the CLI's error message; a non-error result is the model's answer, which is not
    // an error message and is kept out of what report.json stores.
    return out("error", { error: `${why}${parsed.is_error === true && result ? `: ${excerpt(result)}` : ""}`, ...cli });
  }
  const rejected = () => out("rejected", { error: "agentprime check rejected the Verdict; none was recorded" });
  if (check_problems) return rejected();
  const text = result ?? "";
  const says = (res) => res.some((re) => re.test(text));
  if (says(REJECTED)) return rejected();
  if (says(NO_MATCH)) return out("no_match");
  if (says(REJECTED_WEAK)) return rejected();
  if (says(NO_MATCH_WEAK)) return out("no_match");
  return out("error", { error: "the run ended without a Verdict and did not say why", ...cli });
}

/**
 * runHeadless, with one retry after `backoffSeconds` when the API reported itself overloaded. A second overloaded
 * result is an error. `retries: 1` marks a retried run; its cost is both runs' cost.
 */
export async function runWithRetry(options, { backoffSeconds = DEFAULT_RETRY_BACKOFF_SECONDS } = {}) {
  const first = await runHeadless(options);
  if (first.transient !== "overloaded") return first;
  progress(`${options.advisoryId}: the API was overloaded; retrying once in ${backoffSeconds}s`);
  await new Promise((r) => setTimeout(r, backoffSeconds * 1000));
  const second = await runHeadless(options);
  const costs = [first.cost_usd, second.cost_usd].filter(isNum);
  const out = { ...second, cost_usd: costs.length ? round(costs.reduce((a, b) => a + b, 0)) : null, retries: 1 };
  if (second.transient === "overloaded") out.error = `${second.error} (again after one retry)`;
  return out;
}

// ---------------------------------------------------------------- shared helpers

function positiveInt(flags, name, fallback) {
  const v = flags[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, not ${JSON.stringify(v)}`);
  return n;
}

function positiveNumber(flags, name, fallback, unit = "seconds") {
  const v = flags[name];
  if (v === undefined) return fallback;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number of ${unit}, not ${JSON.stringify(v)}`);
  return n;
}

const flagOn = (v) => v === true || v === "true";
const str = (flags, k) => (typeof flags[k] === "string" ? flags[k] : undefined);
// `--only` with no value parses as true; reading that as "no filter" would start a run for every Advisory.
const idList = (v) => {
  if (v === undefined) return null;
  if (typeof v !== "string") throw new Error("--only needs a comma-separated list of advisory ids");
  return v.split(",").map((s) => s.trim()).filter(Boolean);
};

function runOptions(flags, cwd) {
  const pluginDir = str(flags, "plugin-dir") ? resolve(cwd, flags["plugin-dir"]) : PLUGIN_DIR;
  allowedTools(pluginDir); // a plugin path the allow rule can't name fails here, before any run
  return {
    maxTurns: positiveInt(flags, "max-turns", DEFAULT_MAX_TURNS),
    model: str(flags, "model"),
    maxCostUsd: positiveNumber(flags, "max-cost-usd", undefined, "US dollars"),
    pluginDir,
    timeoutSeconds: positiveNumber(flags, "timeout-seconds", DEFAULT_TIMEOUT_SECONDS),
    concurrency: positiveInt(flags, "concurrency", 1),
  };
}

/**
 * schedulePackages(items, n, keyOf, fn, ranOf) -> results in item order, with at most n in flight, items taken in
 * order, except that an item whose package (keyOf) has a run in flight that is the package's first is held back
 * until that one finishes. The first item of a package to actually run (ranOf(result) true, whatever its outcome)
 * leads it; one that did not run (cached, not run) hands the lead to the next. So with concurrency N the first
 * wave is one item per distinct package, and siblings start only after their package's first run has finished
 * (and saved its package usage note, if it did).
 */
export function schedulePackages(items, n, keyOf, fn, ranOf = () => true) {
  const out = new Array(items.length);
  const pending = items.map((_, i) => i);
  const lead = new Map(); // package key -> "running" | "done"
  let inFlight = 0;
  return new Promise((resolveAll, rejectAll) => {
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (!pending.length && inFlight === 0) return resolveAll(out);
      while (inFlight < n) {
        const at = pending.findIndex((i) => lead.get(keyOf(items[i])) !== "running");
        if (at === -1) break;
        const [i] = pending.splice(at, 1);
        const key = keyOf(items[i]);
        const leading = !lead.has(key);
        if (leading) lead.set(key, "running");
        inFlight++;
        Promise.resolve()
          .then(() => fn(items[i], i))
          .then(
            (res) => {
              out[i] = res;
              if (leading) {
                if (ranOf(res)) lead.set(key, "done");
                else lead.delete(key);
              }
              inFlight--;
              pump();
            },
            (err) => {
              failed = true;
              rejectAll(err);
            },
          );
      }
    };
    pump();
  });
}

/** Run fn over items with at most n in flight; results in item order. */
async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const isMalicious = (advisory) => [advisory.id, ...(advisory.aliases ?? [])].some((x) => /^MAL-/i.test(String(x)));

/** splitMalicious(matches) -> { advisories: Match[], malicious: Match[] } (OSV ids starting MAL-). */
export function splitMalicious(matches) {
  const advisories = [];
  const malicious = [];
  for (const m of matches) (isMalicious(m.advisory) ? malicious : advisories).push(m);
  return { advisories, malicious };
}

const progress = (line) => process.stderr.write(line + "\n");
const money = (n) => `$${(n ?? 0).toFixed(2)}`;
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- report

/**
 * One row: from the cache, or from a headless run, or, when `skip()` says the run may not start (--no-run, a
 * usage limit stopped the report, or --retry-errors leaves this row out), the cache state alone. `skip()` is
 * asked after the cache check, right before a run would start, so a limit another run hit meanwhile counts.
 * Every row is kept, whatever happened to its run.
 */
async function assessMatch(match, { appDir, cwd, inventory, skip, opts, backoffSeconds }) {
  const a = match.advisory;
  const base = { advisory_id: a.id, package: a.package, installed: match.installed.map(installedEntry) };
  let state;
  try {
    state = await cacheState(a, appDir, cwd, { inventory });
  } catch (err) {
    state = { cached: false, reason: `the cache could not be checked: ${err.message}` };
  }
  if (state.cached) {
    const v = state.verdict;
    return { ...base, verdict: v.verdict, action: v.action ?? null, reason: v.reason ?? null, cost_usd: v.cost_usd ?? null, turns: v.turns ?? null, cached: true, status: "verdict" };
  }
  const skipped = skip();
  if (skipped?.carry) return { ...skipped.carry, cached: false, carried: true };
  if (skipped) {
    return { ...base, verdict: null, action: null, reason: null, cost_usd: null, turns: null, cached: false, status: "not_run", cache_miss: state.reason, ...(skipped.error ? { error: skipped.error } : {}) };
  }
  // The package usage note as the run finds it when it starts (`agentprime note`'s logic).
  const note = await noteLabel(appDir, { package: a.package, ecosystem: a.ecosystem, inventory, cwd });
  const r = await runWithRetry({ advisoryId: a.id, cwd, appDir, ...opts }, { backoffSeconds });
  const v = r.verdict;
  const failed = r.status === "error" || r.status === "limit";
  return {
    ...base,
    verdict: v?.verdict ?? null,
    action: v?.action ?? null,
    // Only the checked Verdict's reason: report.json is stored, and the run's own final message is model text
    // that check never saw (ADR-0006: only the Verdict is kept, transcripts are discarded).
    reason: v?.reason ?? null,
    cost_usd: r.cost_usd,
    turns: r.turns,
    cached: false,
    status: r.status,
    note,
    ...(r.limit ? { limit: r.limit } : {}),
    ...(r.error ? { error: r.error } : {}),
    // Script- and CLI-generated diagnostics only (never the model's words): the CLI's result subtype and exit code
    // for a failed run, and check's problems with the draft the skill saved.
    ...(failed ? { cli_subtype: r.cli_subtype ?? null, exit_code: r.exit_code ?? null } : {}),
    ...(r.check_problems ? { check_problems: r.check_problems } : {}),
    ...(r.retries ? { retries: r.retries } : {}),
  };
}

export function reportCounts(rows) {
  const counts = {
    advisories: rows.length, not_affected: 0, reachable_unproven: 0, inconclusive: 0, no_match: 0, rejected: 0, error: 0, limit: 0, not_run: 0, cached: 0, upgrade: 0,
  };
  for (const r of rows) {
    if (r.verdict && VERDICTS.includes(r.verdict)) counts[r.verdict]++;
    if (r.status === "no_match") counts.no_match++;
    else if (r.status === "rejected") counts.rejected++;
    else if (r.status === "error" || r.status === "timeout") counts.error++;
    else if (r.status === "limit") counts.limit++;
    else if (r.status === "not_run") counts.not_run++;
    if (r.cached) counts.cached++;
    if (r.action === "upgrade") counts.upgrade++;
  }
  return counts;
}

const BUMP_RANK = { patch: 0, minor: 1, major: 2 };

/**
 * groupUpgrades(rows, advisories) -> one entry per package with at least one `action: "upgrade"` row:
 * { package, ecosystem, installed: [versions], to, bump, direct, advisories: [ids], unfixed: [ids],
 *   verdicts: { reachable_unproven, inconclusive } }.
 * `advisories` maps each row's advisory_id to its Advisory (the Match's). `to` is the lowest version at or above
 * every fix the package's matched Advisories in these rows need (not only the upgrade rows), so one PR clears the
 * whole set: per Advisory the lowest fixed version above each installed version that the Advisory itself does not
 * affect (check's lowestFix), the highest of those, then moved up past any Advisory whose range still contains it.
 * An Advisory with no such fixed version is listed in `unfixed` and left out of `to`; `to` and `bump` are null when
 * every one is unfixed. `bump` is the largest bumpClass from an installed version to `to`.
 */
export function groupUpgrades(rows, advisories) {
  const advisoryOf = (r) => (advisories instanceof Map ? advisories.get(r.advisory_id) : advisories?.[r.advisory_id]);
  const keyOf = (r) => {
    const a = advisoryOf(r);
    return a ? `${a.ecosystem}\u0000${String(r.package).toLowerCase()}` : null;
  };
  const wanted = new Set(rows.filter((r) => r.action === "upgrade").map(keyOf).filter(Boolean));
  const out = [];
  for (const key of wanted) {
    const group = rows.filter((r) => keyOf(r) === key);
    const ecosystem = advisoryOf(group[0]).ecosystem;
    const name = group[0].package;
    const installed = [...new Set(group.flatMap((r) => (r.installed ?? []).map((e) => normalise(e.version))))].sort(compare);
    const fixable = [];
    const unfixed = [];
    let to = null;
    for (const r of group) {
      const a = advisoryOf(r);
      const needs = installed.map((v) => lowestFix(v, a, name, ecosystem));
      if (!installed.length || needs.some((n) => n === null)) {
        unfixed.push(a.id);
        continue;
      }
      fixable.push(a);
      for (const n of needs) if (to === null || compare(n, to) > 0) to = n;
    }
    // The highest fix can sit inside another Advisory's range (a later branch it fixes only further up): move up.
    for (let changed = to !== null, rounds = 0; changed && rounds < 100; rounds++) {
      changed = false;
      for (const a of [...fixable]) {
        if (!rangeContains(a.affected ?? [], to, name, ecosystem)) continue;
        const next = lowestFix(to, a, name, ecosystem);
        if (next === null) {
          fixable.splice(fixable.indexOf(a), 1);
          unfixed.push(a.id);
          continue;
        }
        to = next;
        changed = true;
      }
    }
    if (!fixable.length) to = null;
    const bump = to === null ? null : installed.map((v) => bumpClass(v, to)).reduce((x, y) => (BUMP_RANK[y] > BUMP_RANK[x] ? y : x), "patch");
    out.push({
      package: name,
      ecosystem,
      installed,
      to,
      bump,
      direct: group.some((r) => (r.installed ?? []).some((e) => e.direct === true)),
      advisories: group.map((r) => r.advisory_id),
      unfixed: group.map((r) => r.advisory_id).filter((id) => unfixed.includes(id)),
      verdicts: {
        reachable_unproven: group.filter((r) => r.verdict === "reachable_unproven").length,
        inconclusive: group.filter((r) => r.verdict === "inconclusive").length,
      },
    });
  }
  return out.sort((x, y) => (x.package < y.package ? -1 : x.package > y.package ? 1 : x.ecosystem < y.ecosystem ? -1 : 1));
}

/**
 * noteCostAverages(rows) -> { fresh: { runs, average_usd }, without: { runs, average_usd } } | null
 * Over the runs this report started (not cached or carried rows) that reported a cost: those that began with a
 * fresh package usage note, and those that began with a stale note or none. null unless both kinds exist.
 */
export function noteCostAverages(rows) {
  const ran = rows.filter((r) => !r.cached && !r.carried && typeof r.note === "string" && isNum(r.cost_usd));
  const avg = (rs) => ({ runs: rs.length, average_usd: round(rs.reduce((s, r) => s + r.cost_usd, 0) / rs.length) });
  const fresh = ran.filter((r) => r.note === "fresh");
  const without = ran.filter((r) => r.note !== "fresh");
  if (!fresh.length || !without.length) return null;
  return { fresh: avg(fresh), without: avg(without) };
}

export const STOPPED_LINE = "Stopped early: usage limit reached; re-run the same command later to continue (finished Verdicts are cached).";

/** The one-paragraph plain-text summary printed to stderr. */
export function headline(report, { noRun = false, path } = {}) {
  const c = report.counts;
  const parts = [];
  if (c.not_affected) parts.push(`${c.not_affected} Not affected`);
  if (c.inconclusive) parts.push(`${c.inconclusive} Inconclusive`);
  if (c.reachable_unproven) parts.push(`${c.reachable_unproven} Reachable – unproven`);
  const packages = (report.upgrades ?? []).length;
  let text = `${plural(c.advisories, "Advisory", "Advisories")}`;
  if (c.advisories === 0) text = "No open Advisories for this App.";
  else text += `${parts.length ? `: ${parts.join(", ")}` : ""}, and ${plural(c.upgrade, "Upgrade")}${c.upgrade ? ` across ${plural(packages, "package")}` : ""} to open.`;
  const failed = [];
  if (c.no_match) failed.push(`${c.no_match} not a Match after all`);
  if (c.rejected) failed.push(`${c.rejected} rejected by check`);
  if (c.error) failed.push(`${plural(c.error, "run")} failed or timed out`);
  if (c.limit) failed.push(`${plural(c.limit, "run")} stopped by the usage limit`);
  const notRun = report.rows.filter((r) => r.status === "not_run").length;
  if (notRun) failed.push(`${notRun} not run${noRun ? " (--no-run)" : ""}`);
  if (failed.length) text += ` No Verdict for ${failed.join(", ")}.`;
  if (report.malicious.length) {
    const names = [...new Set(report.malicious.map((m) => `${m.package}@${m.installed.map((e) => e.version).join("/")}`))];
    text += ` ${plural(report.malicious.length, "Malicious package entry", "Malicious package entries")} matched (${names.join(", ")}): never assessed; remove the package now.`;
  }
  const carried = report.rows.filter((r) => r.carried).length;
  const fresh = report.rows.filter((r) => !r.cached && !r.carried && r.status !== "not_run").length;
  text += noRun
    ? ` ${c.cached} cached, ${notRun} would run.`
    : ` ${c.cached} reused from cache, ${fresh} assessed this run${carried ? `, ${carried} carried over from the last report` : ""}, ${money(report.cost_usd_total)}.`;
  const averages = noRun ? null : noteCostAverages(report.rows);
  if (averages) {
    text += ` Average per run: ${money(averages.fresh.average_usd)} with a fresh package note (${plural(averages.fresh.runs, "run")}), ${money(averages.without.average_usd)} without (${plural(averages.without.runs, "run")}).`;
  }
  if (path) text += ` Report: ${path}.`;
  if (report.stopped) text += ` ${STOPPED_LINE}`;
  return text;
}

/** The last report.json's rows by advisory id, for --retry-errors. */
function lastReport(file, cwd) {
  const last = readJson(file);
  if (!last || !Array.isArray(last.rows)) {
    throw new Error(`--retry-errors needs the last report at ${toPosix(relative(cwd, file))}; run agentprime report first`);
  }
  return new Map(last.rows.filter((r) => r && typeof r.advisory_id === "string").map((r) => [r.advisory_id, r]));
}

/** agentprime report [--app p] [--max-turns N] [--max-cost-usd X] [--model M] [--plugin-dir d] [--only id,id] [--retry-errors] [--no-run] [--concurrency N] [--timeout-seconds S] [--retry-backoff-seconds S] */
export async function run(args) {
  const { flags = {} } = args;
  const { cwd, appDir } = resolvePaths(flags);
  configureFetch({ cwd });
  const opts = runOptions(flags, cwd);
  const noRun = flagOn(flags["no-run"]);
  const only = idList(flags.only);
  const file = join(appDir, ".agentprime", "report.json");
  const previous = flagOn(flags["retry-errors"]) ? lastReport(file, cwd) : null;
  const backoffSeconds = positiveNumber(flags, "retry-backoff-seconds", DEFAULT_RETRY_BACKOFF_SECONDS);

  const inventory = readInventory(appDir, { cwd });
  const { advisories, malicious } = splitMalicious(await matchInventory(inventory));
  const warnings = [];
  let selected = advisories;
  if (only) {
    const wanted = (a) => only.some((id) => [a.id, ...(a.aliases ?? [])].some((x) => sameName(x, id)));
    selected = advisories.filter((m) => wanted(m.advisory));
    const unknown = only.filter((id) => !advisories.some((m) => [m.advisory.id, ...(m.advisory.aliases ?? [])].some((x) => sameName(x, id))));
    if (unknown.length) warnings.push(`--only: not a Match for this App: ${unknown.join(", ")}`);
  }

  // --retry-errors runs the rows whose last status was a failure, and Matches the last report didn't have (new
  // Advisories, or a changed lockfile); every other row comes from the cache or, when the cache misses (no_match
  // and rejected rows never cache), is carried over from the last report.
  const retry = previous ? new Set([...previous.values()].filter((r) => RETRY_STATUSES.includes(r.status)).map((r) => r.advisory_id)) : null;
  let stopped = null;
  const skip = (id) => () => {
    if (noRun) return {};
    if (retry && !retry.has(id) && previous.has(id)) return { carry: previous.get(id) };
    if (stopped) return { error: `stopped: ${stopped.reason}` };
    return null;
  };

  const { concurrency, ...runOpts } = opts;
  let done = 0;
  // A package's first run goes before any sibling of it starts, so siblings can start from its usage note.
  const packageKey = (m) => `${m.advisory.ecosystem}\u0000${String(m.advisory.package).toLowerCase()}`;
  const ran = (row) => !row.cached && !row.carried && row.status !== "not_run";
  const rows = await schedulePackages(selected, concurrency, packageKey, async (m) => {
    const row = await assessMatch(m, { appDir, cwd, inventory, skip: skip(m.advisory.id), opts: runOpts, backoffSeconds });
    done++;
    const what = row.status === "verdict" ? row.verdict : row.status;
    progress(`[${done}/${selected.length}] ${row.advisory_id} ${row.package}: ${what}${row.cached ? " (cached)" : ""}${row.carried ? " (carried over)" : ""}${row.error ? ` (${row.error})` : ""}`);
    // After the first usage limit nothing new starts: runs in flight finish, the rest are not_run.
    if (row.status === "limit" && !stopped) {
      stopped = { reason: "usage limit", at: new Date().toISOString(), advisory_id: row.advisory_id };
      progress(`Usage limit reached at ${row.advisory_id}: no new runs will start.`);
    }
    return row;
  }, ran);

  const cost = rows.filter((r) => !r.cached && !r.carried && isNum(r.cost_usd)).reduce((s, r) => s + r.cost_usd, 0);
  const report = {
    app: inventory.app,
    generated_at: new Date().toISOString(),
    counts: reportCounts(rows),
    cost_usd_total: round(cost),
    // The caps every run of this report was given. A row's `turns` is the run's num_turns, which counts more than
    // the model turns --max-turns caps (CONTRACT "Slice 2" step 3), so it can exceed max_turns.
    limits: { max_turns: opts.maxTurns, max_cost_usd: opts.maxCostUsd ?? null },
    malicious: malicious.map((m) => ({
      id: m.advisory.id,
      aliases: m.advisory.aliases ?? [],
      package: m.advisory.package,
      ecosystem: m.advisory.ecosystem,
      installed: m.installed.map(installedEntry),
      summary: m.advisory.summary ?? null,
    })),
    upgrades: groupUpgrades(rows, new Map(selected.map((m) => [m.advisory.id, m.advisory]))),
    rows,
  };
  if (stopped) report.stopped = stopped;
  if (warnings.length) report.warnings = warnings;

  // A --no-run report is a look at the cache; it doesn't replace the last real report.
  if (!noRun) writeJson(file, report);
  progress(headline(report, { noRun, path: noRun ? null : toPosix(relative(cwd, file)) }));
  if (stopped) process.exitCode = 5;
  return report;
}

// ---------------------------------------------------------------- eval

function loadEntries(setDir) {
  let names;
  try {
    names = readdirSync(setDir).filter((n) => n.endsWith(".json")).sort();
  } catch (err) {
    throw new Error(`can't read the labelled set at ${setDir}: ${err.message}`);
  }
  return names.map((file) => {
    let entry;
    try {
      entry = JSON.parse(readFileSync(join(setDir, file), "utf8"));
    } catch (err) {
      return { file, problem: `not valid JSON: ${err.message}` };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { file, problem: "not a JSON object" };
    return { file, entry };
  });
}

/**
 * Where an entry's App is, or why it is unavailable. An `env:` value may start with `~` (a quoted
 * `VAR="~/code/app"` reaches us unexpanded) and, when relative, is relative to the Repository root like every
 * other path eval takes.
 */
function locateApp(entry, appRoot, cwd) {
  const p = entry.app?.path;
  if (typeof p !== "string" || !p) return { problem: "app.path is missing" };
  let dir;
  const env = /^env:(.+)$/.exec(p);
  if (env) {
    const value = process.env[env[1]];
    if (!value) return { problem: `App not available: ${env[1]} is not set` };
    dir = resolve(cwd, /^~(?=$|[\\/])/.test(value) ? homedir() + value.slice(1) : value);
  } else {
    dir = resolve(appRoot, p);
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { problem: `App not available: ${env ? `${env[1]} does not name a directory` : `${p} not found under the app root`}` };
  return { dir };
}

function checkCommit(want, dir) {
  if (want === undefined || want === null) return null;
  let head;
  try {
    head = readHead(dir);
  } catch (err) {
    return `commit ${want} required, but the App's HEAD can't be read (${err.message})`;
  }
  if (!head?.commit) return `commit ${want} required, but the App has no git HEAD`;
  const given = String(want).toLowerCase();
  const ok = given === head.commit || (given.length >= 7 && /^[0-9a-f]+$/.test(given) && head.commit.startsWith(given));
  return ok ? null : `commit mismatch: the entry is for ${want}, the App is at ${head.commit}`;
}

/** The Advisory as it applies to this App: the affected entry the App has installed. */
async function advisoryForApp(entry, inventory) {
  const pkg = typeof entry.package === "string" ? entry.package : undefined;
  if (pkg) return resolveAdvisory(entry.advisory_id, { package: pkg });
  const first = await resolveAdvisory(entry.advisory_id);
  const hit = (first.affected ?? []).find((a) => inventory.packages.some((p) => sameName(p.name, a.package) && p.ecosystem === a.ecosystem));
  if (hit && !(sameName(hit.package, first.package) && hit.ecosystem === first.ecosystem)) {
    return resolveAdvisory(entry.advisory_id, { package: hit.package, ecosystem: hit.ecosystem });
  }
  return first;
}

/**
 * classify(entry, verdict) -> "wrong_not_affected" | "false_positives" | "misses" | "correct"
 * Not affected for a known-affected pair is always wrong, whatever `acceptable` says (PRD §9).
 */
export function classify(entry, verdict) {
  const acceptable = Array.isArray(entry.acceptable) ? entry.acceptable : [entry.known === "affected" ? "reachable_unproven" : "not_affected"];
  if (entry.known === "affected" && verdict === "not_affected") return "wrong_not_affected";
  if (verdict && acceptable.includes(verdict)) return "correct";
  if (entry.known === "not_affected" && verdict === "reachable_unproven") return "false_positives";
  return "misses";
}

async function evalEntry({ file, entry, problem }, { appRoot, cwd: root, fresh, opts, backoffSeconds }) {
  const label = { file, advisory_id: entry?.advisory_id ?? null, app: entry?.app?.name ?? null };
  if (problem) return { bucket: "skipped", item: { ...label, reason: problem } };
  if (typeof entry.advisory_id !== "string" || !SAFE_ID.test(entry.advisory_id)) return { bucket: "skipped", item: { ...label, reason: "advisory_id is missing or not an advisory id" } };
  if (entry.known !== "affected" && entry.known !== "not_affected") return { bucket: "skipped", item: { ...label, reason: `known must be affected or not_affected, not ${JSON.stringify(entry.known)}` } };
  const where = locateApp(entry, appRoot, root);
  if (where.problem) return { bucket: "skipped", item: { ...label, reason: where.problem } };
  const commitProblem = checkCommit(entry.app.commit, where.dir);
  if (commitProblem) return { bucket: "skipped", item: { ...label, reason: commitProblem } };

  // The App's own directory is the Repository root for its run; Verdicts land in its .agentprime/.
  const appDir = where.dir;
  const cwd = appDir;
  const item = { ...label, known: entry.known, verdict: null, status: null, cached: false, cost_usd: null, turns: null, reason: null, why: entry.why ?? null };
  try {
    const inventory = readInventory(appDir, { cwd });
    const advisory = await advisoryForApp(entry, inventory);
    const state = fresh ? { cached: false } : await cacheState(advisory, appDir, cwd, { inventory });
    if (state.cached) {
      Object.assign(item, { verdict: state.verdict.verdict, status: "verdict", cached: true, cost_usd: state.verdict.cost_usd ?? null, turns: state.verdict.turns ?? null, reason: state.verdict.reason ?? null });
    } else {
      const r = await runWithRetry({ advisoryId: advisory.id, cwd, appDir, ...opts }, { backoffSeconds });
      Object.assign(item, { verdict: r.verdict?.verdict ?? null, status: r.status, cost_usd: r.cost_usd, turns: r.turns, reason: r.verdict?.reason ?? r.result ?? null, ...(r.limit ? { limit: r.limit } : {}), ...(r.error ? { error: r.error } : {}) });
    }
  } catch (err) {
    Object.assign(item, { status: "error", error: err.message });
  }
  return { bucket: classify(entry, item.verdict), item };
}

/** agentprime eval [--set dir] [--app-root dir] [--only id,id] [--fresh] [--max-turns N] [--max-cost-usd X] [--model M] [--plugin-dir d] [--concurrency N] [--timeout-seconds S] */
export async function runEval(args) {
  const { flags = {} } = args;
  const { cwd } = resolvePaths(flags);
  configureFetch({ cwd });
  const opts = runOptions(flags, cwd);
  const setDir = str(flags, "set") ? resolve(cwd, flags.set) : join(PLUGIN_DIR, "test", "labelled");
  const appRoot = str(flags, "app-root") ? resolve(cwd, flags["app-root"]) : join(PLUGIN_DIR, "test", "fixtures");
  const fresh = flagOn(flags.fresh);
  const only = idList(flags.only);

  let entries = loadEntries(setDir);
  if (only) entries = entries.filter((e) => e.entry && only.some((id) => sameName(id, e.entry.advisory_id)));

  const { concurrency, ...runOpts } = opts;
  const backoffSeconds = positiveNumber(flags, "retry-backoff-seconds", DEFAULT_RETRY_BACKOFF_SECONDS);
  const results = await mapPool(entries, concurrency, (e) => evalEntry(e, { appRoot, cwd, fresh, opts: runOpts, backoffSeconds }));

  const out = { gate: "pass", wrong_not_affected: [], false_positives: [], misses: [], correct: [], skipped: [], cost_usd_total: 0 };
  let cost = 0;
  for (const { bucket, item } of results) {
    out[bucket].push(item);
    if (!item.cached && isNum(item.cost_usd)) cost += item.cost_usd;
  }
  out.cost_usd_total = round(cost);
  const n = (k) => out[k].length;
  const assessed = n("wrong_not_affected") + n("false_positives") + n("misses") + n("correct");
  if (out.wrong_not_affected.length) {
    out.gate = "fail";
    process.exitCode = 3;
  } else if (assessed === 0) {
    // Zero wrong Not affected out of zero assessed proves nothing: the gate can't pass on nothing.
    out.gate = "empty";
    out.reason = entries.length
      ? `no entry was assessed: all ${plural(entries.length, "entry", "entries")} skipped`
      : only
        ? `no entry was assessed: --only ${only.join(",")} matched no entry in ${toPosix(relative(cwd, setDir)) || "."}`
        : `no entry was assessed: the labelled set at ${toPosix(relative(cwd, setDir)) || "."} is empty`;
    process.exitCode = 4;
  }
  if (out.gate === "empty") {
    const why = out.skipped.map((x) => `${x.file}: ${x.reason}`).join("; ");
    progress(`Gate empty: ${out.reason}${why ? ` (${why})` : ""}.`);
    return out;
  }
  progress(
    `Gate ${out.gate}: ${n("wrong_not_affected")} wrong Not affected, ${n("false_positives")} false positive${n("false_positives") === 1 ? "" : "s"}, ` +
      `${n("misses")} miss${n("misses") === 1 ? "" : "es"}, ${n("correct")} correct, ${n("skipped")} skipped; ${money(out.cost_usd_total)}.`,
  );
  return out;
}
