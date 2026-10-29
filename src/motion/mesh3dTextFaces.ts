import { MOTION_FONT_REGISTRY, MOTION_FONT_ROLES, type MotionFontRole } from "../motionLibrary/svg/glyphs";

/**
 * Physical faces for extruded / band text. The roles and static weights are the
 * Motion Library's (one font registry for 2D glyph motion and 3D glyph meshes);
 * a weight must exist exactly, nothing is snapped or synthesised.
 */
export const MESH3D_TEXT_FONT_ROLES = MOTION_FONT_ROLES;
export type Mesh3dTextFontRole = MotionFontRole;

export function mesh3dTextWeightAvailableV1(font: Mesh3dTextFontRole, weight: number): boolean {
  return MOTION_FONT_REGISTRY[font]?.weights.includes(weight) ?? false;
}

/** Bundled face ID (`EditkinFace-<id>-<weight>`) whose compiled SHA-256 the loader must verify. */
export function mesh3dTextFaceIdV1(font: Mesh3dTextFontRole, weight: number): string {
  if (!mesh3dTextWeightAvailableV1(font, weight)) throw new Error(`MESH_TEXT_FACE_UNAVAILABLE: ${String(font)} ${String(weight)}`);
  return `EditkinFace-${MOTION_FONT_REGISTRY[font].fontId}-${weight}`;
}
