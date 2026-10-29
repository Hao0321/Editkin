import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { ResidentAudioTransport } from "./residentAudioTransport";
import type { ResidentAudioApi, ResidentAudioStage } from "./residentAudioTypes";

const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function fixture() {
  const project = createDemoProject(); let generation = 0;
  const stage = (start: number, g: number): ResidentAudioStage => ({ schema: "editkin.native-audio-project-stage/v1", status: "PREPARED",
    projectId: project.id, projectRevision: project.revision, projectUpdatedAt: project.updatedAt, generation: g,
    planSha256: "a".repeat(64), audioFingerprintSha256: "b".repeat(64), planBytes: 240, startFrame: Math.round(start * 48000),
    frameCount: 48000 * 60 - Math.round(start * 48000), sourceCount: 1, peakActiveSources: 1, pcmStagingFiles: 0 });
  const api = {
    capabilities: vi.fn(async () => ({ schema: "editkin.desktop-audio-capabilities/v1" as const, supported: true, gpuClock: true, clockSchema: "editkin.resident-audio-clock/v1" as const, sampleRate: 48000 as const })),
    open: vi.fn(async () => ({ ownerId: 7, status: {} as never })),
    replace: vi.fn(async (ownerId: number, _project: unknown, start: number) => { const g = ++generation; return { ownerId, generation: g, stage: stage(start, g) }; }),
    control: vi.fn(async (ownerId: number) => ({ ownerId, accepted: true as const, requestId: 1 })),
    close: vi.fn(async (ownerId: number) => ({ ownerId, released: true, retainedStageFiles: 0 })),
  } satisfies ResidentAudioApi;
  const transport = new ResidentAudioTransport(api, () => undefined, () => undefined);
  /** A replacement the test completes later. Like the native owner, it takes the next generation when it is issued. */
  const held = () => {
    const g = ++generation; let release!: () => void;
    api.replace.mockImplementationOnce(async (ownerId: number, _project: unknown, start: number) => {
      await new Promise<void>(resolve => { release = resolve; });
      return { ownerId, generation: g, stage: stage(start, g) };
    });
    return () => release();
  };
  return { api, transport, stage, held, intent: { project, seekRevision: 0, timelineStartSeconds: 0, playing: false, prepare: true } };
}
describe("paused native audio preparation", () => {
  it("prepares paused and Play reuses the same owner and plan", async () => {
    const f = fixture(); f.transport.update(f.intent); await flush();
    expect(f.api.open).toHaveBeenCalledTimes(1); expect(f.api.replace).toHaveBeenCalledTimes(1); expect(f.api.control).not.toHaveBeenCalled();
    f.transport.update({ ...f.intent, playing: true }); await flush();
    expect(f.api.open).toHaveBeenCalledTimes(1); expect(f.api.replace).toHaveBeenCalledTimes(1);
    expect(f.api.control).toHaveBeenCalledExactlyOnceWith(7, 1, true); await f.transport.dispose(); expect(f.api.close).toHaveBeenCalledExactlyOnceWith(7);
  });
  it("keeps paused allocation opt-in for legacy callers", async () => {
    const f = fixture(); f.transport.update({ ...f.intent, prepare: false }); await flush();
    expect(f.api.open).not.toHaveBeenCalled(); await f.transport.dispose();
  });
  it("never autoplays an obsolete paused seek when preparation finishes late", async () => {
    const f = fixture(), release = f.held();
    f.transport.update(f.intent); await flush();
    f.transport.update({ ...f.intent, timelineStartSeconds: 2, seekRevision: 1 });
    f.transport.update({ ...f.intent, timelineStartSeconds: 3, seekRevision: 2 });
    release(); await flush();
    expect(f.api.replace).toHaveBeenCalledTimes(2); expect(f.api.replace.mock.calls[1][2]).toBe(3); expect(f.api.control).not.toHaveBeenCalled();
    f.transport.update({ ...f.intent, timelineStartSeconds: 3, seekRevision: 2, playing: true }); await flush();
    expect(f.api.control).toHaveBeenCalledExactlyOnceWith(7, 2, true); await f.transport.dispose();
  });
  it("disposal during preparation closes the owner without playing", async () => {
    const f = fixture(); let release!: (value: Awaited<ReturnType<ResidentAudioApi["replace"]>>) => void;
    f.api.replace.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    f.transport.update(f.intent); await flush(); const retired = f.transport.dispose();
    release({ ownerId: 7, generation: 1, stage: f.stage(0, 1) }); await retired;
    expect(f.api.control).not.toHaveBeenCalled(); expect(f.api.close).toHaveBeenCalledExactlyOnceWith(7);
  });
});
