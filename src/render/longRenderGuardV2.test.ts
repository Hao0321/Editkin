import { mkdir, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createLongRenderSpaceGuardV2, ownedTreeBytesV2 } from "./longRenderGuardV2";
import { resolveLongRenderPolicyV1 } from "./longRenderPolicyV1";
import { isLongRenderRefusalV1, type LongRenderPolicyOverrideV1, type LongRenderRefusalV1 } from "./longRenderContractsV1";

const MIB = 1024 ** 2, GIB = 1024 ** 3;
const temp = useTempRoots();

/** Controlled volume stub: paths under a registered prefix report that volume's (mutable) free bytes. */
function volumes() {
  const table: Array<{ prefix: string; key: string; root: string; availableBytes: number }> = [];
  return {
    add(prefix: string, key: string, availableBytes: number) { const row = { prefix: prefix.toLowerCase(), key, root: `${key}:\\`, availableBytes }; table.push(row); return row; },
    probe: async (path: string) => { const row = table.find(item => path.toLowerCase().startsWith(item.prefix)); return row ? { key: row.key, root: row.root, availableBytes: row.availableBytes } : undefined; },
  };
}

async function setup(free: number, policyOverride: LongRenderPolicyOverrideV1 = {}, systemFree = 50 * GIB) {
  const root = await temp.create("long-guard-");
  const output = join(root, "output"), work = join(root, "work");
  await mkdir(output); await mkdir(work);
  const stub = volumes(), data = stub.add(root, "X", free), system = stub.add("S:\\", "S", systemFree);
  const failures: LongRenderRefusalV1[] = [], warnings: string[] = [];
  const policy = resolveLongRenderPolicyV1(policyOverride, 16 * GIB);
  const guard = createLongRenderSpaceGuardV2({ rows: [{ path: output, role: "output" }, { path: work, role: "work" }, { path: "S:\\Windows", role: "system" }],
    policy, stagingRoots: [work], outputRoots: [output], probe: stub.probe, onFailure: error => failures.push(error), onWarning: message => warnings.push(message) });
  return { root, output, work, data, system, failures, warnings, policy, guard, stub };
}

const until = async (condition: () => boolean, timeoutMs: number) => {
  const started = performance.now();
  while (!condition() && performance.now() - started < timeoutMs) await new Promise(done => setTimeout(done, 5));
  return performance.now() - started;
};

describe("long-render space guard v2", () => {
  it("admits by final-size estimate plus reserve and refuses short or unmeasurable volumes before work starts", async () => {
    const ok = await setup(5 * GIB);
    const admitted = await ok.guard.admit({ outputBytes: 2 * GIB, workBytes: 272 * MIB });
    expect(admitted.volumes.find(row => row.root === "X:\\")?.neededBytes).toBe(Math.ceil((2 * GIB + 272 * MIB) * 1.15) + GIB);
    const short = await setup(3 * GIB);
    await expect(short.guard.admit({ outputBytes: 2 * GIB, workBytes: 272 * MIB })).rejects.toMatchObject({ code: "LONG_RENDER_SPACE_SHORT", details: expect.objectContaining({ admission: true }) });
    expect(short.failures).toHaveLength(1);
    const system = await setup(50 * GIB, {}, GIB);
    await expect(system.guard.admit({ outputBytes: GIB, workBytes: 0 })).rejects.toMatchObject({ code: "LONG_RENDER_SPACE_SHORT", details: expect.objectContaining({ root: "S:\\" }) });
    const unknown = await setup(5 * GIB);
    unknown.data.prefix = "no-such-volume";
    await expect(unknown.guard.admit({ outputBytes: 0, workBytes: 0 })).rejects.toMatchObject({ code: "LONG_RENDER_VOLUME_UNKNOWN" });
  });

  it("re-measures as soon as 64 MiB are written by anyone, well before the interval, and stops on the burst projection", async () => {
    const run = await setup(3 * GIB, { measureIntervalMs: 60_000, fastPollMs: 10, stopLatencyMs: 200 });
    await run.guard.admit({ outputBytes: 0, workBytes: 0 });
    run.guard.start();
    const writer = setInterval(() => { run.data.availableBytes -= 16 * MIB; }, 5);
    const elapsed = await until(() => run.failures.length > 0, 5_000);
    clearInterval(writer); await run.guard.stop();
    expect(run.failures[0]).toMatchObject({ code: "LONG_RENDER_SPACE_SHORT" });
    expect(elapsed).toBeLessThan(5_000);
    expect(run.guard.receipt.triggeredByBytes).toBeGreaterThanOrEqual(1);
    expect(run.guard.receipt.fullMeasures).toBeLessThanOrEqual(run.guard.receipt.triggeredByBytes);
    expect(run.data.availableBytes).toBeGreaterThan(GIB);
    expect(run.guard.receipt.stopReason).toMatch(/LONG_RENDER_SPACE_SHORT/);
  });

  it("stops a steady writer while the free space still holds the reserve (burst = peak rate x (interval + stop latency))", async () => {
    const run = await setup(GIB + 400 * MIB, { measureIntervalMs: 200, fastPollMs: 10, stopLatencyMs: 300 });
    await run.guard.admit({ outputBytes: 0, workBytes: 0 });
    run.guard.start();
    const startFree = run.data.availableBytes, started = performance.now();
    const writer = setInterval(() => { run.data.availableBytes -= MIB; }, 10);
    await until(() => run.failures.length > 0, 25_000);
    clearInterval(writer); await run.guard.stop();
    const receipt = run.guard.receipt, error = run.failures[0];
    // The burst uses a windowed rate: timer jitter between two fast polls must not inflate it (no premature stop).
    const actualRate = (startFree - run.data.availableBytes) / ((performance.now() - started) / 1000);
    expect(receipt.volumes.find(volume => volume.root === "X:\\")!.peakWriteBytesPerSecond).toBeLessThan(3 * actualRate);
    expect(error).toMatchObject({ code: "LONG_RENDER_SPACE_SHORT" });
    expect(Number(error.details.freeBytes)).toBeGreaterThanOrEqual(GIB);
    expect(Number(error.details.freeBytes)).toBeLessThan(GIB + Number(error.details.burstBytes));
    expect(receipt.peakBurstBytes).toBeGreaterThanOrEqual(64 * MIB);
    expect(receipt.volumes.find(volume => volume.root === "X:\\")?.minFreeBytes).toBeGreaterThanOrEqual(GIB);
  }, 30_000);

  it("measures the burst per volume: a fast writer on the system volume does not stop a render whose output volume holds its reserve", async () => {
    const run = await setup(GIB + 200 * MIB, { measureIntervalMs: 200, fastPollMs: 10, stopLatencyMs: 200 }, 50 * GIB);
    await run.guard.admit({ outputBytes: 0, workBytes: 0 });
    run.guard.start();
    const writer = setInterval(() => { run.system.availableBytes -= 32 * MIB; }, 10);
    await new Promise(done => setTimeout(done, 1_500));
    clearInterval(writer); await run.guard.stop();
    expect(run.failures).toEqual([]);
    const receipt = run.guard.receipt;
    expect(receipt.volumes.find(volume => volume.root === "S:\\")!.peakWriteBytesPerSecond).toBeGreaterThan(GIB / 4);
    expect(receipt.volumes.find(volume => volume.root === "X:\\")!.peakWriteBytesPerSecond).toBe(0);
    expect(receipt.fullMeasures).toBeGreaterThan(0);
  });

  it("never fails a walk because an owned transient frame or workspace vanished mid-walk (stream v2 deletes each PNG)", async () => {
    const root = await temp.create("long-guard-walk-race-");
    const sequence = join(root, "workspace", "display-sequence"); await mkdir(sequence, { recursive: true });
    let stop = false;
    const producer = (async () => {
      for (let frame = 0; !stop; frame += 1) {
        const path = join(sequence, `frame-${String(frame).padStart(8, "0")}.png`);
        await writeFile(path, Buffer.alloc(16 * 1024)); await unlink(path);
        if (frame % 10 === 0) { const nested = join(root, "workspace", `editkin-filtergraph-${frame}`); await mkdir(nested); await rmdir(nested); }
      }
    })();
    let walks = 0;
    try {
      const started = performance.now();
      while (performance.now() - started < 3_000) { await ownedTreeBytesV2([join(root, "workspace")]); walks += 1; }
    } finally { stop = true; await producer; }
    expect(walks).toBeGreaterThan(100);
  }, 30_000);

  it("keeps owned staging under the cap and refuses a link or junction inside it", async () => {
    const run = await setup(50 * GIB, { stagingCapBytes: MIB });
    await run.guard.admit({ outputBytes: 0, workBytes: 0 });
    await writeFile(join(run.work, "staged.bin"), Buffer.alloc(512 * 1024));
    await run.guard.check("small");
    expect(run.guard.receipt.peakStagingBytes).toBe(512 * 1024);
    await writeFile(join(run.work, "staged-2.bin"), Buffer.alloc(768 * 1024));
    await expect(run.guard.check("over-cap")).rejects.toMatchObject({ code: "LONG_RENDER_STAGING_LIMIT" });
    const linked = await setup(50 * GIB);
    await linked.guard.admit({ outputBytes: 0, workBytes: 0 });
    const outside = join(linked.root, "outside"); await mkdir(outside);
    await symlink(outside, join(linked.work, "junction"), process.platform === "win32" ? "junction" : "dir");
    await expect(linked.guard.check("link")).rejects.toMatchObject({ code: "LONG_RENDER_WORK_ROOT_REPARSE" });
  });

  it("triggers on writer-reported bytes and raises a visible projected-shortfall warning without stopping", async () => {
    const run = await setup(50 * GIB);
    await run.guard.admit({ outputBytes: 0, workBytes: 0 });
    run.guard.observeWrittenBytes("encoder", 70 * MIB);
    await until(() => run.guard.receipt.fullMeasures > 0, 2_000);
    expect(run.guard.receipt.fullMeasures).toBe(1);
    expect(run.guard.receipt.triggeredByBytes).toBe(1);
    const warn = await setup(3 * GIB);
    const guard = createLongRenderSpaceGuardV2({ rows: [{ path: warn.output, role: "output" }, { path: warn.work, role: "work" }], policy: warn.policy,
      stagingRoots: [warn.work], probe: warn.stub.probe, onFailure: error => warn.failures.push(error), onWarning: message => warn.warnings.push(message),
      remainingOutputBytes: () => 5 * GIB });
    await guard.admit({ outputBytes: 0, workBytes: 0 });
    await guard.check("one"); await guard.check("two");
    expect(warn.failures).toHaveLength(0);
    expect(warn.warnings).toHaveLength(1);
    expect(warn.warnings[0]).toMatch(/LONG_RENDER_SPACE_PROJECTED_SHORTFALL/);
    expect(guard.receipt.warnings).toEqual(warn.warnings);
    expect(isLongRenderRefusalV1(undefined)).toBe(false);
  });
});
