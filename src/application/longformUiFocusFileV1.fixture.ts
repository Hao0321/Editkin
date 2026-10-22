import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { uiFocusFixtureV1 } from "./longformUiFocusV1.fixture";
import { assembleLongformUiFocusDraftV1 } from "./longformUiFocusV1";
import { colorDigest } from "./materialColorSamplingRuntime";
import { sealLongformUiFocusArtifactV1 } from "./longformUiFocusArtifactV1";

/** Protocol fixture only. Pixels/decoder/OCR in physical evidence are real. */
export function uiFocusFileFixtureV1(root: string, sourcePath: string, hash = "a".repeat(64)) {
  const f = uiFocusFixtureV1(); f.source.sha256 = hash; f.frame.display.source.sha256 = hash; f.reseal();
  const project = createEmptyProject("Owned UI focus protocol fixture", { id: "uif-owned", width: 1280, height: 720, fps: 30 });
  project.assets = [{ id: "asset", name: "Owned source", uri: sourcePath, kind: "video", duration: 2, width: 960, height: 640 }];
  const track = project.tracks.find(track => track.kind === "video")!;
  track.clips = [{ id: "screen", assetId: "asset", trackId: track.id, timelineStart: 0, sourceStart: .05, duration: 1,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const request = { projectPath: root + "/owned.editkin.json", expectedRevision: project.revision, clipId: "screen",
    language: "zh-Hant-TW", frameTimes: [.1], targetTexts: ["儲存專案"] };
  const draft = assembleLongformUiFocusDraftV1(f.source, [f.frame], [], request.targetTexts);
  const artifact = sealLongformUiFocusArtifactV1({ schema: "editkin.longform-ui-focus-artifact/v1", algorithmSha256: hash, request,
    project: { id: project.id, revision: project.revision, canonicalSha256: colorDigest(project), clipId: "screen", assetId: "asset" }, sourcePath, draft });
  return { ...f, project, request, draft, artifact };
}
