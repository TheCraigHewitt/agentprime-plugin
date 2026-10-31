// Content hashes for the Verdict cache. See scripts/CONTRACT.md. Owner: core.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** sha256(text) -> "sha256:<hex>" */
export function sha256(text) {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

const NEVER_READ = new Set(["vendor", "node_modules", ".git"]);

function readInside(appDir, relPath) {
  const abs = resolve(appDir, relPath);
  const rel = relative(appDir, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null; // outside the App: never read
  if (rel.split(sep).some((part) => NEVER_READ.has(part))) return null;
  try {
    return readFileSync(abs);
  } catch {
    return null; // missing, a directory, or unreadable
  }
}

/**
 * hashFiles(appDir, relPaths) -> "sha256:<hex>"
 * Over the sorted, de-duplicated paths, each contributing its path and its content. A missing file (or one
 * outside the App, or under vendor/ or node_modules/) contributes the literal "<missing>", so creating,
 * deleting or editing any cited file changes the hash. Each content is length-prefixed so the encoding is
 * unambiguous.
 */
export function hashFiles(appDir, relPaths) {
  const paths = [...new Set((relPaths ?? []).map((p) => String(p).replaceAll("\\", "/").replace(/^\.\//, "")))].sort();
  const h = createHash("sha256");
  for (const p of paths) {
    const content = readInside(appDir, p);
    if (content === null) {
      h.update(`${p}\n<missing>\n`);
    } else {
      h.update(`${p}\n${content.length}\n`);
      h.update(content);
      h.update("\n");
    }
  }
  return "sha256:" + h.digest("hex");
}
