import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { dispatchCommandSafely } from "../domain/history";
import { createProjectSession } from "./projectSession";
import { createManualValueParticleInteractionV1 } from "./manualValueParticleInteractionV1";
import type { ManualValueParticleRequestV1 } from "./manualValueParticlesV1";
function fixture() {
  const p = createEmptyProject("Driver control", { id: "driver", width: 64, height: 40, fps: 24 }), session = createProjectSession(p), owner = {};
  const request: ManualValueParticleRequestV1 = { schema: "editkin.manual-value-particles/v1", expectedRevision: p.revision, id: "driver", clipId: "selected", range: { startFrame: 0, endFrame: 12 },
    createdAt: p.updatedAt, value: { kind: "user_asserted", quotedValue: "20元", confirmed: true }, parameters: { seed: 37, ratePerSecond: 24, lifetimeSeconds: .3, maxParticles: 12, emitterPosition: [.5, .5], initialVelocity: [0, -20], gravity: [0, 40], radiusPixels: 2, color: [1, 1, 1, 1] } };
  let project = p, disabled = false, hostOwner: unknown = owner;
  return { p, session, request, read: () => ({ project, projectSession: session, request, hostOwner, disabled }), replace: () => { project = structuredClone(p); session.replaceProject(project); }, disable: () => { disabled = true; }, changeOwner: () => { hostOwner = {}; } };
}
describe("manual value source-component request ownership", () => {
  it("accepts its own synchronous commit without relabeling it stale and refuses double apply", async () => {
    const f = fixture(); let calls = 0;
    const driver = createManualValueParticleInteractionV1({ read: f.read, apply: async a => { calls++; expect(a.guard.isCurrent()).toBe(true); const result = dispatchCommandSafely(f.session.getSnapshot().history, { type: "rename_project", name: "Own edit" }); f.session.setHistory(result.state); driver.invalidate(); return { status: "applied" }; } });
    const pending = driver.apply(); expect(await driver.apply()).toBe(false); expect(await pending).toBe(true); expect(calls).toBe(1); expect(driver.getState().status).toBe("done"); expect(f.session.getSnapshot().history.past).toHaveLength(1);
  });
  it.each(["project", "in-place", "request", "disabled", "owner", "cancel", "dispose"])("invalidates %s across a pending host await", async mode => {
    const f = fixture(); let enter!: () => void, finish!: () => void, writes = 0; const entered = new Promise<void>(r => { enter = r; }), paused = new Promise<void>(r => { finish = r; });
    const driver = createManualValueParticleInteractionV1({ read: f.read, apply: async a => { enter(); await paused; if (!a.guard.isCurrent()) return { status: "cancelled" }; writes++; return { status: "applied" }; } });
    const pending = driver.apply(); await entered;
    if (mode === "project") f.replace(); if (mode === "in-place") f.p.name = "Changed"; if (mode === "request") f.request.range.endFrame++;
    if (mode === "disabled") f.disable(); if (mode === "owner") f.changeOwner(); if (mode === "cancel") driver.cancel(); if (mode === "dispose") driver.dispose();
    driver.invalidate(); finish(); expect(await pending).toBe(false); expect(writes).toBe(0);
  });
  it("aborts an unknown timed-out outcome without replay and does not let public state alter a request", async () => {
    const f = fixture(); let calls = 0, signal: AbortSignal | undefined;
    const driver = createManualValueParticleInteractionV1({ read: f.read, timeoutMs: 100, apply: async a => { calls++; signal = a.guard.signal; return new Promise(() => {}); } });
    const pending = driver.apply(), copy = driver.getState(); copy.status = "done"; expect(driver.getState().status).toBe("applying");
    expect(await pending).toBe(false); expect(signal?.aborted).toBe(true); expect(calls).toBe(1); expect(String(driver.getState().error)).toContain("OUTCOME_UNKNOWN");
  });
  it("declines an unavailable host and maps a valid no-write acknowledgement to cancelled", async () => {
    const f = fixture(); f.disable(); let calls = 0; const driver = createManualValueParticleInteractionV1({ read: f.read, apply: async () => { calls++; return { status: "cancelled" }; } });
    expect(await driver.apply()).toBe(false); expect(calls).toBe(0);
    const g = fixture(), cancelled = createManualValueParticleInteractionV1({ read: g.read, apply: async () => ({ status: "cancelled" }) });
    expect(await cancelled.apply()).toBe(false); expect(cancelled.getState().status).toBe("cancelled");
  });
});
