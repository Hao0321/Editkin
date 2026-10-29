import type { Mesh3dScene } from "../../motion/mesh3dScene";
import type { MipChainV1, RasterV1 } from "./raster";

/**
 * Composited template clips (browser-safe types). A component that is not a per-frame SVG document is built from layers
 * by the template compositor (compositeRender.ts, Node only):
 *
 * - **pieces**: static SVG art (torn photo plates, paper tags, a wordmark with its shadow…) rasterized once per clip by the
 *   bundled librsvg and posed per frame;
 * - **textures**: SVG art rasterized once into straight RGBA engine textures (a device screen showing a picture slot, a UI
 *   card, a keyboard, a text band);
 * - **passes**: mesh3d engine renders of the frame (renderMesh3dFrame on a Mesh3dWorkerPoolV1, supersampled and
 *   box-filtered), opaque, matted by depth, or matted exactly from two renders over black and white;
 * - **overlays**: per-frame SVG documents (type) rasterized by librsvg;
 * - and `composite`, a pure function that lays them together with light drawn in TypeScript (raster.ts).
 *
 * Everything is a function of (params, t) and the slot pictures' bytes, so the clip is reproducible and preview == export.
 */

/** A complete SVG document rasterized once (pixel size = width × height). */
export interface StyleSvgArtV1 {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

export type StyleCompositeMatteV1 = "opaque" | "depth" | "difference";

export interface StyleCompositePassV1 {
  readonly id: string;
  /** A valid editkin.mesh-scene/v1 (the component builds it already parsed or parse-ready). */
  readonly scene: Mesh3dScene;
  /** Scene time (s). */
  readonly time: number;
  /** opaque: the rendered frame, background included. depth: coverage from the depth buffer (opaque draws). difference: exact
   * premultiplied colour and alpha from a render over black and one over white (the scene background is replaced). */
  readonly matte: StyleCompositeMatteV1;
  /** Supersampling factor per axis (default 2); the raster stays within the engine's 4K pixel budget. */
  readonly ss?: number;
  /** Engine NDC depth thresholds: for each name, the coverage of pixels nearer than it. */
  readonly splits?: Readonly<Record<string, number>>;
  /** Render at this fraction of the output size (a blurred reflection needs less); default 1. */
  readonly resolution?: number;
}

export interface StyleCompositeFrameV1 {
  readonly passes: readonly StyleCompositePassV1[];
  /** Frame-size SVG documents rasterized for this frame, by layer name (the same names every frame). */
  readonly overlays: Readonly<Record<string, string>>;
}

export interface StyleCompositePassLayerV1 {
  readonly width: number;
  readonly height: number;
  /** Premultiplied RGB (opaque passes: the colour). */
  readonly color: Float32Array;
  readonly alpha: Float32Array;
  /** Nearest engine NDC depth per pixel (Infinity: background). */
  readonly depth: Float32Array;
  readonly splits: Readonly<Record<string, Float32Array>>;
}

export interface StyleCompositeLayersV1 {
  readonly passes: Readonly<Record<string, StyleCompositePassLayerV1>>;
  /** Premultiplied RGBA at the frame size. */
  readonly overlays: Readonly<Record<string, RasterV1>>;
  readonly pieces: Readonly<Record<string, MipChainV1>>;
}

export interface StyleCompositeHooksV1 {
  /** Static art, rasterized once (premultiplied), by name. `images` are the slot pictures as data URIs. */
  pieces?(params: Record<string, unknown>, images: Readonly<Record<string, string>>): Readonly<Record<string, StyleSvgArtV1>>;
  /**
   * Pixel work on the rasterized pieces, once per clip (torn paper, halftone, a sky key, baked shadows): receives every
   * piece (premultiplied) and returns the pieces the frames use. Pure and deterministic.
   */
  refine?(params: Record<string, unknown>, pieces: Readonly<Record<string, RasterV1>>): Readonly<Record<string, RasterV1>>;
  /** Engine textures (straight RGBA), by the material clipId the scenes use. */
  textures?(params: Record<string, unknown>, images: Readonly<Record<string, string>>): Readonly<Record<string, StyleSvgArtV1>>;
  /** What frame `index` (local time t) needs. */
  frame(params: Record<string, unknown>, t: number, index: number): StyleCompositeFrameV1;
  /** Lays the layers together into `out` (frame size; 3 channels for an opaque clip, premultiplied 4 for an alpha clip). */
  composite(params: Record<string, unknown>, t: number, index: number, layers: StyleCompositeLayersV1, out: RasterV1): void;
  /** Lays out every string the clip draws (2D and 3D); throws MotionLibraryGlyphError for a character no bundled face draws. */
  preflight(params: Record<string, unknown>): void;
}
