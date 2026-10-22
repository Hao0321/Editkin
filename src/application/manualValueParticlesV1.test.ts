import { afterAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { createProjectSession } from "./projectSession";
import { undo, redo } from "../domain/history";
import { DEFAULT_PARTICLE_SIMULATION } from "../domain/types";
import { projectSchema } from "../domain/schema";
import { prepareValueParticlesV1 } from "./valueParticlesV1";
import { prepareManualValueParticlesV1, applyPreparedManualValueParticlesV1 } from "./manualValueParticlesV1";
import { manualValueParticleFixtureV1, finishManualValueParticleFixtureV1 } from "./__fixtures__/manualValueParticlesV1.fixture";
const roots: string[] = [];
async function fixture() { const f = await manualValueParticleFixtureV1(); roots.push(f.root); return f; }
afterAll(async () => { for (const root of roots) await finishManualValueParticleFixtureV1(root); });
describe("explicit manual value authoring using existing native settings and visible provenance", () => {
  it("keeps preparation readonly then persists declared value/source note with one Undo/Redo", async () => {
    const f = await fixture(), before = JSON.stringify(f.p), plan = await prepareManualValueParticlesV1(f.session, f.request, f.host);
    expect(JSON.stringify(f.p)).toBe(before); expect(plan).toMatchObject({ basis: "user_asserted", quotedValue: "12000元", defaultEnabled: false, currencyGlyphs: false });
    const result = await applyPreparedManualValueParticlesV1(f.session, plan); expect(result.undoSteps).toBe(1); expect(f.session.getSnapshot().history.past).toHaveLength(1);
    const after = f.session.getSnapshot().history.present, note = after.director.markers.find(m => m.id === plan.provenanceMarkerId)!;
    expect(note.title).toBe("12000元"); expect(note.note).toBe(f.host.notes.user_asserted); expect(note.id).toContain("user_asserted");
    expect(after.assets).toEqual(f.p.assets); expect(after.tracks).toEqual(f.p.tracks); expect(after.particleSimulation?.timeline).toEqual({ start: 56 / 24, duration: .5 });
    const parsed = projectSchema.parse(JSON.parse(JSON.stringify(after))); expect(parsed.director.markers).toEqual(after.director.markers);
    f.session.setHistory(undo(f.session.getSnapshot().history)); expect(f.session.getSnapshot().history.present.particleSimulation).toBeUndefined(); expect(f.session.getSnapshot().history.present.director.markers).toEqual(f.p.director.markers);
    f.session.setHistory(redo(f.session.getSnapshot().history)); expect(f.session.getSnapshot().history.present.particleSimulation).toEqual(after.particleSimulation);
  });
  it("uses the original complete native command for evidence, then adds only a source note", async () => {
    const f = await fixture(); f.request.value = { kind: "material_evidence", evidence: f.evidence };
    const original = await prepareValueParticlesV1(createProjectSession(structuredClone(f.p)), f.host, { expectedRevision: f.request.expectedRevision, id: f.request.id,
      clipId: f.request.clipId, range: f.request.range, parameters: f.request.parameters, evidence: f.evidence });
    const plan = await prepareManualValueParticlesV1(f.session, f.request, f.host); await applyPreparedManualValueParticlesV1(f.session, plan);
    const settings = original.command.type === "batch" ? original.command.commands.find(c => c.type === "set_particle_simulation_settings") : undefined;
    if (settings?.type !== "set_particle_simulation_settings") throw Error("Original settings missing");
    expect(f.session.getSnapshot().history.present.particleSimulation).toEqual(settings.settings); expect(plan.basis).toBe("material_evidence");
    expect(f.session.getSnapshot().history.present.director.markers.at(-1)?.note).toBe(f.host.notes.material_evidence);
  });
  it.each(["12000", "0元", "-20元", "1,,200元", "20.123元", "價格很高"])("rejects %s without resolving source", async value => {
    const f = await fixture(); let calls = 0; f.host.resolveSource = async () => { calls++; return f.source; };
    f.request.value = { kind: "user_asserted", quotedValue: value, confirmed: true };
    await expect(prepareManualValueParticlesV1(f.session, f.request, f.host)).rejects.toThrow(); expect(calls).toBe(0);
  });
  it("requires explicit confirmation and never falls back from a bad material claim", async () => {
    const f = await fixture(); await expect(prepareManualValueParticlesV1(f.session, { ...f.request, value: { kind: "user_asserted", quotedValue: "20元", confirmed: false } }, f.host)).rejects.toThrow();
    f.request.value = { kind: "material_evidence", evidence: { ...f.evidence, quotedValue: "9999元" } };
    await expect(prepareManualValueParticlesV1(f.session, f.request, f.host)).rejects.toThrow("NOT_BOUND"); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it.each(["locked", "hidden", "retime", "revision", "range", "relative-base"])("rejects %s", async mode => {
    const f = await fixture(); if (mode === "locked") f.p.tracks[0].locked = true; if (mode === "hidden") f.p.tracks[0].hidden = true;
    if (mode === "retime") f.p.tracks[0].clips[0].speed = 2; if (mode === "revision") f.request.expectedRevision++;
    if (mode === "range") f.request.range.endFrame = 79; if (mode === "relative-base") f.host.assetBase = ".";
    await expect(prepareManualValueParticlesV1(f.session, f.request, f.host)).rejects.toThrow(); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("captures request and runtime notes before awaits and rejects source-owner mutations", async () => {
    const f = await fixture(); f.host.resolveSource = async () => { f.request.value = { kind: "user_asserted", quotedValue: "30元", confirmed: true }; f.host.notes.user_asserted = "Changed later"; return f.source; };
    const plan = await prepareManualValueParticlesV1(f.session, f.request, f.host); expect(plan.quotedValue).toBe("12000元"); await applyPreparedManualValueParticlesV1(f.session, plan);
    expect(f.session.getSnapshot().history.present.director.markers.at(-1)?.note).not.toBe("Changed later");
    const g = await fixture(); g.host.resolveSource = async () => { g.p.name = "Changed during resolve"; return g.source; };
    await expect(prepareManualValueParticlesV1(g.session, g.request, g.host)).rejects.toThrow("PROJECT_CHANGED");
  });
  it.each(["clone", "packet", "session", "source", "source-path"])("refuses %s before any real commit", async mode => {
    const f = await fixture(), plan = await prepareManualValueParticlesV1(f.session, f.request, f.host);
    if (mode === "clone") await expect(applyPreparedManualValueParticlesV1(f.session, structuredClone(plan))).rejects.toThrow("INVALID");
    if (mode === "packet") { plan.quotedValue = "30元"; await expect(applyPreparedManualValueParticlesV1(f.session, plan)).rejects.toThrow("INVALID"); }
    if (mode === "session") { f.session.replaceProject(structuredClone(f.p)); await expect(applyPreparedManualValueParticlesV1(f.session, plan)).rejects.toThrow("PROJECT_CHANGED"); }
    if (mode === "source") { await writeFile(f.source, "Changed bytes"); await expect(applyPreparedManualValueParticlesV1(f.session, plan)).rejects.toThrow("IDENTITY_CHANGED"); }
    if (mode === "source-path") { f.host.resolveSource = async () => f.framePath; await expect(prepareManualValueParticlesV1(f.session, f.request, f.host)).rejects.toThrow("ORIGINAL_SOURCE"); }
    expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("consumes failed or concurrent apply and forwards cancellation exactly", async () => {
    const f = await fixture(), plan = await prepareManualValueParticlesV1(f.session, f.request, f.host), c = new AbortController(), reason = Error("manual-value-stop"); c.abort(reason);
    await expect(applyPreparedManualValueParticlesV1(f.session, plan, c.signal)).rejects.toBe(reason); await expect(applyPreparedManualValueParticlesV1(f.session, plan)).rejects.toThrow("USED");
    const g = await fixture(), second = await prepareManualValueParticlesV1(g.session, g.request, g.host), first = applyPreparedManualValueParticlesV1(g.session, second);
    await expect(applyPreparedManualValueParticlesV1(g.session, second)).rejects.toThrow("USED"); await first; expect(g.session.getSnapshot().history.past).toHaveLength(1);
  });
  it("rejects a public packet changed during physical revalidation before any commit", async () => {
    const f = await fixture(), plan = await prepareManualValueParticlesV1(f.session, f.request, f.host), applying = applyPreparedManualValueParticlesV1(f.session, plan);
    plan.quotedValue = "30元"; await expect(applying).rejects.toThrow("CHANGED_DURING_APPLY");
    expect(f.session.getSnapshot().history.past).toHaveLength(0); await expect(applyPreparedManualValueParticlesV1(f.session, plan)).rejects.toThrow("USED");
  });
  it("bounds a stalled resolver and preserves the exact external abort reason", async () => {
    const f = await fixture(); f.host.resolveSource = () => new Promise(() => {}); const c = new AbortController(), reason = Error("manual-resolve-stop");
    const pending = prepareManualValueParticlesV1(f.session, f.request, f.host, { signal: c.signal }); setTimeout(() => c.abort(reason), 5); await expect(pending).rejects.toBe(reason);
    await expect(prepareManualValueParticlesV1(f.session, f.request, f.host, { timeoutMs: 100 })).rejects.toThrow("TIMEOUT");
  });
  it("preserves existing primary parameters and refuses disabled or aggregate overflow", async () => {
    const f = await fixture(); f.p.particleSimulation = structuredClone(DEFAULT_PARTICLE_SIMULATION); const old = structuredClone(f.p.particleSimulation);
    const plan = await prepareManualValueParticlesV1(f.session, f.request, f.host); await applyPreparedManualValueParticlesV1(f.session, plan);
    const { additionalEmitters, ...primary } = f.session.getSnapshot().history.present.particleSimulation!; expect(primary).toEqual(old); expect(additionalEmitters?.[0].id).toBe("value-manual-a");
    const g = await fixture(); g.p.particleSimulation = { ...structuredClone(DEFAULT_PARTICLE_SIMULATION), enabled: false }; await expect(prepareManualValueParticlesV1(g.session, g.request, g.host)).rejects.toThrow("DISABLED");
    g.p.particleSimulation = { ...structuredClone(DEFAULT_PARTICLE_SIMULATION), additionalEmitters: ["a", "b"].map(id => ({ id, ...structuredClone(DEFAULT_PARTICLE_SIMULATION) })) };
    await expect(prepareManualValueParticlesV1(g.session, g.request, g.host)).rejects.toThrow("192");
  });
});
