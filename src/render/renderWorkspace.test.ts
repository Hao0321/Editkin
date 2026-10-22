import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { removeTempRoot, useTempRoots } from "../test/tempRoot.mjs";
import {
  createRenderWorkDirectory,
  currentRenderWorkRoot,
  isRenderWorkDirectoryName,
  removeRenderWorkDirectory,
  RENDER_WORK_ROOT_NAME,
  sweepStaleRenderWorkDirectories,
  withRenderWorkRoot,
} from "./renderWorkspace";

// Every root in this file is a fresh scratch directory; the real OS temp folder is never swept here.
// Each test's roots are removed when it finishes; junctions are unlinked as links first.
const temp = useTempRoots();
async function scratch() { return temp.create("editkin-work-sweep-test-"); }
const DAY = 24 * 60 * 60_000;
async function age(path: string, milliseconds: number) { const when = new Date(Date.now() - milliseconds); await utimes(path, when, when); }
async function ownedDirectory(root: string, name: string, owner?: { pid: number; host: string }, ageMs = 0) {
  const directory = join(root, name);
  await mkdir(directory);
  await writeFile(join(directory, "captions.ass"), "[Script Info]\n");
  if (owner) await writeFile(join(directory, ".editkin-render-work-owner.json"), JSON.stringify({ schema: "editkin.render-work-owner/v1", ...owner, createdAt: new Date().toISOString() }));
  if (ageMs) {
    for (const entry of await readdir(directory)) await age(join(directory, entry), ageMs);
    await age(directory, ageMs);
  }
  return directory;
}
const exists = (path: string) => stat(path).then(() => true, () => false);
const deadPid = () => {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
};

describe("render work directory location", () => {
  it("puts work next to the output in a hidden folder with an owner record, and removes the folder afterwards", async () => {
    const outputDirectory = await scratch();
    const output = join(outputDirectory, "film.mp4");
    let created = "";
    await withRenderWorkRoot(output, undefined, async () => {
      expect(currentRenderWorkRoot()).toBe(join(outputDirectory, RENDER_WORK_ROOT_NAME));
      created = await createRenderWorkDirectory("editkin-render-");
      expect(dirname(created)).toBe(join(outputDirectory, RENDER_WORK_ROOT_NAME));
      expect(isRenderWorkDirectoryName(basename(created))).toBe(true);
      const owner = JSON.parse(await readFile(join(created, ".editkin-render-work-owner.json"), "utf8"));
      expect(owner).toMatchObject({ schema: "editkin.render-work-owner/v1", pid: process.pid, host: hostname() });
      await removeRenderWorkDirectory(created);
    });
    expect(await exists(created)).toBe(false);
    expect(await exists(join(outputDirectory, RENDER_WORK_ROOT_NAME))).toBe(false);
    expect(currentRenderWorkRoot()).toBeUndefined();
  });

  it("uses a configured work root and never removes it", async () => {
    const outputDirectory = await scratch(), configured = await scratch();
    await withRenderWorkRoot(join(outputDirectory, "film.mp4"), configured, async () => {
      const created = await createRenderWorkDirectory("editkin-precomp-");
      expect(dirname(created)).toBe(configured);
      await removeRenderWorkDirectory(created);
    });
    expect(await exists(configured)).toBe(true);
    expect(await exists(join(outputDirectory, RENDER_WORK_ROOT_NAME))).toBe(false);
  });

  it("falls back to the OS temp folder when the hidden folder is a file or a link, without touching either", async () => {
    const outputDirectory = await scratch(), target = await scratch();
    await writeFile(join(outputDirectory, RENDER_WORK_ROOT_NAME), "user file");
    await withRenderWorkRoot(join(outputDirectory, "a.mp4"), undefined, async () => expect(currentRenderWorkRoot()).toBe(tmpdir()));
    expect(await readFile(join(outputDirectory, RENDER_WORK_ROOT_NAME), "utf8")).toBe("user file");
    const linked = await scratch();
    await writeFile(join(target, "keep.txt"), "target");
    await symlink(target, join(linked, RENDER_WORK_ROOT_NAME), "junction");
    await withRenderWorkRoot(join(linked, "b.mp4"), undefined, async () => expect(currentRenderWorkRoot()).toBe(tmpdir()));
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("target");
    await removeTempRoot(linked); // cleanup unlinks the junction; the other root it points to survives
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("target");
  });

  it("recognizes only exact work-directory names", () => {
    for (const name of ["editkin-render-8gHvUb", "editkin-precomp-AAAAAA", "editkin-resident-aces2-video-x1Y2z3", "editkin-filtergraph-000000"]) expect(isRenderWorkDirectoryName(name)).toBe(true);
    for (const name of ["editkin-render-tools-runtime-AbC123", "editkin-render-identity-real-AbC123", "editkin-render-AbC12", "editkin-render-AbC1234",
      "editkin-plugin-test-AbC123", "Editkin-render-AbC123", "editkin-render-AbC-12", ".editkin-render-work", "editkin-render-"]) expect(isRenderWorkDirectoryName(name)).toBe(false);
  });
});

describe("stale render work sweep", () => {
  it("removes only orphaned directories this code created and keeps everything else", async () => {
    const root = await scratch();
    const host = hostname(), livePid = 4242, dead = deadPid();
    const legacyOld = await ownedDirectory(root, "editkin-render-Legcy1", undefined, 2 * DAY);
    const legacyYoung = await ownedDirectory(root, "editkin-render-Legcy2");
    const orphan = await ownedDirectory(root, "editkin-precomp-Orphn1", { pid: dead, host }, 60 * 60_000);
    const orphanGrace = await ownedDirectory(root, "editkin-precomp-Orphn2", { pid: dead, host }, 60_000);
    const live = await ownedDirectory(root, "editkin-aces2-sdr-Live01", { pid: livePid, host }, 3 * DAY);
    const foreignRecent = await ownedDirectory(root, "editkin-mesh3d-Frgn01", { pid: livePid, host: "another-pc" }, 2 * DAY);
    const foreignOld = await ownedDirectory(root, "editkin-mesh3d-Frgn02", { pid: livePid, host: "another-pc" }, 8 * DAY);
    const recentlyTouched = await ownedDirectory(root, "editkin-render-Touch1", undefined, 2 * DAY);
    await writeFile(join(recentlyTouched, "captions.ass"), "still being written");
    const lookalikes = await Promise.all(["editkin-render-tools-runtime-AbC123", "editkin-render-identity-real-AbC123", "editkin-plugin-test-AbC123", "unrelated"]
      .map(name => ownedDirectory(root, name, undefined, 30 * DAY)));
    const file = join(root, "editkin-render-File01");
    await writeFile(file, "not a directory"); await age(file, 30 * DAY);
    const target = await scratch();
    await writeFile(join(target, "precious.txt"), "keep");
    const link = join(root, "editkin-render-Link01");
    await symlink(target, link, "junction");

    const result = await sweepStaleRenderWorkDirectories([root, "relative/root", join(root, "missing")], { isProcessAlive: pid => pid === livePid });
    expect(result.removed.sort()).toEqual([legacyOld, orphan, foreignOld].sort());
    expect(result.failures).toEqual([]);
    for (const path of [legacyYoung, orphanGrace, live, foreignRecent, recentlyTouched, ...lookalikes, file, link]) expect(await exists(path)).toBe(true);
    expect(await readFile(join(target, "precious.txt"), "utf8")).toBe("keep");
    await removeTempRoot(root); // cleanup unlinks the junction; the other root it points to survives
    expect(await readFile(join(target, "precious.txt"), "utf8")).toBe("keep");
  });

  it("never removes a directory that a live export in this process is using", async () => {
    const root = await scratch();
    await withRenderWorkRoot(join(root, "film.mp4"), root, async () => {
      const active = await createRenderWorkDirectory("editkin-render-");
      for (const entry of await readdir(active)) await age(join(active, entry), 30 * DAY);
      await age(active, 30 * DAY);
      const result = await sweepStaleRenderWorkDirectories([root], { now: Date.now() + 365 * DAY, isProcessAlive: () => false });
      expect(result.removed).toEqual([]);
      expect(await exists(active)).toBe(true);
      await removeRenderWorkDirectory(active);
    });
  });

  it("cleans stale leftovers in the hidden folder before a render starts", async () => {
    const outputDirectory = await scratch();
    const hidden = join(outputDirectory, RENDER_WORK_ROOT_NAME);
    await mkdir(hidden);
    const stale = await ownedDirectory(hidden, "editkin-render-Crash1", undefined, 3 * DAY);
    const fresh = await ownedDirectory(hidden, "editkin-render-Fresh1");
    const other = await ownedDirectory(hidden, "keep-me", undefined, 30 * DAY);
    await withRenderWorkRoot(join(outputDirectory, "film.mp4"), undefined, async () => {
      expect(await exists(stale)).toBe(false);
    });
    expect(await exists(fresh)).toBe(true);
    expect(await exists(other)).toBe(true);
    expect(await exists(hidden)).toBe(true);
  });
});
