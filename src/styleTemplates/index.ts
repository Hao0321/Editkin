/**
 * Editkin style templates v1 (browser-safe entry). Node-only code lives in
 * render/ (clip encoding) and review/ (Claude's art-review harness).
 */
export * from "./types";
export * from "./palette";
export * from "./placement";
export * from "./jobs";
export * from "./compiler";
export { getStyleTemplateV1, parseStyleTemplateV1, styleTemplateCatalogV1 } from "./templates";
export { kineticCaptionFrame, layoutKineticCaption, captionWordStates, wordEntryPose, CAPTION_MAX_BLUR_PX, type KineticCaptionParams } from "./components/kineticCaption";
export { sectionTitleFrame, layoutSectionTitle, type SectionTitleParams } from "./components/sectionTitle";
export { lightLeakFrame, lightLeakEnvelope, type LightLeakParams } from "./components/lightLeak";
export { punchInCommands, punchInKeys, evaluatePunchInKeys, styleLookCommands, styleLookFor, styleLookGrade } from "./components/finish";
