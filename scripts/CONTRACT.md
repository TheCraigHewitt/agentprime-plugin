# `agentprime` script contract

Read with [docs/slices.md](../docs/slices.md) ("The script" and "Shared output formats") and [ADR-0006](../docs/adr/0006-agents-read-scripts-act.md). This file fixes the module layout and function signatures so the pieces can be built in parallel. Change it only by agreement.

## Rules

- Node 20+, ESM (`.mjs`), **no dependencies**. Global `fetch` only. Tests use `node:test` and `node:assert/strict`.
- The script reports facts and checks Verdicts. It never decides a Verdict and never says Not affected.
- The script never executes customer or package code: no installs, no lifecycle scripts, no `import()`/`require()` of anything inside the App. It reads `node_modules/` never, and `vendor/` only for `check`'s vendor evidence (rule 3b): the cited file under `vendor/laravel/framework/`, `vendor/laravel/nova/` or `vendor/symfony/<name>/`, and `vendor/composer/installed.json`, as text ([ADR-0006](../docs/adr/0006-agents-read-scripts-act.md), amended 2026-10-31). Package metadata comes from registries.
- All commands print one JSON document to stdout. Errors print `{"error": "..."}` to stderr and exit 1. `check` exits 2 when it rejects a Verdict. `report` exits 5 when a usage limit stopped it early (it still prints and writes the report).
- Every command takes `--app <path>` (an App's directory, relative to cwd; default `.`) and `--cwd <path>` (the Repository root; default `process.cwd()`). Paths in output are relative to the App directory, POSIX separators.
- Skip these directories everywhere: `vendor`, `node_modules`, `.git`, `storage`, `bootstrap/cache`, `public/build`, `dist`, `build`, `.agentprime`.
- Network goes through `lib/fetch.mjs` only, so tests can replace it with fixtures.

## Files and owners

| File | Exports | Owner |
|---|---|---|
| `scripts/agentprime.mjs` | CLI entry: parses argv, dispatches to a command, prints JSON | core |
| `scripts/lib/args.mjs` | `parseArgs(argv) -> { command, positional: string[], flags: Record<string, string|true> }` | core |
| `scripts/lib/apps.mjs` | `findApps(cwd) -> App[]` | core |
| `scripts/lib/inventory.mjs` | `readInventory(appDir) -> Inventory` (adds `bundled` to npm entries, from `clientImports`); `parseComposerLock(lockText, composerJsonText) -> Package[]`; `parsePackageLock(lockText) -> Package[]` (both wrap lockfiles.mjs's `composerLockEntries` / `packageLockEntries`, the one implementation) | core |
| `scripts/lib/semver.mjs` | `compare(a, b) -> -1|0|1`; `normalise(v) -> string` (strips `v`, handles Composer `1.2.3.0`); `bumpClass(from, to) -> "patch"|"minor"|"major"` | core |
| `scripts/lib/hash.mjs` | `sha256(text) -> "sha256:<hex>"`; `hashFiles(appDir, relPaths[]) -> "sha256:<hex>"` (sorted, content-based) | core |
| `scripts/lib/fetch.mjs` | `fetchJson(url, { ttlSeconds }) -> any`; `fetchText(url, { ttlSeconds }) -> string`. Cache on disk under `<cwd>/.agentprime/cache/`. If `AGENTPRIME_FIXTURES` is set to a directory, serve `<dir>/manifest.json` entries (`{ "<url>": "<relative file>" }`) and throw on any URL not in it | network |
| `scripts/lib/osv.mjs` | `resolveAdvisory(idOrUrl, { package?, ecosystem? }) -> Advisory` (Packagist and npm only); `matchInventory(inventory, { package? }) -> Match[]`; `normaliseOsv(record, { package?, ecosystem? }) -> Advisory` (every ecosystem `ecosystemName` knows); `rangeContains(advisoryOrAffected, version, package?, ecosystem?) -> boolean` (delegates to match.mjs outside Packagist and npm); `ecosystemName(s) -> "Packagist"\|"npm"\|"PyPI"\|"crates.io"\|"Go"\|"RubyGems"\|"Hex"\|"NuGet"\|"Maven"\|null` (match.mjs's `ecosystemOf`) | network |
| `scripts/lib/lockfiles.mjs` | browser-safe: `detectLockfile(filename, text) -> { format, ecosystem } \| null`; `parseLockfile(filename, text) -> LockfileResult`; `SUPPORTED`; for inventory.mjs `composerLockEntries`, `packageLockEntries`; also `parseYamlSubset`, `parseTomlSubset`, `pep503` | core |
| `scripts/lib/versions.mjs` | browser-safe: `compareVersions(ecosystem, a, b) -> -1\|0\|1`; `isReliable(ecosystem) -> boolean`; `isVersion(ecosystem, v) -> boolean`; `normaliseVersion(ecosystem, v) -> string`; `ECOSYSTEMS` | core |
| `scripts/lib/match.mjs` | browser-safe, the one matcher for POST /v1/match and accounts: `matchPackages(advisories, packages) -> { matches, unsupported }`; `affects(affectedEntry, ecosystem, version) -> boolean`; `rangeContainsFor(ecosystem, affectedEntry, version)`; `ecosystemOf`, `nameKey`, `contractRanges`, `eventsToIntervals`, `fixedVersionsFor`, `formatRanges`, `sortVersions`, `entriesFor`, `isMalicious`, `isWithdrawn` | core |
| `scripts/lib/plan.mjs` | browser-safe: `upgradePlan(matches) -> UpgradePlan` (reads `matchPackages`' output); re-exports `rangeContainsFor` | core |
| `scripts/lib/registry.mjs` | `packagistMetadata(name, version) -> { namespaces: string[], providers: string[], aliases: Record<string,string>, bin: string[], require: Record<string,string>, version: string }`; `npmMetadata(name, version) -> { bin: string[], exports: string[], dependencies: Record<string,string>, version: string }` (`require`, `dependencies` and `version`, the version actually picked, are non-enumerable so `usages`' `metadata` keeps its shape; `dependencies` merges `dependencies` and `optionalDependencies`) | network |
| `scripts/lib/constraint.mjs` | `satisfies(version, constraint, ecosystem) -> boolean` for Composer and npm constraints; pure, throws on a constraint it can't read | check |
| `scripts/lib/usages.mjs` | `findUsages(appDir, { package, ecosystem, version }) -> Usages`; `importsPackage(file, line, name) -> boolean` (the npm import test `usages` applies); `clientImports(appDir, names) -> Set<string>` (the names in `names` that client source imports, by `importsPackage`); `clientRoots(appDir) -> string[]`; `listAppFiles(appDir, { roots? })` | network |
| `scripts/lib/check.mjs` | `checkVerdict(verdict, { appDir, cwd, advisory? }) -> { ok: true, verdict } \| { ok: false, problems: string[] }`; `run(args)` for `check`; `runSave(args)` for `save`; shared with `notes.mjs`: `locateEvidence(appDir, file) -> { abs, rel } \| { problem }`, `lineCount(text)`, `installedEntry(pkg)`, `entryKey(entry)`, `documentInput(flags, source, what)`, `readHead(cwd)`; for vendor evidence and the Verdict cache: `isVendorPackage(name) -> boolean`, `locateVendorFile(appDir, name, file) -> { abs, rel } \| { problem }`, `evidenceHash(appDir, evidence) -> "sha256:<hex>"` | check |
| `scripts/lib/notes.mjs` | `noteState(appDir, { package, ecosystem?, inventory?, cwd? }) -> { fresh: true, note } \| { fresh: false, reason }`; `saveNote(note, { appDir, cwd, ecosystem? }) -> { ok: true, path, saved, stale_reason?, facts, warnings? } \| { ok: false, problems }`; `noteLabel(appDir, options) -> "fresh"\|"stale"\|"none"`; `notePath(appDir, ecosystem, package)`; `run(args)` for `note` | check |
| `skills/does-this-affect-me/SKILL.md`, `agents/reader.md`, `.claude-plugin/plugin.json` | the plugin | plugin |

## Types

```ts
type App = { path: string; lockfiles: string[]; ecosystems: ("Packagist"|"npm")[] };

type Package = {
  ecosystem: "Packagist"|"npm"; name: string; version: string; lockfile: string;
  direct: boolean; dev: boolean; via: string[];   // via: shortest path from a direct dependency down to, not including, this package; [] when direct
  bundled?: boolean;                              // npm only, set by readInventory (parsePackageLock leaves it out); absent on Packagist entries
};
// `dev` means the lockfile marks the package as reachable only through devDependencies (require-dev for Composer).
// It does not mean "not shipped": a Vite or webpack build puts whatever client code imports into the browser
// bundle, devDependency or not. `bundled` is true when the App's client source imports the package by name:
// JS-like files (.js .mjs .cjs .ts .tsx .jsx .vue) under resources/, src/, assets/, app/javascript/, frontend/
// and the directory of every entry a vite.config.* / webpack.config.* / webpack.mix.js names as a quoted relative
// path (read as text, never run), with an import, side-effect import, require(), import() or export-from of
// 'name' or 'name/…' (the same test `usages` applies, `importsPackage`). Only the imported names are marked, not
// their own dependencies (see Known limits).
type Inventory = { app: App; packages: Package[] };

type Advisory = {                       // the "advisory" block of an Advisory profile, plus what analysis needs
  id: string;                           // GHSA id when one exists, else the OSV id
  aliases: string[];
  package: string; ecosystem: "Packagist"|"npm";   // resolveAdvisory; normaliseOsv also gives any ecosystemName (see "osv.mjs beyond Packagist and npm")
  affected_range: string;               // human form, e.g. ">=2.0.0, <2.6.1"
  fixed_versions: string[];
  affected: { package: string; ecosystem: string; ranges: { type?: string; introduced?: string; fixed?: string; last_affected?: string; repo?: string }[]; versions?: string[] }[];
                                        // `type` (and GIT ranges, `repo`) only on entries outside Packagist and npm
  modified: string; published?: string; withdrawn?: string|null;
  summary: string; details?: string; references: { type: string; url: string }[];
  provisional: boolean;
};

type Match = { advisory: Advisory; installed: Package[] };

type Usages = {
  package: string; ecosystem: string; version: string;
  metadata: { namespaces: string[]; providers: string[]; aliases: Record<string,string>; bin: string[] };
  patterns: string[];                   // what was searched for
  locations: { file: string; line: number; pattern: string; text: string }[];  // text: the trimmed line, max 200 chars
  hash: string;                         // sha256 over sorted "file:line:pattern"
};

// Verdict: exactly the JSON in docs/slices.md "Shared output formats". Each `installed` entry is
// { version, lockfile, direct, dev, via } plus `bundled` for an npm entry. `installed`, `action`, `hashes`, `fix_hint`
// are written by the script (check fills or overwrites them); the model writes verdict, reason, evidence.
// `cost_usd` and `turns` are written only by `report`, into the stored Verdict after the run; check drops them.

// One `evidence` entry. The model writes everything but `link`.
type AppEvidence = { file: string; line: number; note: string };   // file relative to the App directory
type VendorEvidence = {                 // ADR-0006, amended 2026-10-31: framework code, read and never run
  package: string;                      // "laravel/framework", "laravel/nova" or "symfony/<name>"
  version: string;                      // the version composer.lock installs, as `inventory` gives it ("11.31.0")
  file: string;                         // relative to vendor/<package>/, e.g. "src/Illuminate/Http/Request.php"
  line: number; note: string;
  link: string|null;                    // check only: https://github.com/<package>/blob/<commit>/<file>#L<line>, or null
};
// An entry with `package` is vendor evidence; one without is App evidence. `link` is written by check, and only
// on vendor evidence: whatever the model wrote there is dropped.
```

## Commands (argv)

- `agentprime apps`
- `agentprime inventory [--app p]`
- `agentprime match [--app p] [--package name]`
- `agentprime advisory <id|url> [--package name] [--ecosystem E]` (`--package` picks which affected package the Advisory block describes; without it, the record's first Packagist/npm entry. The skill always passes the installed package, so the profile's `advisory` block is that package's) and `agentprime advisory --provisional --package name --ecosystem E --affected "<1.2.3" --fixed 1.2.3 --summary "..." [--url u]`
- `agentprime usages <package> [--app p] [--ecosystem E]` (ecosystem inferred from the inventory when omitted; error if ambiguous)
- `agentprime check <verdict.json|-> [--app p] [--advisory <profile.json>]` or `agentprime check --json '<verdict>' [...]` (`-` reads the Verdict from stdin; `--json` takes it as one argument, so the skill needs no `echo`/`cat`/`printf` pipe, which headless runs don't allow; a source and `--json` together, or `--json` with no value, is an error; on success the completed Verdict is also written to `<app>/.agentprime/verdicts/<advisory_id>.json`)
- `agentprime note <package> [--app p] [--ecosystem E]` and `agentprime note save <-|file> [--app p]` (or `--json '<note>'` instead of the source): see [Package usage notes](#package-usage-notes). (`note save` is always the save form, so a package literally named `save` can't be looked up by name.)
- `agentprime save <profile|verdict> -` (or a file path, or `--json '<json>'` instead of either) reads the JSON and writes it to `<app>/.agentprime/profiles/<advisory.id>.json` or, for an unchecked Verdict, `<app>/.agentprime/drafts/<advisory_id>.json` (never `verdicts/`, which holds only Verdicts `check` accepted), printing `{ "path": ... }`. Exists because headless runs have no Write tool (ADR-0006).

## `check` rules (ADR-0005, ADR-0006)

1. Recompute `installed` for the Verdict's package from the inventory; reject if the Verdict's `installed` differs (or fill it when absent). The comparison covers `version`, `lockfile`, `direct`, `dev`, `via` and `bundled` (absent counts as false).
2. Fill `commit` with the Repository's current HEAD (read `.git/HEAD` and the ref, or `packed-refs`; running `git rev-parse HEAD` is acceptable, it is our tool not the App's code). If the Verdict already carries a different `commit`, reject: the working tree is what we can verify. Fill `assessed_at` with the current UTC time if absent.
3. Every App evidence `file` must exist in the App and `line` must be within its line count. No App evidence under `vendor/`, `node_modules/`, `.git/` or `.agentprime/` (agentprime's own output: a package usage note or a stored Verdict is never evidence), and no `.env` or `.env.*` file except `.env.example`. An App evidence path into `vendor/laravel/framework/`, `vendor/laravel/nova/` or `vendor/symfony/<name>/` is rejected like any other, with a pointer to the vendor form.
3b. Vendor evidence (an entry with `package`; ADR-0006, amended 2026-10-31). Rejected, each problem listed, unless all of:
   - `package` is `laravel/framework`, `laravel/nova` or `symfony/<name>` (a Composer package name, any case, stored lowercase). Any other package, installed or not, is rejected.
   - The package is in composer.lock (the inventory), and `version` equals the version it installs, after `normalise` (`v11.31.0` and `11.31.0` are the same; stored as the inventory writes it).
   - `vendor/composer/installed.json` exists, is the App's own (no link out of `vendor/composer/`), lists the package, and gives the same version and, when both name one, the same commit as composer.lock. Otherwise `vendor/` is out of step with the lockfile and its lines are not the installed version's. Composer 2's `{ packages: [...] }` and Composer 1's bare list are both read.
   - `file` is relative to `vendor/<package>/`: not absolute, not starting `vendor/`, no `..` segment, nothing under `.git/`, `node_modules/`, `vendor/` or `.agentprime/`, not `.env` or `.env.*` other than `.env.example`. It exists, is a file, and its real path (every link followed) is inside the App's `vendor/<package>/`, so a linked file, package directory or `vendor/` that leads elsewhere is rejected. `line` is within its line count. `note` is non-empty.
   On success the stored entry is `{ package, version, file, line, note, link }` with the canonical package, version and file. `link` is a permalink to the line in the package's public repository at the commit composer.lock installs: for `laravel/framework` and `symfony/<name>` only, and only when composer.lock's `source.url` is `https://github.com/<package>` (with or without `.git`) and `source.reference` (else `dist.reference`) is a 40-hex commit. A commit rather than a version tag: it is exactly what Composer installed, and a tag can be moved or spelt with or without `v`. Otherwise `link` is null, and for those packages `warnings` says `evidence[i]: composer.lock does not name <package>'s public GitHub repository and an installed commit, so this evidence has no link`. `laravel/nova` is a paid, private package: `link` is always null and there is no warning. The web app shows Nova evidence as package, version, `file:line` and our note, with no code and no link; the App's owners open the line in their own copy. When composer.json's `extra.patches` names the package, or `extra.patches-file` is set (composer-patches), `warnings` says the copy read may differ from the released code the link shows.
4. For `not_affected`: at least one evidence entry (App or vendor evidence both count), and every file that `usages` returned for the package must appear in App evidence; vendor evidence never covers an App file. "Never called" is a claim about the whole App.
4b. For `not_affected`: when the reason relies on the package being dev-only or build tooling (it matches `dev-only`/`dev only`, `devDependenc`, `build tool`/`build-tool`, `build-time`/`build time`, any case) and any installed entry has `bundled: true`, reject, naming the client-source files `usages` found: the package is imported from client source, so the browser build ships it whatever package.json says. Only `not_affected` is checked: an `inconclusive` or `reachable_unproven` reason may mention devDependencies without clearing the package.
5. For `reachable_unproven`: at least two evidence entries (entry point and vulnerable call), at least one of them App evidence: framework code alone is not a path through this App.
6. Compute `action`: `reachable_unproven` → `upgrade`; `inconclusive` → `upgrade` only if some installed entry is `direct` and `bumpClass(installed, lowest fixed > installed)` is patch or minor; otherwise `none`.
7. Compute `fix_hint` from `installed` and the Advisory's `fixed_versions` (needs the Advisory: pass `--advisory <profile.json>` or resolve by id). For a transitive entry, read the immediate parent's (`via[via.length-1]`) constraint on the package from the registry at the parent's installed version: if it allows the fixed version, the hint is `` Run `composer update <pkg>` `` (or `npm update`) with the parent and constraint named; otherwise it says to upgrade the parent or add an override and names the blocking constraint. If the lookup fails, the hint names `via[0]` unchecked and `warnings` says so.
   When an entry is transitive (`direct: false`) but `via` is empty (the lockfile didn't say how it is pulled in), there is no parent to check: the hint keeps the direct wording (`Upgrade <pkg> to <v> (<class> release)`) and `warnings` gets `fix_hint: could not resolve how <pkg> is pulled in; the hint assumes it is updated directly`.
8. Compute `hashes.usages` (from `findUsages`) and `hashes.evidence` (`evidenceHash` over the stored evidence: with App evidence only, exactly `hashFiles` over the distinct evidence files; with vendor evidence, a sha256 over that and, per vendor entry, the package, the version and commit composer.lock installs now, the file and the file's content, so an upgrade or a changed `vendor/` copy changes it); `hashes.profile` if `.agentprime/profile.json` exists, else omit.
9. Drop `cost_usd` and `turns` if the model wrote them (only `report` sets them, after a run, from the run's own result), with the warning `dropped cost_usd and turns: only agentprime report writes them, after a run` (naming whichever were present).
10. Output the completed Verdict on success.

## Notes from building the plugin

- Permission allow rules: `Bash(agentprime:*)` does not match `node …/agentprime.mjs`. A plugin `bin/` folder would put it on PATH but blocks installation on claude.ai and Cowork, so it is not used. Headless runs allow the script by its absolute path instead, with the prefix rule `Bash(node <absolute plugin dir>/scripts/agentprime.mjs:*)`: the text before `:*` is a literal prefix of the command, so the skill must invoke the script unquoted as `node ${CLAUDE_PLUGIN_ROOT}/scripts/agentprime.mjs …`, and the plugin path must not contain whitespace (`report` refuses such a `--plugin-dir`).
- Verified live on Claude Code 2.1.314 (`/opt/node22/bin/claude`), 2026-10-30, from `test/fixtures/app`, `claude -p … --max-turns 3 --output-format json` (these runs predate the WebFetch domain rules below; their disallow list still had `WebFetch`):
  - `--allowedTools "Read,Grep,Glob,Agent,Task,Bash(node /home/user/agentprime/scripts/agentprime.mjs:*)" --disallowedTools "Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Bash(node -e:*)"` with the prompt to run `node /home/user/agentprime/scripts/agentprime.mjs apps`: the command ran (`permission_denials: []`, `num_turns: 2`) and the result held both Apps (`.` and `nested`). The disallow list, with a space inside `Bash(node -e:*)`, parsed without breaking the allow list.
  - `--allowedTools "Bash(node /home/user/agentprime/scripts/agentprime.mjs:*)"` with the prompt to run `node -e "console.log(1)"`: denied (`permission_denials: [{ tool_name: "Bash", tool_input: { command: "node -e \"console.log(1)\"" } }]`); the prefix rule alone does not match other `node` commands. `report` also lists `Bash(node -e:*)` in `--disallowedTools` as a second line of defence (that combination was not run separately).
  - Not verified live: a `--json '<one-line JSON>'` argument through the allow rule, and whether Claude Code accepts a shell redirect after the allowed prefix (`node <d>/scripts/agentprime.mjs apps > .agentprime/verdicts/<id>.json`). Such a file would hold the script's own output, not a Verdict the model chose, but `runHeadless` would still read it as the run's Verdict file.
- WebFetch by domain, verified live on Claude Code 2.1.314, 2026-10-30, from `test/fixtures/app`, `claude -p "<fetch https://github.com/thephpleague/commonmark/releases, then https://example.com>" --output-format json --verbose --max-turns 4 --plugin-dir <d> --allowedTools "Read,Grep,Glob,Agent,Task,WebFetch(domain:github.com),WebFetch(domain:osv.dev),WebFetch(domain:api.osv.dev),Bash(node <d>/scripts/agentprime.mjs:*)" --disallowedTools "Write,Edit,MultiEdit,NotebookEdit,WebSearch,Bash(node -e:*)"`: the model called WebFetch for both URLs in one response. The github.com fetch was permitted and ran (in this sandbox the network answered HTTP 403, which `curl` gets too, so no page content came back; that is the network, not the permission). The example.com fetch was refused by permissions: `permission_denials: [{ tool_name: "WebFetch", tool_use_id: "…", tool_input: { url: "https://example.com", prompt: "What is the page title?" } }]`, tool result "Claude requested permissions to use WebFetch, but you haven't granted it yet." So the rule form is `WebFetch(domain:<host>)`, an exact host (github.com does not cover api.github.com or raw.githubusercontent.com), and a domain nothing allows is denied in a headless run. A blanket `WebFetch` in `--disallowedTools` must not be kept: deny rules beat allow rules. WebFetch is a deferred tool, and the model loaded it with ToolSearch first, which needed no allow rule.
- `--max-turns` and `num_turns`, read from the 2.1.314 binary and confirmed by the WebFetch run above: `--max-turns` (hidden from `--help` but accepted, value as a separate argument) caps the main conversation's agentic turns, one per model response. The result's `num_turns` counts the user-role messages of the main conversation instead: the prompt and each tool result separately, so one response with two parallel tool calls adds two. The run above had 3 model responses (ToolSearch; two WebFetch calls in parallel; the answer) and reported `num_turns: 4` under `--max-turns 4` without stopping. A skill run adds the slash command's expanded messages, and the skill's parallel Read/Grep/script calls each add one, so `num_turns` well above the cap (46 under `--max-turns 25` in the first live report) is expected and is not the cap failing. Subagents are not capped by `--max-turns` at all: a subagent's turn limit is the `maxTurns` of its own definition (`agents/reader.md` sets 20). `--max-budget-usd <amount>` exists (print mode only) and does count subagents' spend; Claude Code checks it after each response against its own estimate, so a run can pass it by about one response.
- `advisory --provisional` returns `id` of the form `PROV-<12 hex>`; the skill uses whatever `id` comes back.
- The `reader` subagent may be unreachable in headless runs whose tool allowlist excludes subagents; the skill then reads under the same rules itself.

## Slice 2: `report`, `eval` and the labelled set

### `agentprime report [--app p] [--max-turns N] [--max-cost-usd X] [--model M] [--plugin-dir d] [--only id,id] [--retry-errors] [--no-run] [--concurrency N] [--timeout-seconds S] [--retry-backoff-seconds S]`

Owner: report. File: `scripts/lib/report.mjs` (`run(args)`, `runHeadless({ advisoryId, cwd, appDir, pluginDir, maxTurns, model, maxCostUsd, timeoutSeconds }) -> { verdict?, cost_usd, turns, status, limit?, error?, cli_subtype?, exit_code?, check_problems?, transient? }`, `runWithRetry(options, { backoffSeconds }) -> the same, plus retries?`, `limitKind(text) -> "usage_limit"|"overloaded"|null`, `groupUpgrades(rows, advisoriesById) -> Upgrade[]`, `schedulePackages(items, n, keyOf, fn, ranOf) -> results`, `noteCostAverages(rows) -> { fresh, without } | null`, `isCached(advisory, appDir, cwd) -> boolean`, `allowedTools(pluginDir) -> string`, `DISALLOWED_TOOLS`, `WEBFETCH_DOMAINS`, `profileRange(profileAdvisoryBlock, package, ecosystem) -> { affected_range, fixed_versions }`).

1. `match` for the App. Malicious package entries are listed separately, never assessed.
2. For each Match, reuse the Verdict at `<app>/.agentprime/verdicts/<id>.json` when all of: the profile at `<app>/.agentprime/profiles/<id>.json` exists and its range for the Match's package equals the Match's `affected_range` and `fixed_versions` (a Match describes the installed package; when the profile's `advisory.affected` has entries for that package and ecosystem, the range is derived from them, `affected_range` by `formatAffectedRange` and `fixed_versions` as the sorted distinct `fixed` of their ranges, the way `normaliseOsv` derives the block's; otherwise the block's own `affected_range` and `fixed_versions`. The skill saves the block from `advisory <id> --package <installed package>`, so normally both agree); the Verdict's `installed` equals the inventory's entries for the package; `hashes.usages` equals a fresh `findUsages` hash; `hashes.evidence` equals a fresh `evidenceHash` over the stored evidence (check rule 8); `hashes.profile`, if present, equals the current App profile hash. Otherwise run it.
3. A run is one headless Claude Code process, started from the Repository root: `claude -p "/agentprime:does-this-affect-me <id> --app <path>" --output-format json --max-turns <N> --plugin-dir <d> --allowedTools "Read,Grep,Glob,Agent,Task,WebFetch(domain:github.com),WebFetch(domain:osv.dev),WebFetch(domain:api.osv.dev),Bash(node <d>/scripts/agentprime.mjs:*)" --disallowedTools "Write,Edit,MultiEdit,NotebookEdit,WebSearch,Bash(node -e:*)"` plus `--max-budget-usd <X>` when `--max-cost-usd` is given (default: none) and `--model <M>` when given. `--max-turns` defaults to 25. WebFetch is allowed only for those three hosts, so stage 1 can read an Advisory's fix commit and advisory page; any other host is denied (see the notes above), and WebSearch stays denied. (ADR-0006 says the central workers fetch nothing; this narrower allowance is for `report` runs and has not been carried into the ADR.) The prompt always ends ` --app <path>`, the App's path relative to the Repository root (`.` for the root), whatever the number of Apps. `--plugin-dir` defaults to the directory containing `scripts/agentprime.mjs`; `<d>` is it resolved to an absolute path (relative to `--cwd`), and one containing whitespace is an error before any run. Bash is allowed only for the agentprime script (ADR-0006): no `echo`, `cat`, `printf` or other `node`, so a steered model cannot write `.agentprime/verdicts/<id>.json` itself, and `report` only trusts a Verdict file `check` wrote. The binary is `process.env.AGENTPRIME_CLAUDE ?? "claude"` so tests can substitute a fake. Parse the JSON result for `total_cost_usd`, `num_turns`, `is_error`, `subtype`, `result`. After the run, if `check` wrote the Verdict file, add `cost_usd` and `turns` to it. `turns` is `num_turns` as Claude Code reports it: the main conversation's user-role messages (the prompt, the skill's expansion and one per tool result, parallel calls each counted), not the model turns `--max-turns` caps, and not subagents' turns, so it can exceed `--max-turns` without the cap failing. A result with `subtype` `error_max_turns` or `error_max_budget_usd` and no Verdict file is status `error` with `limit: "max_turns"` or `"max_cost_usd"` and an error naming the cap. Status is `verdict`, `no_match` (the skill stopped because the version is outside the range), `rejected` (no Verdict file; check refused the Verdict), `limit` (the account's usage or rate limit refused the run), `error` or `timeout`. `--concurrency` defaults to 1.
   - **Scheduling by package.** Advisories run in the deterministic `match` order, except that a package's first run goes before any sibling of that package starts (`schedulePackages(items, n, keyOf, fn, ranOf)`): with `--concurrency N` the first wave is one Advisory per distinct package (ecosystem and name), and a sibling becomes eligible once its package's first run has finished, whatever its outcome, so it can start from the [package usage note](#package-usage-notes) that run saved. An Advisory that does not run (cached, `not_run`, carried) does not count as the package's first run; the next one of the package takes that place. Within a package the order is the existing one. With `--concurrency 1` nothing changes.
   - **What counts as a limit.** Only what the CLI said is read, never the model's answer (which can discuss an Advisory about rate limiting): the `result` text when `is_error` is true or the run cost $0 (no model call was made, so no model wrote it), and stderr when the run failed (`is_error`, a non-zero exit, or no JSON). Matched case-insensitively: `usage limit`, `rate limit`/`rate_limit`, `limit reached`, `hit your`, `reached your … limit`, `quota`, `429`, `out of usage`/`out of extra usage`, `credit balance is too low`, `spend limit` → status `limit`; otherwise `overloaded` or `529` → transient. The `--max-turns`/`--max-cost-usd` caps (`error_max_turns`, `error_max_budget_usd`) are checked first and stay `error` with `limit: "max_turns"|"max_cost_usd"`. The wording, read from the Claude Code 2.1.314 binary (`strings`, no model call): a refused request is "You've hit your <limit> · resets <time>" where <limit> is "5-hour limit", "weekly limit", "Opus limit", "Sonnet limit", "usage limit", "usage credit limit", "monthly spend limit", "team's shared budget" and similar, or "You've reached your …", "You're out of usage credits", "You're out of extra usage", "Your org is out of usage"; an API key without credit gives "Credit balance is too low"; the API's own errors are `rate_limit_error` (429) and `overloaded_error` (529, reported as "Repeated 529 Overloaded errors" after the CLI's own retries); older releases printed "Claude AI usage limit reached|<epoch>". Whether `-p` reports a refused request with `is_error: true` was not verified live (that would need an account at its limit); the $0 rule covers either.
   - **Stopping.** After the first `limit` row nothing new starts: runs already in flight finish, and every Advisory whose run has not started is reported from the cache when its Verdict is cached, otherwise as `not_run` with `error: "stopped: usage limit"`. report.json gets `stopped: { reason: "usage limit", at: <ISO time>, advisory_id: <the first limit row> }`, the headline ends "Stopped early: usage limit reached; re-run the same command later to continue (finished Verdicts are cached).", and the process exits 5. A transient (overloaded) result gets one retry after `--retry-backoff-seconds` (default 30); a second one is `error`, and the row gets `retries: 1`. `eval` retries the same way but does not stop.
   - **Diagnostics, never model prose (ADR-0006).** An `error` or `limit` row carries `cli_subtype` (the result's `subtype`, or null) and `exit_code` (or null), and its `error` is script text plus, when `is_error` is true, the CLI's error text cut to 300 characters. A non-error result's `result` is the model's answer and is never stored. For `rejected`, check is the source of truth: when a run ends without a Verdict and the skill saved a draft at `<app>/.agentprime/drafts/<id>.json` during the run (the skill does after its third rejected attempt; an older, unchanged draft is ignored), `report` runs `checkVerdict` on it in-process (with the saved profile for a `PROV-` id) and stores its `problems` on the row as `check_problems` (at most 20, each cut to 300 characters; a draft that is not JSON gets one problem saying so, without the parser's message, which quotes the draft). A failing draft makes the row `rejected` whatever the final message says, unless the run hit a cap or a limit or failed, in which case `check_problems` rides on that row.
4. `--no-run` reports cache state only. `--only` restricts to the listed ids. `--retry-errors` reads the last `<app>/.agentprime/report.json` (an error if there is none) and runs only the Advisories whose row there had status `error`, `limit`, `timeout` or `not_run`; every other Advisory comes from the cache, or, when the cache misses (a `no_match` or `rejected` row, or a Verdict whose inputs changed), its last row is carried over with `carried: true` (not counted in `cost_usd_total`); a Match the last report did not have is `not_run` with an error saying so. It combines with `--only` and `--no-run`.
5. Write `<app>/.agentprime/report.json`: `{ app, generated_at, counts: { advisories, not_affected, reachable_unproven, inconclusive, no_match, rejected, error, limit, not_run, cached, upgrade }, cost_usd_total, limits: { max_turns, max_cost_usd }, malicious: [...], upgrades: [...], rows: [ { advisory_id, package, installed, verdict, action, reason, cost_usd, turns, cached, status, note?, limit?, error?, cli_subtype?, exit_code?, check_problems?, retries?, cache_miss?, carried? } ], stopped?, warnings? }` (`max_cost_usd` is null when no cap was given; `counts.error` includes timeouts) and print it. Also print a one-paragraph plain-text summary to stderr ("31 Advisories: 27 Not affected, …, and 4 Upgrades across 3 packages to open. …, $4.12") so a human running it sees the headline. `note` is on every row whose run started: `"fresh"`, `"stale"` or `"none"`, the package usage note as `agentprime note` judged it at the moment the run started (`noteLabel`; a note that can't be judged, because the registry lookup failed, is `"stale"`). Cached, `not_run` and carried rows have none of their own. When the rows include runs that started with a fresh note and runs that started without one (stale or none), the headline adds "Average per run: $X with a fresh package note (n runs), $Y without (m runs)." (`noteCostAverages(rows)`, over runs with a cost, never cached or carried rows).
6. `upgrades` groups the Upgrades by package, for the PR body and slice 6: one entry per package (and ecosystem) with at least one row with `action: "upgrade"`, sorted by package; packages with no Upgrade row are not listed.

   ```ts
   type Upgrade = {
     package: string; ecosystem: "Packagist"|"npm";
     installed: string[];               // distinct installed versions across the package's rows, ascending
     to: string|null;                   // one version that clears every Advisory below except `unfixed`
     bump: "patch"|"minor"|"major"|null; // the largest bumpClass(installed[i], to)
     direct: boolean;                   // any installed entry is direct
     advisories: string[];              // every matched Advisory of the package in this report, in row order (Not affected ones too)
     unfixed: string[];                 // those with no fixed version above an installed version: `to` does not clear them
     verdicts: { reachable_unproven: number; inconclusive: number };  // among those rows
   };
   ```

   `to` covers all of the package's matched Advisories in the report, not only the Upgrade rows, so one PR clears the whole set: for each Advisory and installed version the lowest fixed version above it that the Advisory itself does not affect (`lowestFix`, as `fix_hint` uses); the highest of those; then, while that version is inside some Advisory's affected range (a fix on a later branch only), the lowest fix of that Advisory above it (`semver.mjs` and `rangeContains`, from the Advisories' `fixed_versions` and `affected`). `to` and `bump` are null when every Advisory is unfixed. `to` is not checked against the registry here; the Upgrade (slice 6) does that.

### Labelled set and `agentprime eval [--set <dir>] [--app-root <dir>] [--only id] [--max-turns N] [--max-cost-usd X] [--model M]`

Owner: report (the runner), labelled (the entries and fixtures). Entries live in `test/labelled/*.json`, one file per pair:

```json
{
  "advisory_id": "GHSA-29pj-957v-52mc",
  "app": { "name": "private-app", "path": "env:PRIVATE_APP", "commit": null, "private": true },
  "known": "not_affected",
  "acceptable": ["not_affected", "inconclusive"],
  "why": "<why the answer is known, with file:line references>",
  "source": "<who knows the answer, and how>",
  "added": "2026-10-30"
}
```

- `known` is the ground truth: `affected` or `not_affected`. `acceptable` lists the Verdicts that count as correct. For `known: affected` the expected Verdict is `reachable_unproven` (no Sandbox yet); `inconclusive` is a miss, not a failure; `not_affected` is a **wrong Not affected** and fails the gate. For `known: not_affected`, `reachable_unproven` is a false positive, counted separately.
- `app.path` is relative to `--app-root` (default `test/fixtures`), or `env:<VAR>` for a private App whose location comes from an environment variable; entries whose App is unavailable are skipped and listed as such. `commit`, when set, must equal the App's HEAD or the entry is skipped with a reason.
- `eval` runs `runHeadless` per entry (reusing cached Verdicts the same way `report` does unless `--fresh`), compares, and prints `{ gate: "pass"|"fail"|"empty", wrong_not_affected: [...], false_positives: [...], misses: [...], correct: [...], skipped: [...], cost_usd_total }`, plus `reason` when the gate is `empty`. Exit 3 when the gate fails, exit 4 when it is empty. PRD §9 is the gate: zero wrong Not affected.
- The gate cannot pass on nothing. When no entry was assessed (every entry skipped, `--only` matched no entry, or the set is empty), `gate` is `"empty"`, `reason` says which (`no entry was assessed: all N entries skipped`, `… --only <ids> matched no entry in <set>`, `… the labelled set at <set> is empty`), `skipped` keeps each entry's reason, the stderr line lists them, and the exit code is 4. An entry counts as assessed when it lands in `wrong_not_affected`, `false_positives`, `misses` or `correct` (a run that ended without a Verdict is a miss). Exit 3 stays for a wrong Not affected, which needs an assessed entry, so the two never meet.
- An entry with `known: "not_affected"` must not list `reachable_unproven` in `acceptable` (test/check.test.mjs checks every entry): it would count a false positive as correct.

## Package usage notes

The first step of the App profile (slice 5). Owner: check. File: `scripts/lib/notes.mjs`. A note records how the App uses one package, so a later Assessment of another Advisory for the same package starts from facts an earlier run gathered instead of rediscovering them (the first live report had 32 axios and 20 dompurify Advisories against one install each). A note is a map of where to look, never evidence: the skill re-reads every cited line before relying on it, the Verdict still cites the code's file:line, and `check` validates every Verdict on its own, note or not.

Stored at `<app>/.agentprime/notes/<ecosystem>/<package with / replaced by __>.json` (`league/commonmark` → `notes/Packagist/league__commonmark.json`, `@scope/name` → `notes/npm/@scope__name.json`):

```ts
type Note = {
  package: string; ecosystem: "Packagist"|"npm";
  installed: { version, lockfile, direct, dev, via, bundled? }[]; // script: the inventory's entries, as check writes them
  commit: string|null;                 // script: readHead at save
  usages_hash: string;                 // script: findUsages(usageTarget(...)).hash at save
  facts: { file: string|null; line: number|null; kind: "entry_point"|"call"|"config"|"wiring"|"absence"; note: string }[];
  summary: string;                     // model: at most 800 characters
  written_at: string;                  // script: ISO time of the save
  from_advisories: string[];           // model: the Advisories whose runs confirmed these facts; unioned on merge
};
```

- `kind`: `entry_point` (where untrusted input enters), `call` (where the App calls the package), `config` (configuration or options that matter), `wiring` (a provider, facade or framework path that pulls the package in, or the manifest that declares it), `absence` (something is not done: cite the place it would be configured, if anywhere; an absence that rests on the `usages` search alone has `file` and `line` null, and `usages_hash` pins that search).
- `note` is our paraphrase, at most 300 characters, never quoted code. Never secrets or `.env` content.

### `agentprime note <package> [--app p] [--ecosystem E]`

Prints `{ fresh: true, note }` when a note exists and is fresh, `{ fresh: false, reason }` when it exists but is stale, and `{ fresh: false, reason: "none" }` when there is none. The package and ecosystem are resolved as `usages` resolves them (`usageTarget`). Fresh means all of, checked in this order (the first failure is the reason):

1. the note is for this package and ecosystem, and the package is still installed;
2. `installed` equals the inventory's entries for the package, the comparison `check` uses (`version`, `lockfile`, `direct`, `dev`, `via`, `bundled`, as a set) → otherwise `installed changed`;
3. every fact with a file names a file that still exists in the App (under the evidence rules) with `line` within its line count → otherwise `a cited file … does not exist in the App` or `line N of <file> is past its end (M lines)`;
4. `usages_hash` equals a fresh `findUsages` hash for the package → otherwise `usages changed`.

A note that is not valid JSON is stale (`the stored note is not valid JSON`). Stale notes are never deleted, only reported stale.

### `agentprime note save <-|file> | --json '<note>' [--app p] [--ecosystem E]`

Reads the note the way `check` and `save` read theirs (`--json` takes it as one argument; a source and `--json` together is an error). The model writes `package` (and `ecosystem` when the name is in both lockfiles), `facts`, `summary` and `from_advisories`; the script fills `installed`, `usages_hash`, `commit` and `written_at`, ignoring (with a warning) whatever the model wrote there, and drops unknown fields with a warning. Rejected, exit 2 with `{ ok: false, problems }` on stdout listing every problem at once, when: the package is not installed or is not a package name; `facts` is not a list or has more than 60 entries; a fact's file is missing, absolute, outside the App, under `vendor/`, `node_modules/`, `.git/` or `.agentprime/`, or is `.env` / `.env.*` other than `.env.example` (the evidence rules, `locateEvidence`); a line is not an integer within the file's line count; `kind` is not one of the five; a fact `note` is empty or over 300 characters; `summary` is empty or over 800 characters; `from_advisories` is not a list of advisory ids. Facts are de-duplicated by file+line+kind (a later one wins) and stored sorted by file, line and kind.

When a fresh note already exists, `save` merges: the union of facts keyed by file+line+kind (an absence without a file is keyed by its words), the new note text winning; `from_advisories` unioned; `summary` replaced. If the merged note would pass 60 facts, the new facts are kept first, then the older ones in order up to 60, and a warning says how many were dropped. A stale existing note is replaced. Prints `{ path, saved: "created"|"merged"|"replaced", stale_reason?, facts: <count>, warnings? }`; the file is written whole (a temp file renamed into place).

Notes are never published, never sent anywhere, and never leave the App's `.agentprime/`. `usages`, `check`'s hashes and the inventory never read `.agentprime/`, so a note changes no other input of a Verdict.

## Lockfiles, versions and upgrade plans (browser-safe)

Owner: core. Files: `scripts/lib/lockfiles.mjs`, `scripts/lib/versions.mjs`, `scripts/lib/match.mjs`, `scripts/lib/plan.mjs`. They serve the public site's "check your lockfile" (parsed in the visitor's browser, so only names and versions leave it), the service's POST /v1/match, and accounts' monitoring of a saved inventory. All four are pure ESM with no `node:` imports, no fs, no network, no globals (`process`, `Buffer`) and no dependencies; they import only each other and `semver.mjs`, so they run unchanged in a browser, Node and a Cloudflare Worker. `test/lockfiles.test.mjs` follows their imports transitively and fails on anything else. Nothing from a lockfile is ever executed. Where a parser is unsure it says so in `warnings` and leaves the entry out rather than guess; text it can't read is rejected with an Error naming the format and line, never half-parsed.

### `lockfiles.mjs`

```ts
detectLockfile(filename: string, text: string): { format: Format; ecosystem: OsvEcosystem } | null;
parseLockfile(filename: string, text: string): LockfileResult;   // throws on an unsupported or unreadable file
const SUPPORTED: { format: Format; ecosystem: OsvEcosystem; files: string[]; variants: string[]; records: ("direct"|"dev"|"via")[] }[];

type OsvEcosystem = "Packagist"|"npm"|"PyPI"|"crates.io"|"Go"|"RubyGems"|"Hex"|"NuGet"|"Maven";
type Format = "composer.lock"|"package-lock.json"|"npm-shrinkwrap.json"|"pnpm-lock.yaml"|"yarn.lock"|"bun.lock"
  |"requirements.txt"|"poetry.lock"|"uv.lock"|"Pipfile.lock"|"Cargo.lock"|"go.sum"|"go.mod"|"Gemfile.lock"|"mix.lock"
  |"packages.lock.json"|"gradle.lockfile";
type LockfileResult = {
  format: Format; ecosystem: OsvEcosystem;
  packages: { name: string; version: string; direct?: boolean; dev?: boolean; via?: string[] }[];
  warnings: string[];                 // human sentences, de-duplicated, in the order found
};
```

- **Detection.** By file name first, in any directory (`/` or `\`), ignoring a browser's ` (1)` suffix: the names in `SUPPORTED[].files`, plus `gems.locked`, `packages.<project>.lock.json`, `*-gradle.lockfile`, `*requirements*.txt`, `requirements/*.txt`, `constraints.txt`, and any `*.lockfile` whose text holds a `group:artifact:version` line. When the name says nothing, by content (JSON keys, the Yarn and Cargo/Poetry header comments, `lockfileVersion:`, `[[package]]`, `GEM`/`DEPENDENCIES`, `%{`, `module`, go.sum's line shape, Gradle's header). requirements.txt can't be told by content. `bun.lockb` is null; `parseLockfile` then says to write `bun.lock` (and names the lockfile to use instead of `package.json`, `composer.json`, `Pipfile`, `pyproject.toml`, `Cargo.toml`, `Gemfile`, `mix.exs`).
- **Packages.** One entry per distinct name and version, sorted by name (code-unit order) then version (`compareVersions`; code-unit order for Maven). Copies of one name and version are merged: `direct` if any copy is, `dev` only if every copy is, `via` from the best copy (direct, then not dev, then the shortest path). `direct`, `dev` and `via` appear only where the format records them (below) and are never guessed; `via` is the names from a direct dependency down to, not including, the package (`[]` when direct).
- **Names, as OSV expects.** npm as written (scoped names kept, an alias listed under the real package name). Packagist lowercased. PyPI by PEP 503 (lowercase, each run of `-`, `_`, `.` becomes `-`). Maven `group:artifact`. Go the module path as written. crates.io, RubyGems, Hex and NuGet as written.
- **Versions** as the lockfile writes them, except: Packagist through `semver.mjs` `normalise` (`v2.4.1.0` → `2.4.1`); Go always with the `v` prefix (go.sum's form). OSV's Go records write versions without the `v`; `compareVersions("Go", …)` and `normaliseVersion` read both alike. That osv.dev's query API accepts the `v` form is from memory, not verified here.

| Format | Reads | `direct` / `dev` / `via` | Listed with a warning, or left out with one |
|---|---|---|---|
| composer.lock | `packages`, `packages-dev` | `dev` (packages-dev) | branch versions (`dev-*`, `*-dev`) and `path` repositories: left out |
| package-lock.json, npm-shrinkwrap.json v2, v3 | `packages` (the same code as `inventory`) | all three, by Node's resolution from the root and workspace members | git, `file:` tarballs and tarball URLs (by `resolved`), links to directories outside the project: left out. Workspace links and members are the App's own code: left out silently |
| package-lock.json v1 | the `dependencies` tree, nested copies too | `dev` | git, `file:` and URL versions: left out. `npm:` aliases read as the real package |
| pnpm-lock.yaml 5.x, 6.x, 9.x | `importers` (or the top-level importer), `packages`, v9 `snapshots`; a leading `---` document (pnpm's env lockfile) is skipped | `direct` from the importers; `dev` from v5/v6's `dev:` field (absent means both, so not dev), and in v9 from reachability from the importers' `dependencies` and `optionalDependencies`; `via` by shortest path | keys whose version is not a semver (git, tarball, `file:`): left out. `link:` references are workspace members. A reference to a package entry that is not there: `via` (and in v9 `dev`) left out for the whole file, with a warning |
| yarn.lock v1 | every entry; multi-specifier keys; `npm:` aliases as the real name | none (the lockfile does not record them) | specifiers that are git, GitHub shorthand, `file:`/`link:` or URLs: left out |
| yarn.lock Berry (`__metadata`) | `resolution` of every entry | none | `workspace:` skipped silently; `patch:` listed by the npm version it patches (a warning unless it is Yarn's builtin compat patch); git, `https:`, `file:`, `link:`, `portal:`, `exec:`: left out |
| bun.lock (JSONC, lockfileVersion 0, 1) | `packages`, `workspaces` | `direct` from the workspaces (a member's dependency by its `<member>/<dep>` key when not hoisted); `dev` on direct entries only (declared only in devDependencies) | `workspace:` skipped silently; git, GitHub, `file:`, `link:`, tarball URLs: left out |
| requirements.txt | exact `==` and `===` pins only, extras dropped, `--hash` and other per-requirement options and `\` continuations handled, `#` comments | none | every other line is a warning naming its number: `-r`/`-c` includes (not read: the browser has only the one file), `-e`, URL, VCS and path requirements, unpinned or ranged (`>=`, `~=`, `==1.2.*`) requirements, unknown options; extra clauses beside an exact pin (`==6.0.1,!=6.0.0`) are listed with a warning. Requirements with environment markers are listed, with one warning that they install only where the marker holds. Index options are ignored silently |
| poetry.lock (lock-version 1.x, 2.x) | `[[package]]` | `dev` from `category` (1.x) or `groups` without `main` (2.x); absent otherwise | `git`, `directory`, `file`, `url` sources: left out. `legacy` (an explicit index) sources: listed, with a warning that the name may not be the PyPI package |
| uv.lock (version 1) | `[[package]]` with a `registry` source | `direct` from the project's and workspace members' (editable or virtual sources) `dependencies`, `optional-dependencies` and `dev-dependencies` | `git`, `url`, `path`, `directory` sources: left out. The project and workspace members: skipped silently |
| Pipfile.lock | `default`, `develop` | `dev` (only in develop) | entries without an exact version (git, path, file, editable): left out |
| Cargo.lock (v1 to v4) | `[[package]]` from crates.io (`registry+https://github.com/rust-lang/crates.io-index` or `sparse+https://index.crates.io/`) | none | git sources and other registries: left out. Crates with no source (workspace members, path dependencies): skipped silently |
| go.sum | module/version pairs whose version is not `…/go.mod` | none | a module with more than one listed version (stale entries, or versions the module graph needed): all listed, with a warning that the build uses one |
| go.mod | `require` lines and blocks; `replace` | `direct` from `// indirect` | a replacement by another module: listed as the replacement, with a warning; by a local directory: left out. `go` older than 1.17 or missing: a warning that go.mod lists only some modules |
| Gemfile.lock, gems.locked | `GEM` specs (`name (version)` and `name (version-platform)`, the platform dropped as Bundler does: everything after the first `-`) | `direct` from `DEPENDENCIES` | `GIT`, `PATH` (except the App's own gemspec at `.`) and `PLUGIN SOURCE` specs: left out. Gem servers other than rubygems.org: listed, one warning |
| mix.lock | `:hex` tuples, by the Hex package name (the tuple's second element) | none | `:git` and `:path` tuples, and Hex repositories other than `hexpm` (private organisations): left out |
| packages.lock.json (v1, v2) | every target framework | `direct` (`type: Direct`; `Transitive` and `CentralTransitive` are not) | `Project` entries: skipped silently. An entry without `resolved`: left out |
| gradle.lockfile | `group:artifact:version[=configurations]` lines, the old per-configuration files too | none | `empty=` lines and comments skipped |

The YAML reader (`parseYamlSubset`) takes the block style pnpm and Yarn write: mappings, sequences, plain, single- and double-quoted scalars, one-line flow collections, comments and `---` documents; every scalar stays a string. Anchors, aliases, tags, block scalars, complex keys, tabs, multi-line plain scalars and multi-line flow collections are rejected. The TOML reader (`parseTomlSubset`) takes tables, arrays of tables, dotted and quoted keys, basic and literal strings (one-line and multi-line), integers, floats, booleans, dates (kept as strings), arrays and inline tables (which may span lines); duplicate keys and tables are rejected.

### `versions.mjs`

`compareVersions(ecosystem, a, b) -> -1|0|1` in the ecosystem's own order; ecosystem names in any case. Throws on an unknown ecosystem, on Maven, and on a version the rules can't read (`isVersion(ecosystem, v)` says beforehand). `isReliable(ecosystem)` is true for the eight below and false for Maven and unknown ecosystems.

- **npm, crates.io, Hex**: SemVer 2.0 precedence (pre-release identifiers numeric by value, numeric below alphanumeric, a shorter set below a longer one; build metadata ignored). Missing minor and patch read as 0 (OSV's `"0"`); a leading `v` is tolerated.
- **Go**: the same with the `v` prefix optional. A pseudo-version is a SemVer pre-release of the version it builds on, so it sorts by that base: above the release before it, below the release it precedes, and among pseudo-versions of one base by timestamp. `+incompatible` does not affect order.
- **Packagist**: `semver.mjs` `compare` (stability dev < alpha < beta < RC < stable, `v` and the fourth `.0` normalised), plus patch releases (`-p1`, `-pl1`, `-patch1`) above the plain release. Branches (`dev-main`, `1.x-dev`, `1.0.0-dev`) are not versions.
- **PyPI**: PEP 440 as `packaging` orders it: epoch, release (trailing zeros ignored), pre (a < b < rc, with the alternative spellings), post (and the implicit `1.0-1`), dev (a dev release with no pre or post below every pre-release), local (absent first; numeric segments above strings).
- **RubyGems**: Gem::Version: `-` reads as `.pre.`, segments split into numbers and letter runs, trailing zeros dropped from the numeric part and from the rest, and a letter segment below any number (so `1.0.0.pre < 1.0.0`).
- **NuGet**: four numeric parts (missing are 0), then release above pre-release, labels as SemVer but case-insensitive; metadata ignored.
- **Maven**: not implemented (`isReliable` false). Maven's ComparableVersion order is not attempted, so nothing here puts a Maven version in a range.

`normaliseVersion(ecosystem, v)` gives one spelling per version for exact `versions[]` matches: npm, crates.io, Hex and Go trimmed with a leading `v` dropped; Packagist through `semver.mjs` `normalise`; PyPI the PEP 440 normal form (`1.0-POST1` → `1.0.post1`, `1.0RC1` → `1.0rc1`, epoch 0 dropped); NuGet lowercased, metadata dropped, three parts (a fourth only when not 0); RubyGems, Maven and anything unreadable trimmed.

### `match.mjs`: the one matcher

The service's POST /v1/match and the accounts app both use it.

```ts
affects(affectedEntry: AffectedEntry, ecosystem: string, version: string): boolean;
matchPackages(advisories: MatchAdvisoryIn[], packages: { ecosystem: string; name: string; version: string }[]):
  { matches: MatchOut[]; unsupported: { ecosystem: string|null; name: string; version: string; reason: string }[] };

type AffectedEntry = {
  package: string; ecosystem: string;
  ranges: { type?: "ECOSYSTEM"|"SEMVER"|"GIT"; introduced?: string; fixed?: string; last_affected?: string; repo?: string }[]
        // or, also accepted, OSV's own form: { type, events: [{ introduced | fixed | last_affected | limit }] }
  versions?: string[];
};
type MatchAdvisoryIn = {                 // a CONTRACT Advisory; only these fields are read
  id: string; aliases?: string[]; summary?: string; affected: AffectedEntry[];
  state?: string|null; url?: string|null; malicious?: boolean; signals?: any; withdrawn?: string|null;
};
type MatchOut = {                        // the POST /v1/match shape, one per Advisory and package
  advisory: { id: string; aliases: string[]; summary: string; state: string|null; url: string|null;
              affected: AffectedEntry[];    // only this package's entries
              fixed_versions: string[];     // the `fixed` of those entries' ECOSYSTEM/SEMVER ranges, sorted by compareVersions
              malicious: boolean; signals: any|null };
  installed: { ecosystem: string; name: string; version: string }[];  // the affected versions of this package, ascending; ecosystem as OSV names it
};
```

- `affects`: true when the version is in the entry's `versions[]` (exact string match after `normaliseVersion`), otherwise when it falls in any ECOSYSTEM or SEMVER range under `compareVersions` (a range with no `type` is ECOSYSTEM, so records normalised before ranges carried `type` still match). GIT ranges are never evaluated. Where `isReliable` is false (Maven) only `versions[]` counts. A version, or a range bound, the rules can't read is never placed in a range; only `versions[]` can match it. `rangeContainsFor(ecosystem, entry, version)` is the same function with the ecosystem first; plan.mjs re-exports it and osv.mjs's `rangeContains` uses it for every entry outside Packagist and npm.
- Package names match by `nameKey`: PEP 503 for PyPI, lowercase for Packagist and NuGet, as written elsewhere. Ecosystems match through `ecosystemOf` (OSV names and GitHub's aliases, any case; a suffixed ecosystem such as `Packagist:https://packages.drupal.org/8` is none).
- Withdrawn Advisories (`withdrawn` set, or `state` `withdrawn` or `retracted`) never match. `state`, `url`, `malicious` and `signals` pass through untouched (null when absent; `malicious`, when absent, is whether the id or an alias starts `MAL-`, as `report` decides). Input packages are de-duplicated by ecosystem, name key and version. Matches are sorted by ecosystem, name key, then Advisory id.
- `unsupported` lists packages whose ecosystem is none of the nine, packages without a name or version, and packages whose version the ecosystem's rules can't read (these are still matched by `versions[]`). Maven packages are supported, matched by `versions[]` only, and not listed there.

### `plan.mjs`: `upgradePlan(matches) -> UpgradePlan`

The input is `matchPackages(...).matches` unchanged, the POST /v1/match response's `matches`: `[{ advisory: { id, aliases, summary, state, url, affected, fixed_versions, malicious, signals }, installed: [{ ecosystem, name, version }] }]`. Only `id`, `affected`, `fixed_versions`, `malicious` and `state` (and a `withdrawn` timestamp) are read; missing optional fields are tolerated. When `affected` has no entry naming the package, its entries with no package or ecosystem of their own are used.

```ts
type UpgradePlan = {
  packages: {
    ecosystem: string; name: string;
    installed: string[];             // distinct installed versions across the package's matches, ascending
    advisories: string[];            // every matched Advisory id, sorted
    fixed_by: string|null;           // see below; as the Advisory writes it (Go fixes have no v)
    unfixed: string[];               // the Advisories fixed_by does not clear
    comparison: "exact"|"unavailable";
    fixed_versions?: Record<string, string[]>;  // "unavailable" only: per Advisory id, its fixed versions
  }[];
  malicious: { ecosystem: string; name: string; installed: string[]; advisories: string[] }[];
  summary: {
    matches: number;                 // Matches counted (not malicious, not withdrawn)
    packages: number;
    malicious: number;               // malicious Matches
    cleared_by_top: { n: number; packages: string[]; advisories: number }[];
  };
  warnings: string[];                // e.g. "<id> is withdrawn or retracted; its match was skipped"
};
```

- **`fixed_by`.** Candidates are the `fixed` versions of the package's matched Advisories (from `affected[].ranges`, both forms, and `fixed_versions`), never below the highest installed version, so a fix on an older branch is never chosen when the installed version is newer; with several installed versions, the highest of them is a candidate too (the others can move up to it). An Advisory with no candidate outside its own ranges and `versions[]` is unfixed (an open range, or `last_affected` with no later fixed version). `fixed_by` is the lowest candidate, by `compareVersions`, that is outside every matched Advisory's affected ranges and `versions[]`; when no candidate clears them all together, the lowest one that clears the most, and the rest are in `unfixed`. Nothing is checked against a registry: `fixed_by` is a version some Advisory names, not necessarily the newest or a published one.
- **Unavailable.** When `isReliable` is false (Maven, unknown ecosystems) or an installed version can't be read, `fixed_by` is null, `comparison` is `"unavailable"`, `unfixed` lists the Advisories with no fixed version at all, and `fixed_versions` lists each Advisory's fixed versions (in record order for Maven).
- **Malicious** matches (`malicious`, or a `MAL-` id) go in `malicious`, grouped by package: the remedy is removing the package, so they are never in `packages`, `matches` or `cleared_by_top`. Withdrawn or retracted matches are skipped with a warning.
- **Order and `cleared_by_top`.** Packages sort by the number of Advisories cleared, descending, then name, then ecosystem. `cleared_by_top` ranks the packages that clear at least one Advisory and gives, for N = 1, 3, 5 and 10 (each N no larger than that count, plus N = the count when it is below 10 and not already listed), the names of the top N and how many Matches upgrading them all clears (a Match is cleared when every package it names is in the top N and its `fixed_by` clears that Advisory).

### `osv.mjs` beyond Packagist and npm

`ecosystemName` returns every OSV name above and takes GitHub's aliases (`composer`, `pip`, `rust`, `cargo`, `go`, `golang`, `rubygems`, `gem`, `erlang`, `hex`, `nuget`, `maven`) in any case; an ecosystem with a suffix or qualifier is null. `normaliseOsv` keeps every affected entry of those ecosystems. Packagist and npm entries are unchanged (intervals with no `type`; GIT ranges dropped). Every other entry's ranges become typed CONTRACT intervals (`contractRanges`): ECOSYSTEM and SEMVER events in `compareVersions` order, record order for Maven or an unreadable version, and GIT ranges kept with their `repo`, paired in record order, never evaluated; `limit` events are dropped; `versions[]` is kept unchanged. For such a package, `affected_range` (`formatRanges`) and `fixed_versions` (`fixedVersionsFor`) sort with `compareVersions` (record order for Maven). Without `--package`, the primary entry is still the first Packagist or npm one, else the first of any ecosystem. `resolveAdvisory`, `advisory --provisional`, `matchInventory`, `usages` and the skill stay Packagist and npm only.

## Known limits

Found in review; they stay as they are for now.

- **One Verdict file per Advisory id, not per package.** Verdicts and profiles are stored as `<app>/.agentprime/{verdicts,profiles}/<advisory id>.json`. An Advisory that matches two installed packages in one App (rare) yields two Matches that share one profile and one Verdict file: the second Assessment overwrites the first, and the cache then misses for one of them on every run. To be keyed by id and package later.
- **`bundled` marks imported names only.** A package the client source imports is `bundled`; its own dependencies (axios's follow-redirects, form-data, …) are not, though a bundler may ship them too. The dev-only check (rule 4b) therefore does not catch a dev-only reason for such a dependency; the skill tells the model to treat a bundled package's dependencies as shipped. Imports through an alias (`@/…`), a re-export from the App's own module, or a directory outside the scanned ones are not seen.
- **A usage limit is recognised by its wording.** Claude Code gives no stable code for "your account is at its limit", so `report` matches the CLI's text (Slice 2 step 3). A release that rewords it would make limit rows `error` again, which is what the first 208-Advisory report showed (95 `error` rows at $0.00 from one point on); a run of `error` rows that all cost $0 is the sign to check the wording against the binary.
- **`--retry-errors` carries rows over.** A carried `no_match` or `rejected` row is the last report's, not re-checked; run without the flag to reassess everything not cached.
- **A package usage note can carry an error to its siblings.** A note is model-written content reused across runs: a wrong fact, or one a steered run wrote on purpose (an App's code or an Advisory's text can try to steer a run), can mislead every later Assessment of the same package. The mitigations are the re-read rule (the skill and the reader confirm every cited line says what the note claims before relying on it, and the note is never evidence), `check`'s independent validation of every Verdict (evidence must exist; Not affected must cover every `usages` file; `.agentprime/` can't be cited), freshness (a note goes stale when the package's usages, its installed entries or a cited line change), and the labelled set, which measures Verdicts whether or not a note was used. A note says nothing about which Verdict is right; it only says where to look. Notes are never published and never leave the App's `.agentprime/`.
- **Concurrent saves of one package's note: the last write wins.** Siblings of a package run in parallel once its first run has finished, and two of them saving at once each merge onto the note as they read it, so one's new facts can be lost. Each write is a whole, valid file; a lost fact is found again by a later run.
- **A labelled entry can hide a false positive.** `classify` counts any Verdict in `acceptable` as correct, so an entry with `known: "not_affected"` that lists `reachable_unproven` as acceptable would hide a false positive. Entries must not do that; the labelled-set validation test rejects such an entry rather than `eval` overriding it.
- **Lockfile parsing knows each format's own records only.** `parseLockfile` sees one file: a requirements.txt `-r` include, a composer.json beside composer.lock (so composer.lock has no `direct`), a package.json beside yarn.lock (so Yarn has no `direct`/`dev`) and go.sum's choice among several versions are not read, and each is said in `warnings` rather than guessed. Packages from git, local paths, tarball URLs, private registries and indexes are left out or flagged (see the table in "Lockfiles, versions and upgrade plans"), so a vulnerable fork or a private mirror of a public name can be missed. requirements.txt lists only exact pins; poetry.lock `legacy` sources and Gemfile.lock gem servers other than rubygems.org are listed by name with a warning. pnpm `dev` for lockfile 9 is derived from the importers' graph; when a reference dangles, `dev` and `via` are dropped for the whole file. Go: no `stdlib` entry is produced from `go`/`toolchain`, and versions keep the `v` that OSV's records omit (the comparison reads both).
- **Vendor evidence needs an installed `vendor/`.** `check` reads the cited file from the App's `vendor/`, so vendor evidence comes from runs where `vendor/` is already installed (local runs, `report` on a developer's machine). Nothing installs it: central workers never install dependencies (ADR-0006), so they have no vendor evidence unless a Repository commits `vendor/`. Only `vendor/` itself is read: a composer.json `config.vendor-dir` elsewhere is not followed. Package usage notes stay App-only: a note fact under `vendor/` is still rejected. A link shows the released code at the installed commit; a composer-patches change is warned about, not shown. Which files an agent reads is held by the skill's and the reader's rules, not by a tool permission (deny rules beat allow rules, so `vendor/` can't be closed with three packages left open); `check` holds what may be cited.
- **Maven has no version order here.** `isReliable("Maven")` is false: Maven packages match only by an Advisory's explicit `versions[]`, and the plan lists fixed versions per Advisory instead of choosing one. An Advisory whose Maven entry has ranges but no `versions[]` never matches.
- **The upgrade plan picks from fixed versions the Advisories name.** `fixed_by` is never checked against a registry (it may be yanked, or a newer release may be the better upgrade), and a package whose Advisories have no mutually compatible listed fix gets the version that clears the most, with the rest in `unfixed`.
