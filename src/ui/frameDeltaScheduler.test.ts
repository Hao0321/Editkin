import { describe, expect, it, vi } from "vitest";
import { createFrameDeltaScheduler } from "./frameDeltaScheduler";

function fixture() {
  let id = 0;
  const frames = new Map<number, () => void>();
  const onDelta = vi.fn();
  const batch = createFrameDeltaScheduler({ requestFrame: callback => { frames.set(++id,callback); return id; }, cancelFrame: value => { frames.delete(value); }, onDelta });
  return { batch, onDelta, frames, paint: () => { for (const [key,callback] of [...frames]) { frames.delete(key); callback(); } } };
}

describe("frame-coalesced panel movement", () => {
  it("reduces four pointer events per paint to one update with the identical position at every paint", () => {
    const f=fixture();
    let immediate=0, batched=0;
    f.onDelta.mockImplementation(delta => { batched += delta; });
    for(let frame=0;frame<60;frame++) {
      for(const delta of [4,-1,2,3]) { immediate += delta; f.batch.add(delta); }
      f.paint();
      expect(batched).toBe(immediate);
    }
    expect(f.onDelta).toHaveBeenCalledTimes(60);
    expect(immediate).toBe(480);
    expect(f.frames.size).toBe(0);
  });

  it("flushes the final movement immediately on pointer release and cannot apply it twice", () => {
    const f=fixture();
    f.batch.add(5); f.batch.add(-2); f.batch.flush(); f.batch.flush(); f.paint();
    expect(f.onDelta).toHaveBeenCalledExactlyOnceWith(3);
    expect(f.frames.size).toBe(0);
  });

  it("drops queued movement after unmount and ignores invalid deltas", () => {
    const f=fixture();
    f.batch.add(10); f.batch.cancel(); f.batch.add(NaN); f.batch.add(Infinity); f.batch.add(0); f.paint();
    expect(f.onDelta).not.toHaveBeenCalled();
    expect(f.frames.size).toBe(0);
  });

  it("preserves a direction reversal without a redundant zero movement", () => {
    const f=fixture(); f.batch.add(8); f.batch.add(-8); f.paint();
    expect(f.onDelta).not.toHaveBeenCalled();
    f.batch.add(-4); f.paint(); expect(f.onDelta).toHaveBeenCalledExactlyOnceWith(-4);
  });
});
