import type { MotionArtStatus } from "./types";

/**
 * Claude's art certifications (the CERTIFICATION.md ledger), each pinned to the
 * item revision Claude reviewed in a real render. An item reads artStatus
 * "certified" only while its implementation is still at that revision: any later
 * art change bumps the revision (catalog.ts header), so the item drops back to
 * "pending" until Claude reviews the new render and moves the pin.
 *
 * Only Claude edits this file; batch agents leave it alone. VA and the GUI offer
 * certified items by default (PHASE3_INTEGRATION_DESIGN.md).
 */
export const MOTION_ART_CERTIFICATIONS: Readonly<Record<string, number>> = Object.freeze({
  // Phase 1 and p2a-impact after the ART_DIRECTION §0 overhaul (sheets/art-overhaul, 2026-10-15/16).
  T01: 3, T02: 3, T03: 3, T04: 4, T05: 4, T06: 3, T07: 2, T08: 2, T41: 3, T42: 2, T43: 3,
  // p2b-flow (2026-10-15).
  T09: 1, T10: 1, T11: 1, T12: 1, T13: 1, T14: 1, T15: 1, T16: 1, T49: 1, T51: 2,
  // p2d-switch (2026-10-16; T26 on its accent plate, T30 with three headlines, T46 r2 glow re-reviewed).
  T25: 1, T26: 1, T27: 1, T28: 1, T29: 1, T30: 1, T32: 1, T46: 2, T48: 1, T72: 1,
  // p2c-depth (2026-10-22; T17 r2 and T55 r2 re-reviewed). T24 is certified for the library only (no VA default).
  T17: 2, T18: 1, T19: 1, T20: 1, T23: 1, T24: 1, T47: 1, T55: 2, T57: 1,
  // p2e-style (2026-10-22).
  T33: 1, T34: 1, T35: 1, T36: 1, T37: 1, T38: 1, T39: 1, T50: 1, T52: 1, T54: 1,
  // p2i-helpers-a and p2j-helpers-b (2026-10-22; T40 r2 and T62 r2 re-reviewed).
  T21: 1, T22: 1, T31: 1, T40: 2, T44: 1, T45: 1, T53: 1, T56: 1, T61: 1, T64: 1,
  T58: 1, T59: 1, T60: 1, T62: 2, T63: 1, T65: 1, T66: 1, T67: 1, T68: 1, T69: 1,
  // p2k-helpers-c (2026-10-22; T71 r2 and T80 r2 re-reviewed): the text set T01–T80 is complete.
  T70: 1, T71: 2, T80: 2, T73: 1, T74: 1, T75: 1, T76: 1, T77: 1, T78: 1, T79: 1,
  // X01 (Phase 1) and p2f-trans1 (2026-10-15).
  X01: 2, X02: 1, X03: 1, X04: 1, X05: 2, X06: 1, X07: 1, X08: 1, X09: 1, X10: 1, X11: 2, X12: 1,
  // p2g-trans2 (2026-10-16).
  X13: 1, X14: 1, X15: 2, X16: 3, X17: 1, X18: 2, X19: 1, X20: 1, X21: 1, X22: 1, X23: 1, X24: 2,
  // p2h-bg1 after the ART_DIRECTION §10 restyle (2026-10-16); B01 r4 and B07 r3 re-reviewed 2026-10-22.
  B01: 4, B02: 2, B03: 3, B04: 2, B05: 3, B06: 2, B07: 3, B08: 2, B09: 2, B10: 2, B11: 2, B12: 2,
  // p2n-bg2 (2026-10-22; B16, B22 and B24 r2 re-reviewed for H.264).
  B13: 1, B14: 1, B15: 1, B16: 2, B17: 1, B18: 1, B19: 1, B20: 1, B21: 1, B22: 2, B23: 1, B24: 2,
  // p2o-bg3 and p2p-bg4 (2026-10-22): the background set B01–B40 is complete.
  B25: 1, B26: 1, B27: 1, B28: 1, B29: 1, B30: 1, B31: 1, B32: 1,
  B33: 1, B34: 1, B35: 1, B36: 1, B37: 1, B38: 1, B39: 1, B40: 1,
  // p2l-trans3 (2026-10-22; X32 r4 re-reviewed).
  X25: 1, X26: 1, X27: 1, X28: 1, X29: 2, X30: 1, X31: 1, X32: 4,
  // p2m-trans4 (2026-10-22): the transition set X01–X40 is complete.
  X33: 1, X34: 1, X35: 2, X36: 1, X37: 2, X38: 1, X39: 2, X40: 1,
});

/** "certified" only when Claude's pin matches the item's current revision. */
export function motionArtStatus(id: string, revision: number): MotionArtStatus {
  return MOTION_ART_CERTIFICATIONS[id] === revision ? "certified" : "pending";
}
