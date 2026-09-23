// Test-only fault boundaries around the actual projectFiles save workflow.
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const [path, mode, revisionText, name] = process.argv.slice(2);
if (!path || !mode || !name || !process.send) throw Error("Owned IPC test fixture only");
const revision = Number(revisionText);
const original = { open: filesystem.open, rename: filesystem.rename, rm: filesystem.rm };
let stopped = false;
const hold = async (boundary: string) => {
  if (stopped) return;
  stopped = true;
  const released = new Promise<void>(resolve => process.once("message", message => {
    if (message !== "release") throw Error("Invalid fixture release");
    resolve();
  }));
  process.send!({ type: "held", boundary, pid: process.pid });
  await released;
};
filesystem.open = (async (...args: Parameters<typeof filesystem.open>) => {
  if (mode === "before-temp" && String(args[0]).startsWith(`${path}.`) && String(args[0]).endsWith(".tmp")) await hold("before-temp");
  return original.open(...args);
}) as typeof filesystem.open;
filesystem.rename = async (...args: Parameters<typeof filesystem.rename>) => {
  if (mode === "before-publish" && String(args[1]) === path) await hold("before-publish");
  return original.rename(...args);
};
filesystem.rm = async (...args: Parameters<typeof filesystem.rm>) => {
  if (String(args[0]).startsWith(`${path}.`) && String(args[0]).endsWith(".tmp")) {
    if (mode === "after-publish") await hold("after-publish");
    if (mode === "cleanup-error" && !stopped) {
      stopped = true;
      throw Object.assign(new Error("injected temporary cleanup failure"), { code: "EACCES" });
    }
  }
  return original.rm(...args);
};
syncBuiltinESMExports();
const { readProjectFile, writeProjectFileAtomic } = await import("../../src/application/projectFiles");
try {
  const current = await readProjectFile(path);
  const saved = await writeProjectFileAtomic(path, { ...current, name }, revision);
  process.send!({ type: "saved", pid: process.pid, revision: saved.revision, name: saved.name });
} catch (error) {
  const failure = error as Error & { code?: string };
  process.send!({ type: "failed", pid: process.pid, name: failure.name, message: failure.message, code: failure.code });
  if (mode === "cleanup-error") {
    // Remain genuinely alive so a succeeding contender proves finally released
    // ownership, not merely that OS process teardown later released it.
    await new Promise<void>(resolve => process.once("message", message => {
      if (message !== "release") throw Error("Invalid fixture release");
      resolve();
    }));
  }
}
process.disconnect();
