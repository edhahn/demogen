import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal `.env` loader. Reads `KEY=VALUE` lines from the given path and
 * sets them on `process.env` *without* overriding values already present —
 * shell-exported vars and CLI-passed env always win.
 *
 * Supported syntax:
 *   - `# comment` lines and blank lines are ignored
 *   - `KEY=value` (whitespace around `=` allowed)
 *   - `KEY="value with spaces"` and `KEY='value'` (matching quotes stripped)
 *   - `export KEY=value` (the leading `export` keyword is ignored)
 *
 * Returns the absolute path that was loaded, or `null` if the file did not
 * exist (callers can decide whether that is an error).
 */
export function loadEnvFile(path: string): string | null {
  const abs = resolve(path);
  if (!existsSync(abs)) return null;

  const raw = readFileSync(abs, "utf-8");
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const stripped = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = stripped.indexOf("=");
    if (eq === -1) continue;

    const key = stripped.slice(0, eq).trim();
    if (!key) continue;
    if (key in process.env) continue;

    let value = stripped.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }

  return abs;
}

/**
 * Resolve which env file to load given an explicit path (from `--env` or
 * `RunOptions.envPath`). When no explicit path is given, falls back to
 * `./.env.demogen` in the current working directory if it exists.
 *
 * If `explicitPath` is provided but the file does not exist, this throws —
 * an explicit request that misses is almost always a typo.
 */
export function loadDemogenEnv(explicitPath?: string): string | null {
  if (explicitPath) {
    const loaded = loadEnvFile(explicitPath);
    if (!loaded) {
      throw new Error(`--env file not found: ${resolve(explicitPath)}`);
    }
    return loaded;
  }
  return loadEnvFile(".env.demogen");
}
