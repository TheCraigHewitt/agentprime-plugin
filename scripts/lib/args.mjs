// Argument parsing and path resolution for the CLI. See scripts/CONTRACT.md. Owner: core.
import { resolve } from "node:path";

// Flags that never take a value, so `--provisional --package x` and `--provisional GHSA-...` both parse.
const BOOLEAN_FLAGS = new Set(["provisional", "help"]);

/**
 * parseArgs(argv) -> { command, positional, flags }
 * `--name value`, `--name=value` and `--name` (true). The first non-flag token is the command; every later
 * non-flag token is positional. `--` ends flag parsing. A repeated flag keeps its last value.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let command = null;
  const push = (token) => {
    if (command === null) command = token;
    else positional.push(token);
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      for (const rest of argv.slice(i + 1)) push(rest);
      break;
    }
    if (token.startsWith("--") && token.length > 2) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(body) && next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }
    push(token);
  }
  return { command, positional, flags };
}

/**
 * resolvePaths(flags) -> { cwd, appDir }, both absolute.
 * `--cwd` is the Repository root (default process.cwd()); `--app` is relative to it (default ".").
 */
export function resolvePaths(flags = {}) {
  const cwd = resolve(typeof flags.cwd === "string" ? flags.cwd : process.cwd());
  const appDir = resolve(cwd, typeof flags.app === "string" ? flags.app : ".");
  return { cwd, appDir };
}
