import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { CURRENT_MEDIA_PREVIEW_RECIPE, isMediaPreviewCurrent } from "../application/mediaDerivativeColor";
import { createProjectSession, type ProjectSession } from "../application/projectSession";
import { parseProject } from "../application/projectFiles";
import { createDemoProject } from "../domain/demo";
import { dispatchCommand } from "../domain/history";
import type { MediaAsset, MediaDerivatives } from "../domain/types";
import type { HaoDesktopApi, PrepareMediaResult } from "./types";
import { useMediaPreviewRepair } from "./useMediaPreviewRepair";

// Minimal React host: the production hook and ProjectSession are real. This
// does not claim browser/video decoder coverage.
const documentHost: any = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null };
const windowHost: any = { document: documentHost, addEventListener() {}, removeEventListener() {}, HTMLElement: class {}, HTMLIFrameElement: class {} };
documentHost.defaultView = windowHost;
Object.assign(globalThis, { window: windowHost, document: documentHost, IS_REACT_ACT_ENVIRONMENT: true });
const container = () => ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: documentHost,
  addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, textContent: "" }) as any;
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject }; };

function legacyProject() {
  const raw = structuredClone(createDemoProject());
  const asset = raw.assets[0]!;
  asset.derivatives = {
    sourceSha256: "a".repeat(64), proxyUri: "C:/old-cache/v6/proxy.mp4",
    thumbnailUri: "C:/old-cache/v6/thumbnail.jpg", generatedAt: "2026-08-31T00:00:00.000Z",
    proxyColorContract: "editkin.browser-display-proxy/v1",
    proxyColor: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
  };
  // Real project parser must preserve a historical project with no recipe.
  return parseProject(JSON.parse(JSON.stringify(raw)));
}
function prepared(asset: MediaAsset, recipe: string | null = CURRENT_MEDIA_PREVIEW_RECIPE): PrepareMediaResult {
  const derivatives: MediaDerivatives = {
    sourceSha256: "a".repeat(64), proxyUri: "C:/new-cache/v7/proxy.mp4",
    thumbnailUri: "C:/new-cache/v7/thumbnail.jpg", generatedAt: "2026-09-01T00:00:00.000Z",
    proxyColorContract: "editkin.browser-display-proxy/v1",
    proxyColor: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
    ...(recipe ? { previewRecipe: recipe } : {}),
  };
  return { assetId: asset.id, derivatives, runtimeUrls: { [asset.id]: "asset://new-v7-proxy" }, cacheHit: false };
}
async function fixture() {
  const initial = legacyProject(), session = createProjectSession(initial), jobs: ReturnType<typeof deferred<PrepareMediaResult>>[] = [], submitted: MediaAsset[] = [];
  const api = { prepareMedia: (asset: MediaAsset) => { submitted.push(structuredClone(asset)); const job = deferred<PrepareMediaResult>(); jobs.push(job); return job.promise; } } as unknown as HaoDesktopApi;
  let hook!: ReturnType<typeof useMediaPreviewRepair>;
  const root: Root = createRoot(container());
  function Component() {
    useSyncExternalStore(session.subscribe, session.getSnapshot);
    hook = useMediaPreviewRepair(api, session, (items, current = () => true) => {
      if (!current()) return;
      const live = new Map(session.getSnapshot().history.present.assets.map(asset => [asset.id, asset.uri]));
      session.applyMediaDerivatives(items.filter(item => live.has(item.assetId)).map(item => ({ assetId: item.assetId, sourceUri: live.get(item.assetId)!, derivatives: item.derivatives })));
    });
    return null;
  }
  await act(async () => root.render(createElement(Component)));
  return { initial, session, jobs, submitted, root, get hook() { return hook; }, asset: initial.assets[0]! };
}
async function settle(job: ReturnType<typeof deferred<PrepareMediaResult>>, result: PrepareMediaResult, task: Promise<void>) {
  await act(async () => { job.resolve(result); await task; });
}

describe("historical preview freshness repair", () => {
  it("loads and displays v6 metadata, but accepts only a newly prepared current recipe from the original URI", async () => {
    const f = await fixture();
    try {
      expect(f.asset.derivatives?.proxyUri).toContain("old-cache/v6");
      expect(isMediaPreviewCurrent(f.asset.derivatives)).toBe(false);
      let task!: Promise<void>;
      await act(async () => { task = f.hook.repairPreview(f.asset.id); });
      expect(f.submitted).toHaveLength(1);
      expect(f.submitted[0]!.uri).toBe(f.asset.uri);
      expect(f.submitted[0]!.derivatives?.proxyUri).toContain("old-cache/v6");
      // Passing the asset preserves evidence, but native prepare_media is bound
      // to asset.uri; the old proxy is never promoted to sourceUri.
      const obsolete = prepared(f.asset, null);
      await settle(f.jobs[0]!, obsolete, task);
      expect(f.hook.previewRepair?.phase).toBe("failed");
      expect(f.session.getSnapshot().history.present.assets[0]!.derivatives).toEqual(f.asset.derivatives);

      await act(async () => { task = f.hook.repairPreview(f.asset.id); });
      await settle(f.jobs[1]!, prepared(f.asset), task);
      const current = f.session.getSnapshot().history.present.assets[0]!;
      expect(current.uri).toBe(f.asset.uri);
      expect(current.derivatives?.previewRecipe).toBe(CURRENT_MEDIA_PREVIEW_RECIPE);
      expect(isMediaPreviewCurrent(current.derivatives)).toBe(true);
      expect(f.hook.previewRepair?.phase).toBe("prepared");
      const reopened = parseProject(JSON.parse(JSON.stringify(f.session.getSnapshot().history.present)));
      expect(reopened.assets[0]!.derivatives?.previewRecipe).toBe(CURRENT_MEDIA_PREVIEW_RECIPE);
      expect(isMediaPreviewCurrent(reopened.assets[0]!.derivatives)).toBe(true);
    } finally { await act(async () => f.root.unmount()); }
  });

  it("rejects an explicit foreign recipe and keeps the old persisted proxy visible", async () => {
    const f = await fixture();
    try {
      let task!: Promise<void>; await act(async () => { task = f.hook.repairPreview(f.asset.id); });
      await settle(f.jobs[0]!, prepared(f.asset, "retired-or-foreign/2026-08-31"), task);
      expect(f.hook.previewRepair).toMatchObject({ phase: "failed", message: expect.stringContaining("目前版本") });
      expect(f.session.getSnapshot().history.present).toBe(f.initial);
    } finally { await act(async () => f.root.unmount()); }
  });

  it("preserves concurrent edits, while relink/session replacement drops stale completion", async () => {
    const f = await fixture();
    try {
      let task!: Promise<void>; await act(async () => { task = f.hook.repairPreview(f.asset.id); });
      await act(async () => f.session.setHistory(history => dispatchCommand(history, { type: "update_clip_transform", clipId: f.initial.tracks[0]!.clips[0]!.id, patch: { x: 41 } })));
      await settle(f.jobs[0]!, prepared(f.asset), task);
      expect(f.session.getSnapshot().history.present.tracks[0]!.clips[0]!.transform.x).toBe(41);
      expect(f.session.getSnapshot().history.present.assets[0]!.derivatives?.previewRecipe).toBe(CURRENT_MEDIA_PREVIEW_RECIPE);

      await act(async () => { task = f.hook.repairPreview(f.asset.id); });
      await act(async () => f.session.setHistory(history => ({ ...history, present: { ...history.present, assets: history.present.assets.map(asset => asset.id === f.asset.id ? { ...asset, uri: "D:/relinked.mov" } : asset) } })));
      const relinked = f.session.getSnapshot().history.present;
      await settle(f.jobs[1]!, prepared(f.asset), task);
      expect(f.session.getSnapshot().history.present).toBe(relinked);

      await act(async () => { task = f.hook.repairPreview(f.asset.id); });
      await act(async () => f.session.replaceProject(legacyProject()));
      const replacement = f.session.getSnapshot().history.present;
      await settle(f.jobs[2]!, prepared(f.asset), task);
      expect(f.session.getSnapshot().history.present).toBe(replacement);
    } finally { await act(async () => f.root.unmount()); }
  });
});
