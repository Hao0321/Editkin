import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { runProcess } from "./mediaProcess";
import { declaredHelperTemporaryRootV1, helperProcessEnvironmentV1, withHelperTemporaryRootV1 } from "./helperProcessEnvironmentV1";
import { timeRemapCacheRootV1 } from "./timeRemapCacheStoreV1";

/** The speed export declares TEMP/TMP for its own helper processes instead of changing process.env (W2-4). */
const temp = resolve(process.env.TEMP!);
let folder: string;
beforeEach(async () => { folder = await mkdtemp(join(temp, "helper-env-")); });
afterEach(async () => { if (!folder.startsWith(temp + sep)) throw Error("cleanup outside owned TEMP"); await rm(folder, { recursive: true, force: true }); });

describe("declared helper TEMP", () => {
  it("helper processes inside the operation see the declared root; process.env and later spawns are untouched", async () => {
    const helper = join(folder, "helper-temp"); await mkdir(helper);
    const print = () => runProcess(process.execPath, ["-e", "process.stdout.write(`${process.env.TEMP}|${process.env.TMP}`)"], 30_000);
    expect(helperProcessEnvironmentV1()).toBeUndefined();
    const inside = await withHelperTemporaryRootV1(helper, async () => { expect(declaredHelperTemporaryRootV1()).toBe(resolve(helper)); return (await print()).stdout; });
    expect(inside).toBe(`${resolve(helper)}|${resolve(helper)}`);
    expect(process.env.TEMP).toBe(temp);
    expect((await print()).stdout).toBe(`${process.env.TEMP}|${process.env.TMP}`);
  });

  it("the speed cache accepts a declared helper root on the project volume and still refuses an undeclared one", async () => {
    const helper = join(folder, "helper-temp"); await mkdir(helper);
    await expect(timeRemapCacheRootV1(folder, helper)).rejects.toThrow("TEMP_ENV");
    expect(await withHelperTemporaryRootV1(helper, () => timeRemapCacheRootV1(folder, helper))).toBe(join(folder, ".editkin", "time-remap-v1"));
    await expect(withHelperTemporaryRootV1(join(folder, "other"), () => timeRemapCacheRootV1(folder, helper))).rejects.toThrow("TEMP_ENV");
  });
});
