import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { runRawVideoProcessV1 } from "./rawVideoProcessV1";
import { withRenderLifetime } from "./renderLifetime";

const temp = useTempRoots();
let root = "";
beforeAll(async () => { root = await temp.create("raw-video-process-"); });
const idle = "setInterval(()=>{},1000)";
function producer(script: string, name: string) {
  const pidFile = join(root, name + ".pid");
  return { executable: process.execPath, args: ["-e", `require('node:fs').writeFileSync(process.argv[1],String(process.pid));${script}`, pidFile],
    timeoutMs: 10_000, frameBytes: 4, expectedFrames: 2, pidFile };
}
async function expectClosed(pidFile: string) {
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}

describe("raw stdout producer with one awaited frame", () => {
  it("assembles split frames in order and never calls a slow consumer concurrently", async () => {
    const input = producer("process.stdout.write(Buffer.from([1,2,3]));setTimeout(()=>process.stdout.end(Buffer.from([4,5,6,7,8])),10)", "success");
    const frames: Uint8Array[] = [], indexes: number[] = []; let active = 0, peak = 0;
    const result = await runRawVideoProcessV1({ ...input, sink: { async onFrame(frame, index) {
      active++; peak = Math.max(peak, active); indexes.push(index);
      await new Promise(resolve => setTimeout(resolve, 15)); frames.push(frame); active--;
    } } });
    expect(frames.map(frame => [...frame])).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    expect(indexes).toEqual([0, 1]); expect(peak).toBe(1);
    expect(result).toMatchObject({ frames: 2, bytes: 8, maximumPendingFrames: 1, closed: true });
    await expectClosed(input.pidFile);
  });

  it.each([[4, "PREMATURE_EOF"], [7, "PREMATURE_EOF"], [9, "FRAME_OVERRUN"], [12, "FRAME_OVERRUN"]])("rejects a %i-byte stream with %s", async (length, error) => {
    const input = producer(`process.stdout.end(Buffer.alloc(${length}));`, "length-" + length);
    await expect(runRawVideoProcessV1({ ...input, sink: { async onFrame() {} } })).rejects.toThrow(error);
    await expectClosed(input.pidFile);
  });

  it("retains the consumer failure and waits for the owned producer to close", async () => {
    const input = producer("process.stdout.write(Buffer.alloc(4));" + idle, "consumer-failed"), reason = Error("ENCODER_REJECTED_FRAME");
    await expect(runRawVideoProcessV1({ ...input, sink: { async onFrame() { throw reason; } } })).rejects.toBe(reason);
    await expectClosed(input.pidFile);
  });

  it("cancels while a consumer never resolves, including a parent render abort", async () => {
    const input = producer("process.stdout.write(Buffer.alloc(4));" + idle, "cancel"), controller = new AbortController(), reason = Error("USER_CANCELLED");
    let observed: AbortSignal | undefined;
    await expect(withRenderLifetime({ signal: controller.signal, timeoutMs: 5_000 }, () => runRawVideoProcessV1({ ...input,
      sink: { async onFrame(_frame, _index, signal) { observed = signal; controller.abort(reason); await new Promise<void>(() => {}); } } }))).rejects.toBe(reason);
    expect(observed?.aborted).toBe(true); await expectClosed(input.pidFile);
  });

  it("detects a stalled consumer even if the producer has already exited successfully", async () => {
    const input = producer("process.stdout.end(Buffer.alloc(8));", "stalled-consumer"); let entered = false;
    await expect(runRawVideoProcessV1({ ...input, stallMs: 800,
      sink: { async onFrame() { entered = true; await new Promise<void>(() => {}); } } })).rejects.toThrow("RAW_VIDEO_STALLED");
    expect(entered).toBe(true); await expectClosed(input.pidFile);
  });

  it("stops a producer that never writes without extending the inherited deadline", async () => {
    const input = producer(idle, "deadline");
    await expect(runRawVideoProcessV1({ ...input, timeoutMs: 700, sink: { async onFrame() {} } })).rejects.toThrow("RAW_VIDEO_DEADLINE");
    await expectClosed(input.pidFile);
  });

  it("rejects a failed child with a bounded diagnostic tail", async () => {
    const input = producer("process.stderr.write('x'.repeat(400000),()=>process.exit(7));", "child-error");
    const error = await runRawVideoProcessV1({ ...input, sink: { async onFrame() {} } }).catch(error => error);
    expect(error.message).toContain("RAW_VIDEO_PROCESS_FAILED: 7");
    expect(error.message.length).toBeLessThan(66_000); await expectClosed(input.pidFile);
  });

  it("refuses a pre-aborted consumer before launching anything", async () => {
    const controller = new AbortController(), reason = Error("EARLY_CANCEL"); controller.abort(reason);
    await expect(runRawVideoProcessV1({ executable: "must-not-launch", args: [], timeoutMs: 500, frameBytes: 4, expectedFrames: 2,
      sink: { signal: controller.signal, async onFrame() {} } })).rejects.toBe(reason);
  });

  it.each([0, -1, NaN, 256 * 1024 ** 2 + 1])("refuses invalid frame bytes %s before spawn", async frameBytes => {
    await expect(runRawVideoProcessV1({ executable: "must-not-launch", args: [], timeoutMs: 500, frameBytes, expectedFrames: 2,
      sink: { async onFrame() {} } })).rejects.toThrow("RAW_VIDEO_BUDGET_INVALID");
  });
});
