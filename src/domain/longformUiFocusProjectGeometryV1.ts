export interface LongformUiFocusRasterSizeV1 { width: number; height: number }
/** Internal actual-filter observation. Metadata alone grants no source/OCR or
 * public MCP ownership; the source owner must bind it to its current clock. */
export interface LongformUiFocusGeometryWitnessV1 {
  schema: "editkin.longform-ui-focus-geometry-witness/v1";
  projectFrame: number;
  geometryPts: number;
  timeBase: { numerator: number; denominator: number };
  fit: LongformUiFocusRasterSizeV1;
  layout: LongformUiFocusRasterSizeV1;
  affine: {
    mode: "scale-rotate" | "fixed-perspective";
    input: LongformUiFocusRasterSizeV1;
    scaled: LongformUiFocusRasterSizeV1;
    output: LongformUiFocusRasterSizeV1;
  };
  /** Actual overlay xi/yi, after the filter's pixel-grid quantization. */
  placement: { x: number; y: number };
}
export interface LongformUiFocusProjectedQuadV1 {
  schema: "editkin.longform-ui-focus-projected-quad/v1";
  projectFrame: number;
  geometryTime: number;
  projectTime: number;
  projectQuad: Array<{ x: number; y: number }>;
  clipOpacity: number;
  coordinateSpace: "project-display";
  stageGeometryProjected: true;
  sourceTargetVerified: false;
  editableProjectGraphCompiled: false;
  nativePresentationVerified: false;
  browserPresentationVerified: false;
  projectModified: false;
  focusHintsReady: false;
  artworkStatus: "ART_PENDING_CLAUDE";
  selectableByDefault: false;
}
