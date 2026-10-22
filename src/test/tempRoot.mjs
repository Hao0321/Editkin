// Test-only temporary folders. Every folder is removed again (also when the test
// fails), unless an explicit environment variable asks to keep it as evidence.
// Plain ESM (with tempRoot.d.mts) so vitest and node:test files can share it.
import { lstat, mkdir, mkdtemp, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `<app>/.rd/tmp`: repository-local scratch parent used by decoder-heavy tests. */
export const REPO_TMP = fileURLToPath(new URL("../../.rd/tmp", import.meta.url));
/** Set to a folder to keep every test temp root (each is then created under that folder). */
export const EVIDENCE_ENV = "EDITKIN_TEST_EVIDENCE_ROOT";

// Importing "vitest" outside its runner throws, so only load it inside vitest.
const vitest = process.env.VITEST ? await import("vitest").catch(() => undefined) : undefined;

/**
 * Creates `<parent>/<prefix>XXXXXX` (parent defaults to the OS temp folder).
 * When the `keepEnv` variable (or EDITKIN_TEST_EVIDENCE_ROOT) names a folder,
 * the root is created there instead and `remove()` keeps it; `keep: true`
 * keeps it in place (for an explicitly requested run that refers to it later).
 */
export async function createTempRoot(prefix, { parent, keepEnv, keep = false } = {}) {
  const keepIn = (keepEnv && process.env[keepEnv]) || process.env[EVIDENCE_ENV] || undefined;
  const base = resolve(keepIn ?? parent ?? tmpdir());
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, prefix)), kept = Boolean(keepIn) || keep;
  return { path, kept, remove: async () => { if (!kept) await removeTempRoot(path); } };
}

/**
 * Deletes a folder tree without ever following a link: every symlink and
 * junction inside it is unlinked as a link first, then the remaining plain
 * files and folders are removed. A missing path is not an error.
 */
export async function removeTempRoot(path) {
  await unlinkLinks(path);
  await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  const left = await lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
  if (left) throw new Error(`Temp root still exists after removal: ${path}`);
}

async function unlinkLinks(path) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink()) return unlinkLink(path); // Windows junctions are reported as links too.
  if (!stat.isDirectory()) return;
  for (const name of await readdir(path)) await unlinkLinks(join(path, name));
}

async function unlinkLink(path) {
  try { await unlink(path); } catch (error) {
    if (error.code === "ENOENT") return;
    if (error.code !== "EPERM" && error.code !== "EISDIR") throw error;
    await rmdir(path); // Removes a directory link entry itself, never the target's contents.
  }
}

async function removeAll(roots) {
  const errors = [];
  // Links in every root go first, so no root's removal can reach another root through a link.
  for (const root of roots) if (!root.kept) await unlinkLinks(root.path).catch(error => errors.push(error));
  for (const root of [...roots].reverse()) await root.remove().catch(error => errors.push(error));
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Temp root cleanup failed");
}

/**
 * Call once at module scope. `create()` makes a temp root and returns its path.
 * Under vitest (no argument), roots made inside a test or beforeEach are removed
 * when that test finishes, pass or fail, and roots made in beforeAll are removed
 * in afterAll. Under node:test, pass its `after` hook: every root is removed there.
 */
export function useTempRoots(after) {
  const open = [];
  const track = async (prefix, options) => { const root = await createTempRoot(prefix, options); open.push(root); return root; };
  if (after) {
    after(() => removeAll(open.splice(0)));
    return { create: async (prefix, options) => (await track(prefix, options)).path };
  }
  if (!vitest) throw new Error("useTempRoots() without an after hook needs the vitest runner");
  vitest.afterAll(() => removeAll(open.splice(0)), 120_000);
  let batch;
  return {
    async create(prefix, options) {
      const root = await track(prefix, options);
      if (!batch) {
        const roots = [];
        try {
          vitest.onTestFinished(() => {
            if (batch === roots) batch = undefined;
            for (const root of roots) { const at = open.indexOf(root); if (at >= 0) open.splice(at, 1); }
            return removeAll(roots);
          }, 120_000);
          batch = roots;
        } catch { /* Not inside a test (beforeAll or module scope): afterAll removes it. */ }
      }
      batch?.push(root);
      return root.path;
    },
  };
}
