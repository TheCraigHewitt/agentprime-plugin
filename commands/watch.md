---
description: Watch this repository's lockfiles with agentprime and get emailed about new matches
argument-hint: "[path to a lockfile, optional]"
allowed-tools: Glob, Read, Bash(git remote get-url:*), mcp__agentprime__watch_lockfile, mcp__agentprime__watch_packages, mcp__agentprime__list_watched
---

Set up agentprime watching for this repository's lockfiles, so the user is emailed when a new advisory matches.

1. Find the lockfiles. If `$ARGUMENTS` names a file, use only that. Otherwise use Glob to find these files, skipping anything under `node_modules/`, `vendor/`, `.git/` and `.agentprime/`: `composer.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `requirements.txt`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, `mix.lock`, `packages.lock.json`, `gradle.lockfile`. If there are none, say so and stop.
2. Call `list_watched` first. If a lockfile already appears to be watched (same label), don't add it twice; say it's already watched.
3. For each new lockfile, call `watch_lockfile` with its file name, contents and a label of the form `<repository name>: <path>`, where the repository name is the directory name (or the name from `git remote get-url origin`, without the host or owner). Only package names and versions are saved, encrypted; never the file itself.
4. Errors:
   - If the tools say a key is needed, tell the user to get a free key at https://agentprime.io/account/ and reconnect the server with it:
     `claude mcp remove agentprime` then
     `claude mcp add --transport http agentprime https://api.agentprime.io/mcp --header "Authorization: Bearer <key>"`
   - If the free account's limit of 10 watched lockfiles is reached, say so and suggest removing one at https://agentprime.io/account/.
   - If the agentprime tools aren't available at all, give the `claude mcp add` command above.
5. Report what is now watched, with each lockfile's current match count, and say that alerts go to the account's email: a daily digest when something changes, and right away for a malicious package or an actively exploited advisory. When a lockfile changes later, the user can run this command again to update it.
