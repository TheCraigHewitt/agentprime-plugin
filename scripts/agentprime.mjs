#!/usr/bin/env node
// CLI entry. See scripts/CONTRACT.md. Owner: core.
import { parseArgs } from "./lib/args.mjs";

const commands = {
  apps: async () => (await import("./lib/apps.mjs")).run,
  inventory: async () => (await import("./lib/inventory.mjs")).run,
  match: async () => (await import("./lib/osv.mjs")).runMatch,
  advisory: async () => (await import("./lib/osv.mjs")).runAdvisory,
  usages: async () => (await import("./lib/usages.mjs")).run,
  check: async () => (await import("./lib/check.mjs")).run,
  save: async () => (await import("./lib/check.mjs")).runSave,
  note: async () => (await import("./lib/notes.mjs")).run,
  report: async () => (await import("./lib/report.mjs")).run,
  eval: async () => (await import("./lib/report.mjs")).runEval,
};

const USAGE = `usage: agentprime <apps|inventory|match|advisory|usages|check|save|note|report|eval> [...] [--app <path>] [--cwd <path>]`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const load = commands[args.command];
  if (!load) {
    process.stderr.write(USAGE + "\n");
    process.exit(1);
  }
  const run = await load();
  const result = await run(args);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
  process.exit(err.exitCode ?? 1);
});
