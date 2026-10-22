import { describe, expect, it, vi } from "vitest";
import { colorComparisonGeometryV1, createColorComparisonV1, drawColorComparisonV1, seekColorScopeSourceV1, type ComparisonMediaV1 } from "./colorGradeComparisonV1";
function canvas(width = 64, height = 36) {
  const ctx = { clearRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(), fillStyle: "" };
  const element = { width, height, dataset: {} as Record<string, string>, getContext: vi.fn(() => ctx) } as unknown as HTMLCanvasElement;
  return { element, ctx };
}
const image = (): ComparisonMediaV1 => ({ tagName: "IMG", complete: true, naturalWidth: 64, naturalHeight: 36 } as HTMLImageElement);
describe("bounded, paired color comparison", () => {
  it("keeps aspect and surface caps for landscape, portrait and small inputs", () => {
    expect(colorComparisonGeometryV1(3840, 2160, .5)).toEqual({ width: 1280, height: 720, boundary: 640 });
    expect(colorComparisonGeometryV1(1080, 1920, .25)).toEqual({ width: 405, height: 720, boundary: 101 });
    expect(colorComparisonGeometryV1(64, 36, 0).boundary).toBe(0); expect(colorComparisonGeometryV1(64, 36, 1).boundary).toBe(64);
    expect(() => colorComparisonGeometryV1(0, 36, .5)).toThrow(); expect(() => colorComparisonGeometryV1(64, 36, NaN)).toThrow();
  });
  it("clips only the graded right-hand region and leaves exact endpoints without a divider", () => {
    const raw = canvas(), output = canvas(), graded = canvas();
    drawColorComparisonV1(output.element, raw.element, graded.element, .25);
    expect(output.ctx.rect).toHaveBeenLastCalledWith(16, 0, 48, 36); expect(output.element.dataset.comparisonBoundary).toBe("16");
    expect(output.ctx.drawImage.mock.calls.map(c => c[0])).toEqual([raw.element, graded.element]);
    expect(output.ctx.save).toHaveBeenCalledTimes(1); expect(output.ctx.restore).toHaveBeenCalledTimes(1);
    output.ctx.fillRect.mockClear(); drawColorComparisonV1(output.element, raw.element, graded.element, 0); drawColorComparisonV1(output.element, raw.element, graded.element, 1);
    expect(output.ctx.fillRect).not.toHaveBeenCalled();
    expect(() => drawColorComparisonV1(output.element, canvas(32, 18).element, graded.element, .5)).toThrow(/differ/);
  });
  it("does no source copying while off, then reuses one snapshot for slider changes", () => {
    const raw = canvas(1, 1), output = canvas(1, 1), graded = canvas(), source = image(), ready = vi.fn();
    const control = createColorComparisonV1(() => raw.element, () => output.element, ready);
    control.receive(graded.element, source); expect(raw.ctx.drawImage).not.toHaveBeenCalled();
    control.setMode(true, .5); control.setMode(true, .25); control.setMode(true, .75);
    expect(raw.ctx.drawImage).toHaveBeenCalledTimes(1); expect(raw.ctx.drawImage.mock.calls[0][0]).toBe(source); expect(output.element.dataset.comparisonBoundary).toBe("48");
    control.setMode(false, .5); expect(raw.element.width).toBe(1); expect(output.element.width).toBe(1);
    control.clear(); control.setMode(true, .5); expect(output.element.dataset.comparisonStatus).toBe("waiting");
  });
  it("rejects seeking/playing or a changed media clock until a fresh paused GPU callback", () => {
    const raw = canvas(1, 1), output = canvas(1, 1), graded = canvas(), ready = vi.fn();
    const video = { tagName: "VIDEO", currentTime: 0, paused: true, seeking: true, readyState: 4 };
    const control = createColorComparisonV1(() => raw.element, () => output.element, ready);
    control.receive(graded.element, video as HTMLVideoElement); control.setMode(true, .5); expect(raw.ctx.drawImage).not.toHaveBeenCalled();
    video.seeking = false; video.currentTime = 1.4; control.setMode(true, .25); expect(raw.ctx.drawImage).not.toHaveBeenCalled();
    control.receive(graded.element, video as HTMLVideoElement); expect(raw.ctx.drawImage).toHaveBeenCalledTimes(1);
    video.paused = false; control.receive(graded.element, video as HTMLVideoElement); expect(output.element.dataset.comparisonStatus).toBe("waiting");
  });
  it("skips repeated same-time seeks, still seeks a new playhead and rejects invalid times", () => {
    const writes: number[] = []; let value = 0;
    const video = { get currentTime() { return value; }, set currentTime(next) { value = next; writes.push(next); } };
    seekColorScopeSourceV1(video, 0); seekColorScopeSourceV1(video, .5); seekColorScopeSourceV1(video, .500000001); seekColorScopeSourceV1(video, 1.4);
    expect(writes).toEqual([.5, 1.4]); expect(() => seekColorScopeSourceV1(video, NaN)).toThrow();
  });
});
