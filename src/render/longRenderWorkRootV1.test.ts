import { mkdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { RENDER_WORK_ROOT_ENV, RENDER_WORK_ROOT_NAME, selectLongRenderWorkRootV1 } from "./renderWorkspace";

const temp = useTempRoots();
const measured = async (path: string) => ({ root: path.slice(0, 3), availableBytes: 100 * 1024 ** 3 });
let saved: string | undefined;
beforeEach(() => { saved = process.env[RENDER_WORK_ROOT_ENV]; delete process.env[RENDER_WORK_ROOT_ENV]; });
afterEach(() => { if (saved === undefined) delete process.env[RENDER_WORK_ROOT_ENV]; else process.env[RENDER_WORK_ROOT_ENV] = saved; });

describe("LONG work-root policy (Q-L8: never the OS temp, no silent fallback)", () => {
  it("uses the hidden folder beside the output, or an explicitly configured absolute root", async () => {
    const root = await temp.create("long-workroot-");
    const beside = await selectLongRenderWorkRootV1({ outputPath: join(root, "out", "film.mp4"), probe: measured });
    expect(beside).toMatchObject({ root: join(root, "out", RENDER_WORK_ROOT_NAME), source: "beside-output" });
    expect((await stat(beside.root)).isDirectory()).toBe(true);
    const configured = await selectLongRenderWorkRootV1({ outputPath: join(root, "out", "film.mp4"), configuredRoot: join(root, "configured"), probe: measured });
    expect(configured).toMatchObject({ root: join(root, "configured"), source: "configured" });
    process.env[RENDER_WORK_ROOT_ENV] = join(root, "from-env");
    expect(await selectLongRenderWorkRootV1({ outputPath: join(root, "film.mp4"), probe: measured })).toMatchObject({ root: join(root, "from-env"), source: "configured" });
  });

  it("refuses the OS temp folder, relative roots, junction ancestry and unmeasured volumes with stable codes", async () => {
    const root = await temp.create("long-workroot-");
    await expect(selectLongRenderWorkRootV1({ outputPath: join(root, "a.mp4"), configuredRoot: tmpdir(), probe: measured })).rejects.toMatchObject({ code: "LONG_RENDER_WORK_ROOT_SYSTEM_TEMP" });
    await expect(selectLongRenderWorkRootV1({ outputPath: join(root, "a.mp4"), configuredRoot: "relative/work", probe: measured })).rejects.toMatchObject({ code: "LONG_RENDER_WORK_ROOT_UNAVAILABLE" });
    const target = join(root, "real"); await mkdir(target);
    const link = join(root, "linked"); await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    await expect(selectLongRenderWorkRootV1({ outputPath: join(root, "a.mp4"), configuredRoot: join(link, "work"), probe: measured })).rejects.toMatchObject({ code: "LONG_RENDER_WORK_ROOT_REPARSE" });
    await expect(selectLongRenderWorkRootV1({ outputPath: join(link, "out", "a.mp4"), probe: measured })).rejects.toMatchObject({ code: "LONG_RENDER_WORK_ROOT_REPARSE" });
    await expect(selectLongRenderWorkRootV1({ outputPath: join(root, "a.mp4"), probe: async () => undefined })).rejects.toMatchObject({ code: "LONG_RENDER_VOLUME_UNKNOWN" });
  });
});
