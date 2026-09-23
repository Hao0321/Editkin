import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { migrateProject, validateProject } from "../domain/editGraph";
import { projectSchema } from "../domain/schema";
import { DEFAULT_SCENE_25D, DEFAULT_TRANSFORM_3D } from "../domain/types";
import { buildEngineRenderGraph } from "./engineGraph";
import { applyCommand } from "../domain/commands";
import { editorCommandSchema } from "../domain/schema";

function sceneProject() {
  const project = createDemoProject();
  project.assets[0].kind = "image";
  project.assets[0].uri = "C:/plates/back.png";
  project.scene25d = structuredClone(DEFAULT_SCENE_25D);
  const back = project.tracks[0].clips[0];
  back.transform3d = { ...structuredClone(DEFAULT_TRANSFORM_3D), scale: [1.3, 1.3, 1] };
  const front = structuredClone(back);
  front.id = "front";
  front.trackId = "video-front";
  front.transform3d = { position: [.22, -.08, .72], rotationDegrees: [-7, 24, 5], scale: [.56, .56, 1] };
  front.layer = { enabled: true, blendMode: "normal", role: "content", parentClipId: back.id };
  project.tracks.push({ id: "video-front", name: "前景平面", kind: "video", locked: false, muted: false, clips: [front] });
  return project;
}

describe("persisted native 2.5D product contract", () => {
  it("round-trips camera, lights and parented planes through EditProject and the native graph compiler", () => {
    const authored = sceneProject();
    authored.scene25d!.camera.keyframes = [{ id: "camera-push", time: .2, position: [.4, 0, 4.5], target: [.15, 0, 0], verticalFovDegrees: 52, easing: "ease_in_out" }];
    authored.scene25d!.ambientLight.keyframes = [{ id: "ambient-rise", time: .2, intensity: .5, easing: "ease_in_out" }];
    authored.scene25d!.directionalLight.keyframes = [{ id: "light-sweep", time: .2, color: [.35, .55, 1], intensity: 1.4, direction: [-.7, -.1, 1], easing: "ease_in_out" }];
    const project = validateProject(authored);
    const reopened = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(project)))));
    expect(reopened.scene25d).toEqual(project.scene25d);
    expect(reopened.tracks.at(-1)?.clips[0].transform3d).toEqual(project.tracks.at(-1)?.clips[0].transform3d);
    const graph = buildEngineRenderGraph(reopened);
    expect(graph.audio).toBeUndefined();
    expect(graph.nodes.find((node) => node.id === "transform:front")).toMatchObject({
      kind: "transform3d", parent: "transform:clip-demo", position: [.22, -.08, .72],
    });
    expect(graph.nodes.find((node) => node.id === "scene25d:camera")).toMatchObject({ kind: "camera", verticalFovRadians: Math.PI / 3,
      keyframes: [{ frame: 6, position: [.4, 0, 4.5], target: [.15, 0, 0], verticalFovRadians: 52 * Math.PI / 180, easing: "ease_in_out" }] });
    expect(graph.nodes.some((node) => node.kind === "depth_of_field")).toBe(false);
    expect(graph.nodes.filter((node) => node.kind === "light")).toHaveLength(2);
    expect(graph.nodes.find((node) => node.id === "scene25d:ambient")).toMatchObject({ keyframes: [{ frame: 6, color: [1, 1, 1], intensity: .5, direction: [0, 0, -1], easing: "ease_in_out" }] });
    expect(graph.nodes.find((node) => node.id === "scene25d:directional")).toMatchObject({ keyframes: [{ frame: 6, color: [.35, .55, 1], intensity: 1.4, direction: [-.7, -.1, 1], easing: "ease_in_out" }] });
    expect(graph.nodes.some((node) => node.kind === "transform2d")).toBe(false);
  });

  it("persists lens controls, migrates old scene settings and emits one typed depth-of-field node", () => {
    const project = sceneProject();
    project.assets.forEach((asset) => { asset.kind = "video"; asset.alphaMode = "opaque"; });
    project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
    project.scene25d!.depthOfField = { enabled: true, focusDistance: 3.25, aperture: 3.5, maxBlurRadius: 14,
      keyframes: [{ id: "rack-focus", time: .2, focusDistance: 4.75, aperture: 4, maxBlurRadius: 16, easing: "ease_in_out" }] };
    const reopened = validateProject(projectSchema.parse(migrateProject(JSON.parse(JSON.stringify(project)))));
    expect(reopened.scene25d?.depthOfField).toEqual(project.scene25d!.depthOfField);
    expect(buildEngineRenderGraph(reopened).nodes.find((node) => node.id === "scene25d:depth-of-field")).toMatchObject({
      kind: "depth_of_field", inputs: [expect.any(String), "scene25d:camera"], focusDistance: 3.25, aperture: 3.5, maxBlurRadius: 14,
      keyframes: [{ frame: 6, focusDistance: 4.75, aperture: 4, maxBlurRadius: 16, easing: "ease_in_out" }],
    });
    const legacy = JSON.parse(JSON.stringify(project)) as Record<string, unknown>;
    delete ((legacy.scene25d as Record<string, unknown>).depthOfField);
    delete (((legacy.scene25d as { camera: Record<string, unknown> }).camera).keyframes);
    delete (((legacy.scene25d as { ambientLight: Record<string, unknown> }).ambientLight).keyframes);
    delete (((legacy.scene25d as { directionalLight: Record<string, unknown> }).directionalLight).keyframes);
    expect(migrateProject(legacy).scene25d).toMatchObject({ depthOfField: DEFAULT_SCENE_25D.depthOfField, camera: { keyframes: [] }, ambientLight: { keyframes: [] }, directionalLight: { keyframes: [] } });
  });

  it("fails closed for invalid or unsupported native lens contracts", () => {
    const valid = sceneProject();
    valid.assets.forEach((asset) => { asset.kind = "video"; asset.alphaMode = "opaque"; });
    valid.colorManagement = { ...valid.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
    valid.scene25d!.depthOfField.enabled = true;
    expect(validateProject(valid).scene25d?.depthOfField.enabled).toBe(true);
    const outside = structuredClone(valid); outside.scene25d!.depthOfField.focusDistance = outside.scene25d!.camera.near;
    expect(() => validateProject(outside)).toThrow(/景深/);
    const duplicateFrame = structuredClone(valid); duplicateFrame.scene25d!.depthOfField.keyframes = [
      { id: "a", time: .1, focusDistance: 3.5, aperture: 3, maxBlurRadius: 10, easing: "linear" },
      { id: "b", time: .11, focusDistance: 4, aperture: 4, maxBlurRadius: 12, easing: "linear" },
    ];
    expect(() => validateProject(duplicateFrame)).toThrow(/鏡頭關鍵幀/);
    const duplicateCameraFrame = structuredClone(valid); duplicateCameraFrame.scene25d!.camera.keyframes = [
      { id: "a", time: .1, position: [0, 0, 4], target: [0, 0, 0], verticalFovDegrees: 60, easing: "linear" },
      { id: "b", time: .11, position: [.2, 0, 4], target: [0, 0, 0], verticalFovDegrees: 55, easing: "linear" },
    ];
    expect(() => validateProject(duplicateCameraFrame)).toThrow(/相機關鍵幀/);
    const duplicateLightFrame = structuredClone(valid); duplicateLightFrame.scene25d!.directionalLight.keyframes = [
      { id: "a", time: .1, color: [1, 1, 1], intensity: .8, direction: [0, 0, 1], easing: "linear" },
      { id: "b", time: .11, color: [.5, .7, 1], intensity: 1.2, direction: [1, 0, 1], easing: "linear" },
    ];
    expect(() => validateProject(duplicateLightFrame)).toThrow(/方向光關鍵幀/);
    const zeroLightDirection = structuredClone(valid); zeroLightDirection.scene25d!.directionalLight.keyframes = [
      { id: "bad", time: .2, color: [1, 1, 1], intensity: 1, direction: [0, 0, 0], easing: "linear" },
    ];
    expect(() => validateProject(zeroLightDirection)).toThrow(/方向光關鍵幀/);
    const negativeAmbient = structuredClone(valid); negativeAmbient.scene25d!.ambientLight.keyframes = [
      { id: "bad", time: .2, intensity: -.1, easing: "linear" },
    ];
    expect(() => validateProject(negativeAmbient)).toThrow(/環境光關鍵幀/);
    const transparent = structuredClone(valid); transparent.assets[0].alphaMode = "straight";
    expect(() => validateProject(transparent)).toThrow(/不透明影片/);
  });

  it("accepts decoded video planes but fails closed for non-visual planes, invalid cameras and unsupported overlay families", () => {
    const video = sceneProject();
    video.assets[0].kind = "video";
    expect(validateProject(video).assets[0].kind).toBe("video");

    const audio = sceneProject();
    audio.assets[0].kind = "audio";
    expect(() => validateProject(audio)).toThrow(/不能使用 audio 素材/);

    const camera = sceneProject();
    camera.scene25d!.camera.target = [...camera.scene25d!.camera.position];
    expect(() => validateProject(camera)).toThrow(/相機/);

    const caption = sceneProject();
    caption.captions.push({ id: "caption", text: "not silently ignored", start: 0, duration: 1 });
    expect(() => validateProject(caption)).toThrow(/字幕或動態圖卡/);
  });

  it("enables, edits and disables the scene through undoable typed commands", () => {
    const plain = createDemoProject();
    plain.assets[0].kind = "image";
    let project = applyCommand(plain, editorCommandSchema.parse({ type: "configure_scene_25d", enabled: true }));
    expect(project.scene25d).toEqual(DEFAULT_SCENE_25D);
    expect(project.tracks[0].clips[0].transform3d).toEqual(DEFAULT_TRANSFORM_3D);
    project = applyCommand(project, { type: "update_clip_transform_3d", clipId: "clip-demo", patch: { position: [0, 0, .75] } });
    expect(project.tracks[0].clips[0].transform3d?.position).toEqual([0, 0, .75]);
    project = applyCommand(project, { type: "configure_scene_25d", enabled: false });
    expect(project.scene25d).toBeUndefined();
    expect(project.tracks[0].clips[0].transform3d).toBeUndefined();
  });
});
