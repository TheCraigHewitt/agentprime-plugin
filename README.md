# agentprime plugin for Claude Code

**Does this Advisory affect my App?** Give Claude Code a published Advisory (a CVE or GHSA id, an advisory link, or the pasted text of a post about a vulnerable package) and this plugin assesses it against one App in the current repository. Every Assessment ends in a Verdict with file:line evidence:

- **Not affected**: the evidence shows the App doesn't use the vulnerable code in a way the Advisory needs.
- **Reachable – unproven**: a traced path shows untrusted input can reach the vulnerable code. Treat it as affected and take the Upgrade.
- **Inconclusive**: the plugin couldn't rule the Advisory out, and says why.

It runs on your machine, with your own Claude login. Your code never leaves it for agentprime: nothing is sent to us, the plugin reads your repository locally inside your own Claude Code session, and its script looks up Advisories (on OSV) and package metadata by package name and version only.

The plugin is the free, local slice of [agentprime](https://agentprime.io).

## Requirements

- [Claude Code](https://docs.claude.com/en/docs/claude-code)
- Node 20 or later (the plugin's `agentprime` script has no dependencies and never runs your App's code or your packages' code)

## Install

In Claude Code:

```text
/plugin marketplace add TheCraigHewitt/agentprime-plugin
/plugin install agentprime@agentprime
```

To update later, run `/plugin marketplace update agentprime`.

## Use it

### Quick commands (need the agentprime MCP server)

Connect the MCP server once (add `--header "Authorization: Bearer <key>"` with a free key from https://agentprime.io/account/ for higher limits and watching):

```text
claude mcp add --transport http agentprime https://api.agentprime.io/mcp
```

Then, from a repository:

- `/agentprime:check` checks its lockfiles against every published advisory and gives an upgrade plan.
- `/agentprime:watch` watches them and emails you about new matches (needs a free key).
- `/agentprime:cve CVE-2026-12345` says whether one advisory is in your dependencies.

### Does it affect my code?

From the repository you want to assess, ask in plain words ("does CVE-2026-12345 affect us?", or paste an advisory link) or run the skill directly:

```text
/agentprime:does-this-affect-me GHSA-xxxx-xxxx-xxxx
```

If the repository has more than one App, the plugin lists them and asks which one to assess. It first confirms the Advisory is a Match (your installed version is inside its affected range); if it isn't, it says so and stops. Otherwise it analyses the Advisory, reads the code around every place your App uses the package, and records a Verdict.

The skill writes its Advisory profile to `.agentprime/profiles/<id>.json` and its Verdict to `.agentprime/verdicts/<id>.json` in the assessed repository. Add `.agentprime/` to that repository's `.gitignore`.

## The noise report

The noise report runs the skill once over every open Advisory for an App's installed dependencies, each in its own headless Claude Code run, and summarises the Verdicts. It runs from a clone of this repository, on your own Claude Code login:

```bash
git clone https://github.com/TheCraigHewitt/agentprime-plugin.git ~/agentprime-plugin
cd /path/to/your/repository
node ~/agentprime-plugin/scripts/agentprime.mjs report --app . --max-turns 25
```

- It runs `match` (OSV) for the App, then one `claude -p "/agentprime:does-this-affect-me <id>"` per Advisory from the repository root, with the clone as its plugin. Each run may only read (Read, Grep, Glob and the read-only reader subagent), run the agentprime script, and fetch from github.com, osv.dev and api.osv.dev (the Advisory's fix commit and advisory page); Write, Edit, WebSearch and every other command are denied. Because Bash is allowed only for the script's exact path, the clone's path must not contain spaces.
- It writes `.agentprime/report.json` in the App: counts, the total cost of this run, one row per Advisory with its Verdict, action, reason, cost, turns and status. Malicious package entries (`MAL-` ids) are listed separately and never assessed. A one-paragraph summary ("31 Advisories: 27 Not affected, 3 Inconclusive, 1 Reachable – unproven, and 1 Upgrade to open. …") goes to stderr.
- A stored Verdict is reused, with no run, while all of its inputs are unchanged (the Advisory's affected range and fixed versions, the installed version, every place the App uses the package, and every evidence file), so re-running the report only reassesses what changed.
- Flags: `--only id,id` restricts it to those Advisories, `--no-run` shows which Verdicts are cached and which would run without starting any, `--concurrency N` runs N Assessments at a time (default 1), `--model M` picks the model, `--max-cost-usd X` caps each run's cost, `--timeout-seconds S` stops a run after S seconds (default 900).

## Run the script directly

The `agentprime` script does every deterministic step: finding Apps, parsing lockfiles, matching Advisories through OSV, locating usages, and checking Verdicts. From the repository root:

```bash
node ~/agentprime-plugin/scripts/agentprime.mjs apps
node ~/agentprime-plugin/scripts/agentprime.mjs inventory --app .
node ~/agentprime-plugin/scripts/agentprime.mjs match --app .
node ~/agentprime-plugin/scripts/agentprime.mjs advisory GHSA-xxxx-xxxx-xxxx
```

Each command prints one JSON document. Commands, flags and output shapes are in [scripts/CONTRACT.md](scripts/CONTRACT.md).

## Contributing

This repository is generated from agentprime's main repository and is never edited by hand. Issues and pull requests are welcome here; accepted changes land in the main repository and arrive here with the next publish.

## Licence

[MIT](LICENSE). Plugin version 0.2.0.
