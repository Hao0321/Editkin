import { test } from "vitest";
import assert from "node:assert/strict";
import { applyCommand } from "../domain/commands";
import { listPaletteRoles, paletteRevisionHash, preparePaletteRevision } from "./agentPaletteRevision";
import { paletteProject, paletteRequest } from "./paletteRevisionFixture";
test("palette roles are explicit and editable without claiming visual acceptance", () => {
  const catalog = listPaletteRoles(); assert.equal(catalog.roles.length, 7); assert.equal(catalog.editable, true);
  assert(catalog.alphaModes.includes("retain_target")); assert.equal(catalog.maximumTargets, 32);
});
test("two Motion targets are recolored through actual graph commands; input and unrelated fields stay unchanged", () => {
  const project = paletteProject(), before = JSON.stringify(project);
  const result = preparePaletteRevision(project, paletteRequest(project));
  assert.equal(result.commands.length, 2); assert.equal(result.sourceMutation, false); assert.equal(result.auditReceipt, false);
  const edited = applyCommand(project, { type: "batch", commands: result.commands });
  assert.equal(edited.motionGraphics[0].backgroundColor, "#F7F8FAFF");
  assert.equal(edited.motionGraphics[0].textColor, "#111827"); assert.equal(edited.motionGraphics[0].accentColor, "#175CD3");
  assert.equal(edited.motionGraphics[1].textColor, "#175CD330"); assert.equal(edited.motionGraphics[1].accentColor, "#175CD31C");
  assert.equal(edited.motionGraphics[0].text, project.motionGraphics[0].text);
  assert.deepEqual(edited.motionGraphics[0].motionV2, project.motionGraphics[0].motionV2);
  assert.equal(edited.motionGraphics[0].fontFamily, project.motionGraphics[0].fontFamily);
  assert.equal(JSON.stringify(project), before); assert(result.changes[0].textContrast! >= 4.5);
});
test("role alpha and custom palette colors can be selected explicitly", () => {
  const project = paletteProject(), request = paletteRequest(project);
  request.palette.primary = "#7038B7CC";
  request.bindings[1].alphaMode = "use_role";
  const result = preparePaletteRevision(project, request);
  assert.equal(result.changes[1].fields.accentColor, "#7038B7CC");
  assert.equal(result.changes[1].fields.textColor, "#175CD31C");
});
test("same project and role bindings yield stable commands and preparation identity", () => {
  const project = paletteProject(), request = paletteRequest(project);
  assert.deepEqual(preparePaletteRevision(project, request), preparePaletteRevision(project, request));
});
test("known low-contrast color defect is refused rather than relabeled acceptable", () => {
  const project = paletteProject(), request = paletteRequest(project);
  request.palette.ink = request.palette.background;
  assert.throws(() => preparePaletteRevision(project, request), /contrast/);
});
test("transparent text contrast is measured after alpha composition", () => {
  const project = paletteProject(); project.motionGraphics[0].textColor = "#11182710";
  const request = paletteRequest(project);
  assert.throws(() => preparePaletteRevision(project, request), /contrast/);
});
test("opaque declared canvas is required, including opaque RGBA", () => {
  const project = paletteProject(), request = paletteRequest(project);
  request.palette.background += "FF"; assert.equal(preparePaletteRevision(project, request).commands.length, 2);
  request.palette.background = "#FFFFFF20"; assert.throws(() => preparePaletteRevision(project, request), /opaque/);
});
for (const [name, mutate, pattern] of [
  ["missing target", (r: ReturnType<typeof paletteRequest>) => { r.bindings[0].graphicId = "missing"; }, /Missing/],
  ["duplicate target", (r: ReturnType<typeof paletteRequest>) => { r.bindings[1].graphicId = r.bindings[0].graphicId; }, /Duplicate/],
  ["stale revision", (r: ReturnType<typeof paletteRequest>) => { r.expectedRevision = 9; }, /Stale/],
  ["stale project", (r: ReturnType<typeof paletteRequest>) => { r.expectedProjectSha256 = "0".repeat(64); }, /Stale/],
] as const) test(name + " is refused without mutation", () => {
  const project = paletteProject(), before = paletteRevisionHash(project), request = paletteRequest(project); mutate(request);
  assert.throws(() => preparePaletteRevision(project, request), pattern); assert.equal(paletteRevisionHash(project), before);
});
test("template and authored-scene ownership cannot be bypassed by recoloring", () => {
  const project = paletteProject();
  // Task-shaped local owner markers, never original-source or review receipts.
  project.motionGraphics[0].templateOwner = { schema: "editkin.template-element-owner/v1", sessionId: "diagnostic-owner", templateId: "diagnostic-template", format: "long", role: "title" };
  assert.throws(() => preparePaletteRevision(project, paletteRequest(project)), /owner-managed/);
  delete project.motionGraphics[0].templateOwner;
  const track = (position: number) => ({ fps: 30, initialPosition: position, initialVelocity: 0, initialTarget: position, spring: { stiffness: 100, damping: 20, mass: 1 }, events: [] });
  project.motionScenes = [{ schema: "editkin.motion-scene-2d/v1", id: "palette-owned-scene", startFrame: 0, durationFrames: 90, fps: 30,
    graphicIds: ["palette-title"], camera: { centerX: track(540), centerY: track(960), zoom: track(1) },
    safeArea: { left: 8, right: 8, top: 8, bottom: 8 },
    semanticCues: [{ id: "palette-owner-cue", frame: 0, purpose: "Local owner-bound negative control", graphicIds: ["palette-title"], evidenceRefs: ["diagnostic:owner"] }] }];
  assert.throws(() => preparePaletteRevision(project, paletteRequest(project)), /owner-managed/);
});
test("unknown fields, roles and over-budget targets are rejected", () => {
  const project = paletteProject(), request = paletteRequest(project);
  assert.throws(() => preparePaletteRevision(project, { ...request, humanApproved: true }));
  assert.throws(() => preparePaletteRevision(project, { ...request, palette: { ...request.palette, script: "run" } }));
  assert.throws(() => preparePaletteRevision(project, { ...request, bindings: [{ graphicId: "palette-title", colors: { textColor: "unknown" } }] }));
  assert.throws(() => preparePaletteRevision(project, { ...request, bindings: [{ graphicId: "palette-title", colors: {} }] }));
  assert.throws(() => preparePaletteRevision(project, { ...request, bindings: Array(33).fill(request.bindings[0]) }));
  assert.throws(() => preparePaletteRevision(project, { ...request, minimumTextContrast: 1 }));
  assert.throws(() => preparePaletteRevision(project, { ...request, excess: "x".repeat(66000) }), /64 KiB/);
});
test("cancelled preparation is stopped", () => {
  const project = paletteProject(), controller = new AbortController(); controller.abort();
  assert.throws(() => preparePaletteRevision(project, paletteRequest(project), controller.signal));
});
