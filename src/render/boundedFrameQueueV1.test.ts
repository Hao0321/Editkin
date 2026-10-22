import { describe, expect, it } from "vitest";
import { boundedFrameQueueV1 } from "./boundedFrameQueueV1";

describe("bounded producer/encoder queue", () => {
  it("back-pressures a full queue and preserves every item and EOF", async () => {
    const queue = boundedFrameQueueV1<number>(2); await queue.push(0); await queue.push(1);
    let accepted = false; const waiting = queue.push(2).then(() => { accepted = true; });
    await Promise.resolve(); expect(accepted).toBe(false);
    expect(await queue.shift()).toBe(0); await waiting; queue.end();
    expect(await queue.shift()).toBe(1); expect(await queue.shift()).toBe(2); expect(await queue.shift()).toBeUndefined();
    expect(queue.receipt.peakQueuedFrames).toBe(2);
  });
  it("supports a zero-capacity rendezvous for a two-frame total memory limit", async () => {
    const queue = boundedFrameQueueV1<number>(0); let accepted = false;
    const writer = queue.push(8).then(() => { accepted = true; }); await Promise.resolve(); expect(accepted).toBe(false);
    expect(await queue.shift()).toBe(8); await writer; queue.end(); expect(await queue.shift()).toBeUndefined();
    expect(queue.receipt.peakQueuedFrames).toBe(0);
  });
  it("rejects both blocked readers and blocked writers with the original failure", async () => {
    const reason = Error("CANCEL_ALL"), readerQueue = boundedFrameQueueV1<number>(1), writerQueue = boundedFrameQueueV1<number>(0);
    const read = readerQueue.shift(), write = writerQueue.push(1);
    readerQueue.fail(reason); writerQueue.fail(reason);
    await expect(read).rejects.toBe(reason); await expect(write).rejects.toBe(reason);
    await expect(readerQueue.push(2)).rejects.toBe(reason);
  });
  it("refuses invalid capacity, concurrent writers and ending before a pending frame is accepted", async () => {
    expect(() => boundedFrameQueueV1(-1)).toThrow("FRAME_QUEUE_CAPACITY_INVALID");
    const queue = boundedFrameQueueV1<number>(0), pending = queue.push(1);
    await expect(queue.push(2)).rejects.toThrow("FRAME_QUEUE_WRITE_REFUSED"); expect(() => queue.end()).toThrow("FRAME_QUEUE_END_REFUSED");
    expect(await queue.shift()).toBe(1); await pending; queue.end();
  });
});
