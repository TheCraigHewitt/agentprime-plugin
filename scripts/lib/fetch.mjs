// All network access for the script goes through here, so tests can serve fixtures instead.
// See scripts/CONTRACT.md. Owner: network.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const USER_AGENT = "agentprime/0.1";
const DEFAULT_TTL_SECONDS = 3600;

let defaultCwd = null;

/** configureFetch({ cwd }): set the Repository root whose `.agentprime/cache/` holds the cache (default process.cwd()). */
export function configureFetch({ cwd } = {}) {
  defaultCwd = cwd ? resolve(cwd) : null;
}

function cacheDir(cwd) {
  return join(resolve(cwd ?? defaultCwd ?? process.cwd()), ".agentprime", "cache");
}

function hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function httpError(status, method, url, detail = "") {
  const err = new Error(`HTTP ${status} for ${method === "GET" ? "" : method + " "}${url}${detail ? `: ${detail}` : ""}`);
  err.status = status;
  err.url = url;
  return err;
}

// --- fixtures ------------------------------------------------------------------------------------------

let manifestCache = { dir: null, manifest: null };

function loadManifest(dir) {
  if (manifestCache.dir !== dir) {
    const path = join(dir, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`AGENTPRIME_FIXTURES is set but ${path} can't be read: ${err.message}`);
    }
    manifestCache = { dir, manifest };
  }
  return manifestCache.manifest;
}

/**
 * Manifest entries:
 *   "<url>": "<relative file>"                       GET, served with status 200
 *   "<url>": { "status": 404 } | { "file", "status" } GET, a non-2xx status (file optional, used as the body)
 *   "POST <url>": "<relative file>"                   POST, any body
 *   "POST <url>": [ { "body": <json>, "file": "..." } ] POST, chosen by deep-equal on the JSON body
 */
function fromFixtures(dir, method, url, body) {
  const manifest = loadManifest(dir);
  const key = method === "GET" ? url : `${method} ${url}`;
  let entry = manifest[key];
  if (entry === undefined) {
    throw new Error(`no fixture for ${key} in ${join(dir, "manifest.json")} (network is disabled while AGENTPRIME_FIXTURES is set)`);
  }
  if (Array.isArray(entry)) {
    let parsed;
    try {
      parsed = body === undefined ? undefined : JSON.parse(body);
    } catch {
      parsed = body;
    }
    const hit = entry.find((e) => isDeepStrictEqual(e.body, parsed));
    if (!hit) throw new Error(`no fixture for ${key} with body ${body} in ${join(dir, "manifest.json")}`);
    entry = hit;
  }
  if (typeof entry === "string") entry = { file: entry };
  const status = entry.status ?? 200;
  const text = entry.file ? readFileSync(join(dir, entry.file), "utf8") : "";
  if (status < 200 || status > 299) throw httpError(status, method, url, "(fixture)");
  return text;
}

// --- network + disk cache ------------------------------------------------------------------------------

function readCache(file, ttlSeconds) {
  if (!(ttlSeconds > 0)) return null;
  try {
    const entry = JSON.parse(readFileSync(file, "utf8"));
    const age = (Date.now() - Date.parse(entry.fetched_at)) / 1000;
    if (Number.isFinite(age) && age >= 0 && age < ttlSeconds && typeof entry.body === "string") return entry.body;
  } catch {
    // missing or corrupt: fetch again
  }
  return null;
}

function writeCache(file, record) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record));
  } catch {
    // a cache we can't write is not an error
  }
}

async function request(url, { ttlSeconds = DEFAULT_TTL_SECONDS, method = "GET", body, headers = {}, cwd } = {}) {
  if (body !== undefined && typeof body !== "string") body = JSON.stringify(body);
  const fixtures = process.env.AGENTPRIME_FIXTURES;
  if (fixtures) return fromFixtures(resolve(fixtures), method, url, body);

  const key = method === "GET" ? url : `${method} ${url}\n${body ?? ""}`;
  const file = join(cacheDir(cwd), hex(key) + ".json");
  const cached = readCache(file, ttlSeconds);
  if (cached !== null) return cached;

  let res;
  try {
    res = await fetch(url, {
      method,
      body,
      headers: {
        "User-Agent": USER_AGENT,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
    });
  } catch (err) {
    const cause = err.cause?.code || err.cause?.message || err.message;
    const hint =
      process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY ? " (HTTPS_PROXY is set; Node's fetch uses it only with NODE_USE_ENV_PROXY=1)" : "";
    const wrapped = new Error(`request to ${url} failed: ${cause}${hint}`);
    wrapped.url = url;
    throw wrapped;
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.parse(text).message ?? "";
    } catch {
      // not JSON
    }
    throw httpError(res.status, method, url, detail);
  }
  writeCache(file, { url, method, fetched_at: new Date().toISOString(), status: res.status, body: text });
  return text;
}

/** fetchText(url, { ttlSeconds = 3600, method, body, headers, cwd }) -> string. Throws on non-2xx; err.status is set. */
export async function fetchText(url, options = {}) {
  return request(url, options);
}

/** fetchJson(url, { ttlSeconds = 3600, method, body, headers, cwd }) -> parsed JSON. Throws on non-2xx; err.status is set. */
export async function fetchJson(url, options = {}) {
  const text = await request(url, { ...options, headers: { Accept: "application/json", ...(options.headers ?? {}) } });
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON from ${url}: ${err.message}`);
  }
}
