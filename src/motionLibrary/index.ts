/**
 * Editkin Motion Library 120 — browser-safe public surface.
 *
 * Item authors: see items/text/T01_wordBurst.ts, items/transitions/X01_colorWipe.ts
 * and items/backgrounds/B01_halftoneExpand.ts, then register the export in
 * catalog.ts IMPLEMENTATIONS. Node-only rendering lives in
 * render/renderItem.ts (renderMotionLibraryItem) and is not re-exported here.
 */
export * from "./types";
export * from "./palettes";
export * from "./params";
export * from "./catalog";
export * from "./certifications";
export * from "./frames";
export * as motionSvg from "./svg/document";
export * as motionGlyphs from "./svg/glyphs";
export * as motionEasing from "./svg/easing";
export * as motionRandom from "./svg/random";
export * as motionProject3d from "./svg/project3d";
export * as motionColor from "./svg/color";
export * as motionRoughen from "./svg/roughen";
export { MotionLibraryGlyphError } from "./svg/glyphs";
