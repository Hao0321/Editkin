/** Shared source engine identity; installed adoption is verified separately. */
export const EDITKIN_MOTION = {
  id: "editkin-motion",
  name: "Editkin Motion",
  label: "動態設計引擎",
  schemas: ["hao.motion-composition/v1", "hao.motion-composition/v2", "editkin.motion-scene-2d/v1"],
  commonBase: "editkin.scene-glyph-spring/v1",
  templateUpgradePolicy: "Preserve editable replacement slots and explicit scene targets; validate each migrated family on this generation before delivery",
  comparisonStatus: "unmeasured",
} as const;
