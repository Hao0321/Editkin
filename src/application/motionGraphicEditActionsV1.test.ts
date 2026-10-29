import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { EditorCommand } from "../domain/commandTypes";
import type { MotionGraphic } from "../domain/types";
import { createDemoProject } from "../domain/demo";
import { createMotionGraphic } from "../motion/composition";
import { defaultMotionGraphicV2Seed } from "../motion/defaultGraphicSeedsV2";
import { dispatchCommandSafely, undo, redo } from "../domain/history";
import { projectSchema } from "../domain/schema";
import { createProjectSession } from "./projectSession";
import { createTimelineEditingState } from "./timelineEditingState";
import { createGraphicEditingSelectionV1 } from "./graphicEditingSelectionV1";
import { createMotionGraphicEditActionsV1 } from "./motionGraphicEditActionsV1";

function fixture({ attached = false, vector = false }: { attached?: boolean; vector?: boolean } = {}) {
  const p = createDemoProject();
  p.motionGraphics = [createMotionGraphic("g", "title", "TITLE", 0, 3, undefined, defaultMotionGraphicV2Seed("title")), createMotionGraphic("other", "tag", "OTHER", 1, 2)];
  if (vector) {
    p.motionGraphics[0].text = "";
    p.motionGraphics[0].vectorV2 = { schema: "editkin.motion-vector/v1", kind: "connection_field", heightPixels: 160, revealFrames: 20,
      seed: 1, points: 12, dotRadiusPixels: 3, lineWidthPixels: 1, burstFrames: 10, gatherStartFrame: 12, gatherFrames: 12,
      connectStartFrame: 30, connectFrames: 12, groupColors: ["#123456", "#234567", "#345678"] };
  }
  const clip = p.tracks.flatMap(t => t.clips)[0], track = p.tracks.find(t => t.id === clip.trackId)!;
  track.clips.push({ ...structuredClone(clip), id: "second", timelineStart: clip.duration + 1 });
  const session = createProjectSession(p), timeline = createTimelineEditingState(session), statuses: string[] = [], calls: EditorCommand[] = [];
  const state = createGraphicEditingSelectionV1(session, timeline), detach = state.subscribe(() => {});
  if (attached) { timeline.setSelectedClipId(clip.id); state.select(undefined); }
  else state.select({ id: "g", sessionId: session.getSnapshot().sessionId });
  const runCommand = (command: EditorCommand) => {
    calls.push(command);
    const result = dispatchCommandSafely(session.getSnapshot().history, command, `graphic-${calls.length}`);
    if (result.error) { statuses.push(result.error); return false; }
    session.setHistory(result.state); return true;
  };
  const host = { getSnapshot: session.getSnapshot, getSelectionSnapshot: state.getSnapshot, runCommand, setStatus: (m: string) => statuses.push(m) };
  const view = (overrides: Partial<Parameters<typeof createMotionGraphicEditActionsV1>[0]> = {}) => createMotionGraphicEditActionsV1(
    { ...host, ...overrides }, { project: session.getSnapshot().history.present, selection: state.getSnapshot(), ...(attached ? { clipId: clip.id } : {}) });
  const graph = () => session.getSnapshot().history.present, graphic = () => graph().motionGraphics.find(g => g.id === "g")!;
  return { session, timeline, state, runCommand, view, graph, graphic, statuses, calls, detach, clipId: clip.id };
}
function reject(f: ReturnType<typeof fixture>, action: () => unknown) {
  const before = JSON.stringify(f.session.getSnapshot().history), count = f.calls.length;
  assert.equal(action(), false); assert.equal(JSON.stringify(f.session.getSnapshot().history), before); assert.equal(f.calls.length, count);
}

function layout(f: ReturnType<typeof fixture>) { const value = f.graphic().layoutV2; assert(value); return value; }
function motionSettings(f: ReturnType<typeof fixture>) { const value = f.graphic().motionV2; assert(value); return value; }
function vector(f: ReturnType<typeof fixture>) {
  const value = f.graphic().vectorV2; assert(value?.kind === "connection_field" && value.groupColors);
  return value as typeof value & { groupColors: [string, string, string] };
}

describe("current-owner ordinary graphic edits through canonical history", () => {
it('main-current-edit-undo-redo-json',()=>{const f=fixture(),v=f.view();assert.equal(v.update('g',{text:'EDITED'}),true);assert.equal(f.graphic().text,'EDITED');assert.equal(f.session.getSnapshot().history.past.length,1);f.session.setHistory(undo(f.session.getSnapshot().history));assert.equal(f.graphic().text,'TITLE');f.session.setHistory(redo(f.session.getSnapshot().history));assert.equal(projectSchema.parse(JSON.parse(JSON.stringify(f.graph()))).motionGraphics[0].text,'EDITED');f.detach();});
it('attached-current-edit',()=>{const f=fixture({attached:true});assert.equal(f.view().update('g',{text:'ATTACHED'}),true);assert.equal(f.graphic().text,'ATTACHED');f.detach();});
it('different-graphic-selection-refused',()=>{const f=fixture(),v=f.view();f.state.select({id:'other',sessionId:1});reject(f,()=>v.update('g',{text:'OLD'}));f.detach();});
it('graphic-selection-a-b-a-refused',()=>{const f=fixture(),v=f.view();f.state.select({id:'other',sessionId:1});f.state.select({id:'g',sessionId:1});reject(f,()=>v.update('g',{text:'OLD'}));f.detach();});
it('attached-clip-a-b-a-refused',()=>{const f=fixture({attached:true}),v=f.view();f.timeline.setSelectedClipId('second');f.timeline.setSelectedClipId(f.clipId);reject(f,()=>v.update('g',{text:'OLD'}));f.detach();});
it('same-id-project-reopen-refused',()=>{const f=fixture(),v=f.view();f.session.replaceProject(structuredClone(f.graph()));f.state.select({id:'g',sessionId:f.session.getSnapshot().sessionId});reject(f,()=>v.update('g',{text:'OLD'}));f.detach();});
it('same-id-delete-readd-refused',()=>{const f=fixture(),v=f.view(),g=structuredClone(f.graphic());f.runCommand({type:'batch',commands:[{type:'delete_motion_graphic',graphicId:'g'},{type:'add_motion_graphic',graphic:g}]});f.state.select({id:'g',sessionId:1});reject(f,()=>v.update('g',{text:'OLD'}));f.detach();});
it('layout-disjoint-leaves-preserved',()=>{const f=fixture(),v=f.view(),before=structuredClone(layout(f));f.runCommand({type:'update_motion_graphic',graphicId:'g',patch:{layoutV2:{...before,lineGap:before.lineGap+1}}});assert.equal(v.update('g',{layoutV2:{...before,widthMode:'fit_content'}}),true);assert.equal(layout(f).lineGap,before.lineGap+1);assert.equal(layout(f).widthMode,'fit_content');f.detach();});
it('layout-nested-safe-area-preserved',()=>{const f=fixture(),v=f.view(),before=structuredClone(layout(f));f.runCommand({type:'update_motion_graphic',graphicId:'g',patch:{layoutV2:{...before,safeArea:{...before.safeArea,top:before.safeArea.top+.01}}}});assert.equal(v.update('g',{layoutV2:{...before,safeArea:{...before.safeArea,right:before.safeArea.right+.01}}}),true);assert.equal(layout(f).safeArea.top,before.safeArea.top+.01);f.detach();});
it('same-leaf-conflict-refused',()=>{const f=fixture(),v=f.view();f.runCommand({type:'update_motion_graphic',graphicId:'g',patch:{text:'FRESH'}});reject(f,()=>v.update('g',{text:'OLD'}));f.detach();});
it('motion-optional-removal-preserves-entrance',()=>{const f=fixture();const motion=motionSettings(f);f.runCommand({type:'update_motion_graphic',graphicId:'g',patch:{motionV2:{...motion,sequence:{...motion.sequence,exitStaggerFrames:0}}}});const v=f.view(),before=structuredClone(motionSettings(f));f.runCommand({type:'update_motion_graphic',graphicId:'g',patch:{motionV2:{...before,entrance:{...before.entrance,opacity:.2}}}});const {exitStaggerFrames,...sequence}=before.sequence;assert.equal(v.update('g',{motionV2:{...before,sequence}}),true);assert.equal(motionSettings(f).entrance.opacity,.2);assert(!Object.hasOwn(motionSettings(f).sequence,'exitStaggerFrames'));f.detach();});
it('vector-disjoint-leaves-preserved',()=>{const f=fixture({vector:true}),v=f.view(),before=structuredClone(vector(f));f.runCommand({type:'update_motion_graphic',graphicId:'g',patch:{vectorV2:{...before,points:20}}});assert.equal(v.update('g',{vectorV2:{...before,heightPixels:180}}),true);assert.equal(vector(f).points,20);assert.equal(vector(f).heightPixels,180);f.detach();});
it('group-color-tuple-other-axis-preserved',()=>{const f=fixture({vector:true}),v=f.view(),before=structuredClone(vector(f));f.runCommand({type:'update_motion_graphic',graphicId:'g',patch:{vectorV2:{...before,groupColors:['#654321',before.groupColors[1],before.groupColors[2]]}}});assert.equal(v.update('g',{vectorV2:{...before,groupColors:[before.groupColors[0],'#abcdef',before.groupColors[2]]}}),true);assert.deepEqual(vector(f).groupColors,['#654321','#abcdef',before.groupColors[2]]);f.detach();});
it('stale-delete-after-edit-refused',()=>{const f=fixture(),v=f.view();f.runCommand({type:'update_motion_graphic',graphicId:'g',patch:{text:'NEW'}});reject(f,()=>v.remove('g'));f.detach();});
it('managed-scene-transition-refused',()=>{const f=fixture(),v=f.view();const track=(value: number)=>({fps:30,initialPosition:value,initialVelocity:0,initialTarget:value,spring:{stiffness:100,damping:20,mass:1},events:[]});assert(f.runCommand({type:'add_motion_scene',scene:{schema:'editkin.motion-scene-2d/v1',id:'owner',startFrame:0,durationFrames:90,fps:30,graphicIds:['g'],camera:{centerX:track(960),centerY:track(540),zoom:track(1)},safeArea:{left:20,right:20,top:20,bottom:20},semanticCues:[{id:'show',frame:0,purpose:'Show fixture title',graphicIds:['g'],evidenceRefs:['fixture:title']}]}}));reject(f,()=>v.update('g',{text:'OLD'}));f.detach();});
it('noop-does-not-create-history',()=>{const f=fixture(),v=f.view(),before=f.session.getSnapshot().history;assert.equal(v.update('g',{text:'TITLE'}),true);assert.equal(f.session.getSnapshot().history,before);f.detach();});
it('undo-redo-same-value-refused',()=>{const f=fixture(),v=f.view();f.runCommand({type:'update_motion_graphic',graphicId:'other',patch:{text:'NEW'}});f.session.setHistory(undo(f.session.getSnapshot().history));f.session.setHistory(redo(f.session.getSnapshot().history));reject(f,()=>v.update('g',{text:'OLD'}));f.detach();});
it('unmounted-callback-refused',()=>{const f=fixture(),v=f.view();f.detach();reject(f,()=>v.update('g',{text:'OLD'}));});
it('undo-keeps-visible-selection-and-fresh-edit',()=>{const f=fixture();f.runCommand({type:'update_motion_graphic',graphicId:'g',patch:{text:'NEW'}});f.session.setHistory(undo(f.session.getSnapshot().history));assert.equal(f.state.getSnapshot().selection?.id,'g');assert.equal(f.view().update('g',{text:'AFTER UNDO'}),true);f.detach();});
it('reattach-cannot-revive-old-view',()=>{const f=fixture(),v=f.view();f.detach();const detach=f.state.subscribe(()=>{});f.state.select({id:'g',sessionId:1});reject(f,()=>v.update('g',{text:'OLD'}));detach();});
it('attached-graphic-moved-to-other-clip-refused',()=>{const f=fixture({attached:true}),v=f.view();assert(f.runCommand({type:'update_motion_graphic',graphicId:'g',patch:{timelineStart:13.2}}));reject(f,()=>v.update('g',{text:'OLD'}));f.detach();});
it('vector-kind-changed-since-render-refused',()=>{const f=fixture({vector:true}),v=f.view(),before=structuredClone(vector(f));assert(f.runCommand({type:'update_motion_graphic',graphicId:'g',patch:{vectorV2:{schema:'editkin.motion-vector/v1',kind:'panel',heightPixels:160,revealFrames:20}}}));reject(f,()=>v.update('g',{vectorV2:{...before,heightPixels:180}}));f.detach();});

  it("attached same-ID delete/readd cannot revive the old callback", () => {
    const f = fixture({ attached: true }), v = f.view(), graphic = structuredClone(f.graphic());
    assert(f.runCommand({ type: "batch", commands: [{ type: "delete_motion_graphic", graphicId: "g" }, { type: "add_motion_graphic", graphic }] }));
    reject(f, () => v.update("g", { text: "OLD" })); reject(f, () => v.remove("g")); f.detach();
  });
  it("keeps independent registrations even when their callback function is identical", () => {
    const f = fixture(), listener = () => {}, a = f.state.subscribe(listener), b = f.state.subscribe(listener);
    f.detach(); a(); a(); assert(f.state.getSnapshot().active); b(); assert.equal(f.state.getSnapshot().active, false);
  });
  it("save acknowledgement preserves selection and an unchanged pending field", () => {
    const f = fixture(), v = f.view(), selection = f.state.getSnapshot(), request = f.session.beginSave()!;
    assert(f.session.completeSave(request, { path: "fixture-only.editkin", project: { ...request.project, revision: request.project.revision + 1, updatedAt: "2031-01-02T00:00:00.000Z" } }));
    f.session.finishSave(request); assert.equal(f.state.getSnapshot(), selection);
    assert(v.update("g", { text: "AFTER SAVE" })); assert.equal(f.graphic().text, "AFTER SAVE"); f.detach();
  });
  it("rejects foreign IDs, unknown patch fields and schema/id replacement", () => {
    const f = fixture(), v = f.view();
    reject(f, () => v.update("other", { text: "OLD" }));
    for (const patch of [{ unexpectedField: 1 }, { id: "other" }, { schema: "hao.motion-composition/v1" }]) {
      reject(f, () => v.update("g", patch as Partial<Omit<MotionGraphic, "schema" | "id">>));
    }
    f.detach();
  });
  it("does not acknowledge a canonical runner refusal or exception", () => {
    for (const throws of [false, true]) {
      const f = fixture(), v = f.view({ runCommand: () => { if (throws) throw Error("canonical refusal"); return false; } });
      reject(f, () => v.update("g", { text: "NEW" })); reject(f, () => v.remove("g")); f.detach();
    }
  });
  it("refuses the old view after a preset identity change", () => {
    const f = fixture(), v = f.view(); assert(f.runCommand({ type: "update_motion_graphic", graphicId: "g", patch: { presetId: "another-preset" } }));
    reject(f, () => v.update("g", { text: "OLD" })); f.detach();
  });
  it("refuses a reentrant project change immediately before commit", () => {
    const f = fixture(); let armed = false, calls = 0;
    const v = f.view({ getSnapshot: () => { if (armed && ++calls === 2) f.runCommand({ type: "update_motion_graphic", graphicId: "other", patch: { text: "REENTRANT" } }); return f.session.getSnapshot(); } });
    armed = true; assert.equal(v.update("g", { text: "OLD" }), false); assert.equal(f.graphic().text, "TITLE");
    assert.equal(f.graph().motionGraphics.find(g => g.id === "other")!.text, "REENTRANT"); f.detach();
  });
  it("keeps geometry event arrays atomic rather than inventing a merged sequence", () => {
    const f = fixture(), phase = motionSettings(f);
    const track = (value: number) => ({ fps: 30, initialPosition: value, initialTarget: value, initialVelocity: 0,
      spring: { stiffness: 100, damping: 20, mass: 1 }, events: [{ frame: 20, target: value }] });
    const geometry = { localId: "g", envelope: { x: 0, y: 0, width: 64, height: 64 },
      left: track(10), top: track(10), right: track(54), bottom: track(54), cornerRadius: track(4) };
    assert(f.runCommand({ type: "update_motion_graphic", graphicId: "g", patch: {
      text: "", x: .2, y: .2, width: 64 / 1920, outlineWidth: 0,
      motionV2: { ...phase, sequence: { ...phase.sequence, unit: "all", staggerFrames: 0 } },
      vectorV2: { schema: "editkin.motion-vector-continuity/v1", kind: "spring_panel", heightPixels: 64, revealFrames: 1, geometry },
    } }));
    const v = f.view();
    assert(f.runCommand({ type: "update_motion_graphic", graphicId: "g", patch: {
      vectorV2: { schema: "editkin.motion-vector-continuity/v1", kind: "spring_panel", heightPixels: 64, revealFrames: 1,
        geometry: { ...geometry, left: { ...geometry.left, events: [{ frame: 20, target: 11 }] } } },
    } }));
    reject(f, () => v.update("g", { vectorV2: {
      schema: "editkin.motion-vector-continuity/v1", kind: "spring_panel", heightPixels: 64, revealFrames: 1,
      geometry: { ...geometry, left: { ...geometry.left, events: [{ frame: 30, target: 12 }] } },
    } }));
    f.detach();
  });

  it("library deletion keeps canonical Undo and cannot become a generic update API", () => {
    const f = fixture(), host = { getSnapshot: f.session.getSnapshot, getSelectionSnapshot: f.state.getSnapshot,
      runCommand: f.runCommand, setStatus: (m: string) => f.statuses.push(m) };
    const v = createMotionGraphicEditActionsV1(host, { project: f.graph(), selection: f.state.getSnapshot(), libraryDeleteOnly: true });
    reject(f, () => v.update("other", { text: "NOT ALLOWED" }));
    assert(v.remove("other")); assert(!f.graph().motionGraphics.some(g => g.id === "other"));
    f.session.setHistory(undo(f.session.getSnapshot().history)); assert(f.graph().motionGraphics.some(g => g.id === "other")); f.detach();
  });
  it("library deletion rejects a same-ID reopen and selection change", () => {
    for (const reopen of [false, true]) {
      const f = fixture(), v = createMotionGraphicEditActionsV1({ getSnapshot: f.session.getSnapshot, getSelectionSnapshot: f.state.getSnapshot,
        runCommand: f.runCommand, setStatus: (m: string) => f.statuses.push(m) }, { project: f.graph(), selection: f.state.getSnapshot(), libraryDeleteOnly: true });
      if (reopen) f.session.replaceProject(structuredClone(f.graph())); else f.state.select({ id: "other", sessionId: 1 });
      reject(f, () => v.remove("other")); f.detach();
    }
  });
  it("does not enumerate graphic collections when merely constructing playback-render callbacks", () => {
    const f = fixture(), selection = f.state.getSnapshot(), p = f.graph(), graphics = p.motionGraphics; let reads = 0;
    Object.defineProperty(p, "motionGraphics", { configurable: true, get: () => { reads++; return graphics; } });
    for (let i = 0; i < 20; i++) createMotionGraphicEditActionsV1({ getSnapshot: f.session.getSnapshot, getSelectionSnapshot: f.state.getSnapshot,
      runCommand: f.runCommand, setStatus: () => {} }, { project: p, selection, libraryDeleteOnly: true });
    assert.equal(reads, 0); Object.defineProperty(p, "motionGraphics", { configurable: true, writable: true, value: graphics }); f.detach();
  });
  it("reuses an unchanged selection snapshot without rescanning the graphics", () => {
    const f = fixture(), p = f.graph(), before = f.state.getSnapshot(), graphics = p.motionGraphics; let reads = 0;
    Object.defineProperty(p, "motionGraphics", { configurable: true, get: () => { reads++; return graphics; } });
    for (let i = 0; i < 20; i++) assert.equal(f.state.getSnapshot(), before);
    assert.equal(reads, 0); Object.defineProperty(p, "motionGraphics", { configurable: true, writable: true, value: graphics }); f.detach();
  });

});
