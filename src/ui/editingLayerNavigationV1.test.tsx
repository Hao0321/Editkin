import assert from "node:assert/strict";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { projectSchema } from "../domain/schema";
import { adjacentTrackLayerCommandV1 } from "../domain/trackLayerOrderV1";
import { createMotionGraphic } from "../motion/composition";
import { createEditingTrackIndexV1, editingLayerLocationV1, editingLayerPageV1, editingLayerDisclosureOpenV1 } from "./editingLayerNavigationV1";
import { EditingLayerStackV1, renderEditingLayerPageV1 } from "./EditingLayerStackV1";
import { interfacePreferences } from "./i18n/interfacePreferences";
import type { TimelineTrack } from "../domain/types";
import type { EditingLayerSelectionV1 } from "./editingWorkspaceV1";

/** Metadata only. No media file,decoder,Motion render or native worker is opened. */
export function layerNavigationFixtureV1(count = 65, trackCount = 1) {
  const project = createDemoProject(), asset = project.assets[0], track = project.tracks[0], clip = track.clips[0];
  project.assets = Array.from({ length: count }, (_, i) => ({ ...asset, id: `asset-${i}`, name: `ASSET_${i.toString().padStart(5, "0")}` }));
  project.tracks = Array.from({ length: trackCount }, (_, t) => ({ ...track, id: `track-${t}`, name: `TRACK_${t.toString().padStart(5, "0")}`,
    clips: Array.from({ length: t === 0 ? count : 1 }, (_, i) => ({ ...structuredClone(clip), id: `clip-${t}-${i}`, trackId: `track-${t}`, assetId: `asset-${i}`, timelineStart: i * 2, duration: 1 })) }));
  project.captions = Array.from({ length: count }, (_, i) => ({ id: `caption-${i}`, text: `CAPTION_${i.toString().padStart(5, "0")}`, start: i * 2, duration: 1 }));
  project.motionGraphics = Array.from({ length: count }, (_, i) => ({ ...createMotionGraphic(`graphic-${i}`, "title", `Graphic ${i}`, i * 2, 1), name: `GRAPHIC_${i.toString().padStart(5, "0")}` }));
  return project;
}
type Node = ReactElement<{ children?: ReactNode; "data-row"?: string; disabled?: boolean; onClick?: () => void }>;
function nodes(node: ReactNode, output: Node[] = []): Node[] {
  if (Array.isArray(node)) node.forEach(child => nodes(child, output));
  else if (isValidElement<Node["props"]>(node)) { output.push(node); nodes(node.props.children, output); }
  return output;
}
function renderSelection(project: ReturnType<typeof layerNavigationFixtureV1>, selection: EditingLayerSelectionV1) {
  return renderToStaticMarkup(<EditingLayerStackV1 project={project} selection={selection} onSelect={() => assert.fail("SSR must not select")}
    onCommand={() => assert.fail("SSR must not mutate")} />);
}

describe("selected layer navigation with bounded metadata indexes", () => {
  it("follows selectedidentity/index immediately while manual paging remains possible and old callbacks cannot move a new anchor", () => {
    const first = editingLayerPageV1(65, "clip-43", 43); assert.equal(first.start, 40);
    assert.equal(editingLayerPageV1(65, "clip-43", 43, { anchor: first.anchor, offset: 0 }).start, 0);
    assert.equal(editingLayerPageV1(65, "clip-44", 44, { anchor: first.anchor, offset: 0 }).start, 40);
    assert.equal(editingLayerPageV1(65, "clip-43", 64, { anchor: first.anchor, offset: 0 }).start, 60);
    const moved = editingLayerPageV1(65, "clip-43", 64);
    assert.equal(editingLayerPageV1(65, "clip-43", 43, { anchor: moved.anchor, offset: 60 }).start, 40);
  });
  it("clamps pages after deletion and handles empty,invalid,missing selections and original20row boundaries", () => {
    for (const count of [0, 1, 20]) assert.equal(editingLayerPageV1(count, undefined, -1).start, 0);
    assert.equal(editingLayerPageV1(21, "last", 20).start, 20);
    const selected = editingLayerPageV1(65, "last", 64);
    assert.equal(editingLayerPageV1(9, "last", 64, { anchor: selected.anchor, offset: 60 }).start, 0);
    for (const count of [-1, NaN, Infinity, .5]) assert.equal(editingLayerPageV1(count, "x", 0).start, 0);
    assert.equal(editingLayerPageV1(65, "missing", -1).start, 0);
    assert.equal(editingLayerPageV1(65, "x", 64, { anchor: editingLayerPageV1(65, "x", 64).anchor, offset: Infinity }).start, 60);
  });
  it("auto-opens the selected section but preserves manual collapse for that selection and manual opens elsewhere", () => {
    assert.equal(editingLayerDisclosureOpenV1(undefined, "selected-a", true), true);
    assert.equal(editingLayerDisclosureOpenV1(undefined, "selected-a", false), false);
    const closed = { anchor: "selected-a", open: false }, opened = { anchor: "selected-a", open: true };
    assert.equal(editingLayerDisclosureOpenV1(closed, "selected-a", true), false);
    assert.equal(editingLayerDisclosureOpenV1(closed, "selected-b", true), true);
    assert.equal(editingLayerDisclosureOpenV1(closed, "selected-b", false), false);
    assert.equal(editingLayerDisclosureOpenV1(opened, "selected-b", false), true);
  });
  it("distinct selection occurrence tokens cannot reuse a previous occurrence's collapsed state", () => {
    const firstA = {}, selectedB = {}, returnedA = {}, closed = { anchor: firstA, open: false };
    assert.equal(editingLayerDisclosureOpenV1(closed, firstA, true), false);
    assert.equal(editingLayerDisclosureOpenV1(closed, selectedB, true), true);
    assert.equal(editingLayerDisclosureOpenV1(closed, returnedA, true), true);
    assert.equal(editingLayerDisclosureOpenV1({ anchor: firstA, open: true }, returnedA, false), true);
  });
  it("indexed neighbor commands exactly match the unchanged canonical helper across kinds,edges and all lock combinations", () => {
    for (let mask = 0; mask < 8; mask++) {
      const tracks: TimelineTrack[] = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, kind: (["video", "audio", "caption"] as const)[i % 3], muted: false, locked: Boolean(mask & (1 << Math.floor(i / 3))), clips: [] }));
      const index = createEditingTrackIndexV1(tracks);
      for (const track of tracks) for (const direction of ["up", "down"] as const) assert.deepEqual(index.adjacentCommand(track.id, direction), adjacentTrackLayerCommandV1({ tracks }, track.id, direction));
      assert.throws(() => index.adjacentCommand("missing", "up"), /指定的圖層已不存在/);
    }
  });
  it("retains actual project references,finds all three selection kinds and never edits the project", () => {
    const project = layerNavigationFixtureV1(), before = JSON.stringify(project), index = createEditingTrackIndexV1(project.tracks);
    assert.equal(index.displayTracks[0], project.tracks[0]); assert.equal(index.clips.get("clip-0-43")!.track, project.tracks[0]);
    assert.deepEqual(editingLayerLocationV1(index, project.captions, project.motionGraphics, { kind: "clip", id: "clip-0-43" }), { kind: "clip", id: "clip-0-43", trackId: "track-0", index: 43 });
    for (const kind of ["caption", "graphic"] as const) assert.equal(editingLayerLocationV1(index, project.captions, project.motionGraphics, { kind, id: `${kind}-43` })!.index, 43);
    for (const kind of ["clip", "caption", "graphic"] as const) assert.equal(editingLayerLocationV1(index, project.captions, project.motionGraphics, { kind, id: "missing" }), undefined);
    assert.equal(editingLayerLocationV1(index, project.captions, project.motionGraphics), undefined); assert.equal(JSON.stringify(project), before);
  });
  it("actual page renderer creates only the selected20rows and its original previous/next handlers navigate correctly", () => {
    const items = Array.from({ length: 65 }, (_, i) => ({ id: `row-${i}` })), offsets: number[] = [];
    const tree = renderEditingLayerPageV1({ items, start: 40, render: item => <span key={item.id} data-row={item.id}>{item.id}</span>, onNavigate: offset => offsets.push(offset) });
    assert.deepEqual(nodes(tree).filter(node => node.props["data-row"]).map(node => node.props["data-row"]), items.slice(40, 60).map(item => item.id));
    const buttons = nodes(tree).filter(node => node.type === "button"); buttons[0].props.onClick!(); buttons[1].props.onClick!(); assert.deepEqual(offsets, [20, 60]);
    for (const [start, disabledIndex] of [[0, 0], [60, 1]] as const) assert.equal(nodes(renderEditingLayerPageV1({ items, start, render: () => null, onNavigate: () => {} })).filter(node => node.type === "button")[disabledIndex].props.disabled, true);
  });
  it("actual SSR shows selected off-page clip,caption and graphic and opens their containing sections", () => {
    const project = layerNavigationFixtureV1();
    for (const [kind, id, label] of [["clip", "clip-0-43", "ASSET_00043"], ["caption", "caption-43", "CAPTION_00043"], ["graphic", "graphic-55", "GRAPHIC_00055"]] as const) {
      const html = renderSelection(project, { kind, id });
      assert(html.includes(label), `${kind} selected content missing`); assert(html.includes(`data-layer-id="${id}"`));
      assert.equal((html.match(/<button[^>]*data-layer-id="[^"]+"[^>]*aria-pressed="true"/g) ?? []).length, 1);
      if (kind !== "clip") assert(html.includes('<details open="">'));
    }
  });
  it("actual SSR follows a selected track beyond the first20tracks and its clip beyond the first20clips", () => {
    const project = layerNavigationFixtureV1(65, 65), html = renderSelection(project, { kind: "clip", id: "clip-0-43" });
    assert(html.includes("TRACK_00000")); assert(html.includes("ASSET_00043")); assert(!html.includes("TRACK_00064"));
    assert.equal((html.match(/data-layer-kind="clip"/g) ?? []).length, 20);
  });
  it("actual index supports ten-thousand metadata clips without creating media or copying clip objects", () => {
    const project = createDemoProject(), clip = project.tracks[0].clips[0];
    project.tracks[0].clips = Array.from({ length: 10_001 }, (_, i) => ({ ...clip, id: `long-${i}` }));
    const index = createEditingTrackIndexV1(project.tracks), found = index.clips.get("long-10000")!;
    assert.equal(index.clips.size, 10_001); assert.equal(found.track.clips[found.index], project.tracks[0].clips[10_000]);
    assert.equal(editingLayerPageV1(found.track.clips.length, "long-10000", found.index).start, 10_000);
  });
  it("indexed reorder command still uses original schema,one history step and exact Undo/Redo", () => {
    const project = createDemoProject();
    project.tracks = [project.tracks[0], { ...structuredClone(project.tracks[0]), id: "top", name: "Top", clips: [] }];
    const command = createEditingTrackIndexV1(project.tracks).adjacentCommand(project.tracks[0].id, "up")!;
    const before = createHistory(project), after = dispatchCommand(before, command);
    assert.deepEqual(after.present.tracks.map(track => track.id), ["top", "video-main"]); assert.equal(after.past.length, before.past.length + 1);
    assert.deepEqual(projectSchema.parse(JSON.parse(JSON.stringify(after.present))), after.present);
    assert.deepEqual(undo(after).present, project); assert.deepEqual(redo(undo(after)).present, after.present);
  });
  it("actual React SSR preserves selected content and labels in all five locales without dispatching", async () => {
    const project = layerNavigationFixtureV1(), before = JSON.stringify(project);
    try { for (const locale of ["zh-TW", "en", "es", "ja", "ko"] as const) {
      await interfacePreferences.setLocale(locale); const html = renderSelection(project, { kind: "graphic", id: "graphic-55" });
      assert(html.includes("GRAPHIC_00055")); assert(html.includes(interfacePreferences.translate("圖層")), locale);
      assert(html.includes(interfacePreferences.translate("動態圖層")), locale);
    } } finally { await interfacePreferences.setLocale("zh-TW"); }
    assert.equal(JSON.stringify(project), before);
  });
});
