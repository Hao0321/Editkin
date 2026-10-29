import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createOwnedDirectoryV1, LONG_RENDER_OWNER_FILE, openLongRenderJournalV1, removeJournaledPathV1, replayLongRenderJournalsV1 } from "./longRenderOwnerJournalV1";

const temp = useTempRoots();
const exists = (path: string) => stat(path).then(() => true, () => false);
const junction = process.platform === "win32" ? "junction" : "dir";

async function setup(runId = "11111111-2222-3333-4444-555555555555") {
  const root = await temp.create("long-journal-");
  const work = join(root, "work"), registry = join(root, "registry");
  await mkdir(work);
  const journal = await openLongRenderJournalV1({ workRoot: work, runId, registryRoot: registry });
  return { root, work, registry, journal, runId };
}

describe("long-render exact-path owner journal", () => {
  it("removes exactly the journaled owned paths, then its own journal and pointer", async () => {
    const { root, work, registry, journal, runId } = await setup();
    const runDir = join(work, `editkin-long-run-${runId}`), staging = join(root, "out", `.film.mp4.${runId}.editkin-long`);
    await createOwnedDirectoryV1(runDir, runId); await journal.recordCreated(runDir, "run-work-dir");
    await createOwnedDirectoryV1(staging, runId); await journal.recordCreated(staging, "output-staging-dir");
    await mkdir(join(runDir, "editkin-render-abc123"), { recursive: true }); await writeFile(join(runDir, "editkin-render-abc123", "frame.png"), "x");
    await writeFile(join(staging, `.film.mp4.${runId}.editkin-long.part.mp4`), "part");
    const neighbour = join(root, "out", "film-previous.mp4"); await writeFile(neighbour, "user output");
    const unjournaled = join(work, "someone-else.bin"); await writeFile(unjournaled, "keep");
    expect(await exists(journal.pointerPath)).toBe(true);
    const receipt = await journal.cleanup({ releaseMs: 2_000 });
    expect(receipt.leftovers).toEqual([]);
    expect(receipt.removed.sort()).toEqual([runDir, staging].sort());
    expect(await exists(runDir)).toBe(false); expect(await exists(staging)).toBe(false);
    expect(await readFile(neighbour, "utf8")).toBe("user output"); expect(await readFile(unjournaled, "utf8")).toBe("keep");
    expect(await exists(journal.path)).toBe(false); expect(await readdir(registry)).toEqual([]);
  });

  it("never removes a path whose identity changed, a junction, or anything reached through a junction", async () => {
    const { root, work, journal, runId } = await setup();
    const file = join(work, "owned.bin"); await writeFile(file, "first");
    await journal.recordCreated(file, "file");
    await unlink(file); await writeFile(file, "replacement written by someone else");
    const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "sentinel.txt"), "must survive");
    const owned = join(work, `editkin-long-run-${runId}`); await createOwnedDirectoryV1(owned, runId); await journal.recordCreated(owned, "run-work-dir");
    await symlink(outside, join(owned, "linked"), junction);
    const receipt = await journal.cleanup({ releaseMs: 500 });
    expect(receipt.leftovers.map(item => item.path).sort()).toEqual([file, owned].sort());
    expect(receipt.leftovers.find(item => item.path === file)?.reason).toMatch(/identity changed/);
    expect(receipt.leftovers.find(item => item.path === owned)?.reason).toMatch(/link or junction/);
    expect(await readFile(file, "utf8")).toBe("replacement written by someone else");
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("must survive");
    expect(await exists(journal.path)).toBe(true);
    const ancestry = join(root, "via-junction"); await symlink(outside, ancestry, junction);
    expect(await removeJournaledPathV1({ path: join(ancestry, "sentinel.txt"), kind: "file", runId })).toMatchObject({ status: "leftover", reason: expect.stringMatching(/link or junction/) });
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("must survive");
    const foreign = join(root, "foreign-owner"); await createOwnedDirectoryV1(foreign, "99999999-0000-0000-0000-000000000000");
    expect(await removeJournaledPathV1({ path: foreign, kind: "output-staging-dir", runId })).toMatchObject({ status: "leftover", reason: expect.stringMatching(/owner record/) });
    expect(await exists(join(foreign, LONG_RENDER_OWNER_FILE))).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("keeps the owner record while another process still holds a file inside, then removes everything once released", async () => {
    const { work, journal, runId } = await setup("dddddddd-eeee-ffff-0000-111111111111");
    const owned = join(work, `editkin-long-run-${runId}`); await createOwnedDirectoryV1(owned, runId); await journal.recordCreated(owned, "run-work-dir");
    const held = join(owned, "held-by-killed-encoder.bin"); await writeFile(held, "partial output");
    await writeFile(join(owned, "other.bin"), "x");
    // A separate process opens the file without any sharing (like a closing encoder or a scanner) and holds it briefly.
    const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$f=[System.IO.File]::Open('${held}','Open','Read','None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 2500; $f.Close()`], { windowsHide: true });
    await new Promise<void>((done, fail) => { holder.stdout.on("data", chunk => { if (String(chunk).includes("locked")) done(); }); holder.once("error", fail); setTimeout(() => fail(Error("holder did not lock")), 20_000); });
    const record = journal.live().find(item => item.path === owned)!;
    const first = await removeJournaledPathV1(record);
    expect(first).toMatchObject({ status: "leftover", retryable: true });
    expect(await exists(join(owned, LONG_RENDER_OWNER_FILE))).toBe(true);
    await new Promise(done => holder.once("close", done));
    expect(await removeJournaledPathV1(record)).toEqual({ status: "removed" });
    expect(await exists(owned)).toBe(false);
  }, 60_000);

  it("accepts a missing owner record only when the journaled dev/ino identity still matches", async () => {
    const { work, journal, runId } = await setup("eeeeeeee-ffff-0000-1111-222222222222");
    const owned = join(work, "older-interrupted-pass"); await createOwnedDirectoryV1(owned, runId); await journal.recordCreated(owned, "output-staging-dir");
    await writeFile(join(owned, "left.bin"), "x"); await unlink(join(owned, LONG_RENDER_OWNER_FILE));
    const record = journal.live().find(item => item.path === owned)!;
    expect(await removeJournaledPathV1({ ...record, dev: undefined, ino: undefined })).toMatchObject({ status: "leftover", reason: expect.stringMatching(/owner record/) });
    expect(await removeJournaledPathV1(record)).toEqual({ status: "removed" });
  });

  it("replay retries a transiently busy path inside its window, and reports what never frees without touching its content", async () => {
    const { work, registry, journal } = await setup("cccccccc-dddd-eeee-ffff-000000000000");
    const busy = join(work, "released-late"); await mkdir(busy); await journal.recordCreated(busy, "dir");
    const stuck = join(work, "never-released"); await mkdir(stuck); await journal.recordCreated(stuck, "dir");
    const late = join(busy, "handle-still-open.bin"), held = join(stuck, "held.bin");
    await writeFile(late, "x"); await writeFile(held, "keep");
    const pointer = JSON.parse(await readFile(journal.pointerPath, "utf8"));
    await writeFile(journal.pointerPath, JSON.stringify({ ...pointer, pid: 999_998 }));
    setTimeout(() => { void unlink(late); }, 300);
    const replay = await replayLongRenderJournalsV1({ registryRoot: registry, isProcessAlive: () => false, retryMs: 1_500 });
    expect(replay.removed).toEqual([busy]);
    expect(replay.leftovers).toEqual([{ path: stuck, reason: expect.stringMatching(/ENOTEMPTY/) }]);
    expect(await exists(busy)).toBe(false);
    expect(await readFile(held, "utf8")).toBe("keep");
    expect(await exists(journal.path)).toBe(true);
    expect(await readdir(registry)).toEqual([`${journal.runId}.json`]);
  });

  it("replays only journals whose owner process on this host is gone, with the same exact-path checks", async () => {
    const { root, work, registry, journal, runId } = await setup("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const runDir = join(work, `editkin-long-run-${runId}`); await createOwnedDirectoryV1(runDir, runId); await journal.recordCreated(runDir, "run-work-dir");
    await writeFile(join(runDir, "frame.png"), "orphan");
    const keep = join(work, "unrelated.bin"); await writeFile(keep, "keep");
    // Crash stand-in: the pointer names an owner process that no longer exists.
    const pointer = JSON.parse(await readFile(journal.pointerPath, "utf8"));
    await writeFile(journal.pointerPath, JSON.stringify({ ...pointer, pid: 999_999 }));
    expect(await replayLongRenderJournalsV1({ registryRoot: registry, isProcessAlive: () => true })).toMatchObject({ skippedLive: 1, journals: 0, removed: [] });
    expect(await replayLongRenderJournalsV1({ registryRoot: registry, isProcessAlive: () => false, hostname: "another-host" })).toMatchObject({ skippedForeign: 1, removed: [] });
    expect(await exists(runDir)).toBe(true);
    const replay = await replayLongRenderJournalsV1({ registryRoot: registry, isProcessAlive: () => false });
    expect(replay).toMatchObject({ journals: 1, removed: [runDir], leftovers: [], failures: [] });
    expect(await exists(runDir)).toBe(false); expect(await exists(journal.path)).toBe(false);
    expect(await readdir(registry)).toEqual([]); expect(await readFile(keep, "utf8")).toBe("keep");
    expect(await exists(root)).toBe(true);
  });
});
