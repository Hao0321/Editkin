import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
const h = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, start: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (value: unknown) => [typeof value === "function" ? (value as () => unknown)() : value, vi.fn()], useRef: (current: unknown) => ({ current }),
  useMemo: (factory: () => unknown) => factory(), useDeferredValue: (value: unknown) => value, useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => h.effects.push(effect),
}));
vi.mock("./internalAssetPointerDrag", () => ({ startInternalAssetPointerDrag: h.start }));
import { MediaBin } from "./MediaBin";
import CreativeLibraryBrowser from "./CreativeLibraryBrowser";
import type { MediaAsset } from "../domain/types";
import type { CreativeLibrarySummary } from "../application/creativeLibrary";

function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props?.children as ReactNode)];
}
const asset: MediaAsset = { id: "real-imported-id", kind: "video", name: "Actual project source", uri: "owned.mp4", duration: 2.017 };
beforeEach(() => { h.effects.length = 0; h.start.mockReset(); });
describe("project asset and library pointer wiring", () => {
  it("passes the actual imported asset ID and preserves start/end callbacks with owned unmount cleanup", () => {
    const onStart = vi.fn(), onEnd = vi.fn(), cleanup = vi.fn();
    h.start.mockImplementation((_event, options) => { options.onStart(options.assetId); cleanup.mockImplementation(() => options.onEnd()); return cleanup; });
    const tree = MediaBin({ assets: [asset], runtimeUrls: {}, onImport: vi.fn(), onAssetDragStart: onStart, onAssetDragEnd: onEnd });
    const row = elements(tree).find(node => node.props.className === "asset-row")!;
    expect(row.props.draggable).toBe(false); expect(row.props.style).toMatchObject({ touchAction: "none" });
    const event = { currentTarget: { ownerDocument: "explicit-adapter" } };
    (row.props.onPointerDown as (event: unknown) => void)(event);
    expect(h.start).toHaveBeenCalledWith(event, expect.objectContaining({ assetId: asset.id }));
    expect(onStart).toHaveBeenCalledExactlyOnceWith(asset.id);
    const cleanups = h.effects.map(effect => effect()).filter((value): value is () => void => typeof value === "function");
    for (const stop of cleanups) stop();
    expect(cleanup).toHaveBeenCalledTimes(1); expect(onEnd).toHaveBeenCalledTimes(1);
  });
  it("a rejected control pointer does not erase an already owned cleanup and native row drag is prevented", () => {
    const cleanup = vi.fn(); h.start.mockReturnValueOnce(cleanup).mockReturnValueOnce(undefined);
    const tree = MediaBin({ assets: [asset], runtimeUrls: {}, onImport: vi.fn() });
    const row = elements(tree).find(node => node.props.className === "asset-row")!;
    (row.props.onPointerDown as (event: unknown) => void)({}); (row.props.onPointerDown as (event: unknown) => void)({});
    const event = { preventDefault: vi.fn() }; (row.props.onDragStart as (value: typeof event) => void)(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    for (const effect of h.effects) { const stop = effect(); if (stop) stop(); }
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("library cards require the real Add import rather than advertising an unknown project asset ID", () => {
    const library: CreativeLibrarySummary = { id: "fixture", name: "Fixture", version: "1", attribution: "Original fixture", assetCount: 1, assetBytes: 100,
      musicAssetCount: 0, sfxAssetCount: 0, restrictedAssetCount: 0, assets: [{ id: "library:actual", name: "Library source", category: "broll", role: "context",
        domains: ["general"], mediaKind: "video", bytes: 100, license: "CC0-1.0", provenance: "Original fixture" }] };
    const onImport = vi.fn(), tree = CreativeLibraryBrowser({ library, onImport });
    const nodes = elements(tree), card = nodes.find(node => node.props.className === "creative-asset-card")!;
    expect(card.props.draggable).toBe(false); expect(card.props).not.toHaveProperty("onPointerDown");
    expect(card.props.title).toContain("先按加入取得真素材");
    const add = nodes.find(node => node.props["aria-label"] === "加入 Library source")!;
    (add.props.onClick as () => void)(); expect(onImport).toHaveBeenCalledExactlyOnceWith("library:actual");
    expect(h.start).not.toHaveBeenCalled();
  });
});
