import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { buildEngineRenderGraph } from "./engineGraph";

describe("native physical white-balance graph versioning", () => {
  it("explicit current SDR preview promotes zero gains without mutating authored controls", () => {
    const project = createDemoProject();
    const before = structuredClone(project);
    const legacy = buildEngineRenderGraph(project);
    expect(buildEngineRenderGraph(project, { rec709PrimaryVersion: 1 })).toEqual(legacy);
    const current = buildEngineRenderGraph(project, { rec709PrimaryVersion: 2 });
    expect(current.nodes.find(node => node.kind === "color")).toMatchObject({ processor: "editkin-rec709-primary/v2", grade: { whiteBalanceRed: 0, whiteBalanceGreen: 0, whiteBalanceBlue: 0 } });
    expect(project).toEqual(before);
    expect(legacy.nodes.find(node => node.kind === "color")?.grade).not.toHaveProperty("whiteBalanceRed");
    const adjustment = structuredClone(project.tracks[0].clips[0]);
    adjustment.id = "current-adjustment"; adjustment.trackId = "adjustment";
    adjustment.layer = { enabled: true, blendMode: "normal", role: "adjustment" };
    project.tracks.push({ id: "adjustment", name: "adjustment", kind: "video", locked: false, muted: false, clips: [adjustment] });
    expect(buildEngineRenderGraph(project, { rec709PrimaryVersion: 2 }).nodes.find(node => node.id === "color:current-adjustment")).toMatchObject({ processor: "editkin-rec709-primary/v2", grade: { whiteBalanceRed: 0, whiteBalanceGreen: 0, whiteBalanceBlue: 0 } });
  });

  it.each(["aces", "still", "mixed", "exr", "hlg", "pq", "log", "unresolved-auto"])("does not promote an uncalibrated %s profile", kind => {
    const project = createDemoProject();
    if (kind === "aces") project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
    if (kind === "still") project.assets[0].kind = "image";
    if (kind === "mixed") {
      project.assets.push({ ...project.assets[0], id: "image", kind: "image" });
      project.tracks[0].clips.push({ ...structuredClone(project.tracks[0].clips[0]), id: "image-clip", assetId: "image" });
    }
    if (kind === "exr") { project.assets[0].kind = "image"; project.assets[0].color = { interpretation: "linear_rec709" }; }
    if (kind === "hlg") project.assets[0].color = { interpretation: "auto", transfer: "arib-std-b67", primaries: "bt2020" };
    if (kind === "pq") project.assets[0].color = { interpretation: "auto", transfer: "smpte2084", primaries: "bt2020" };
    if (kind === "log") project.assets[0].color = { interpretation: "log_unresolved" };
    if (kind === "unresolved-auto") project.assets[0].color = { interpretation: "auto" };
    expect(buildEngineRenderGraph(project, { rec709PrimaryVersion: 2 })).toEqual(buildEngineRenderGraph(project));
  });
  it("leaves legacy zero wire and processors identical, including missing saved fields", () => {
    const project = createDemoProject();
    const zero = buildEngineRenderGraph(project);
    const color = project.tracks[0].clips[0].color as unknown as Record<string, number>;
    delete color.whiteBalanceRed; delete color.whiteBalanceGreen; delete color.whiteBalanceBlue;
    expect(buildEngineRenderGraph(project)).toEqual(zero);
    expect(zero.nodes.find(node => node.kind === "color")).toMatchObject({ processor: "editkin-rec709-primary/v1" });
    expect(zero.nodes.find(node => node.kind === "color")?.grade).not.toHaveProperty("whiteBalanceRed");
  });

  it.each([[-4, 0, 4], [1, -.5, 0]])("transports all channels in a fail-visible SDR v2 processor: %j", (red, green, blue) => {
    const project = createDemoProject();
    Object.assign(project.tracks[0].clips[0].color, { whiteBalanceRed: red, whiteBalanceGreen: green, whiteBalanceBlue: blue });
    expect(buildEngineRenderGraph(project).nodes.find(node => node.kind === "color")).toMatchObject({
      processor: "editkin-rec709-primary/v2", inputSpace: "rec709", workingSpace: "rec709",
      grade: { whiteBalanceRed: red, whiteBalanceGreen: green, whiteBalanceBlue: blue },
    });
  });

  it("names the explicit inverse709 transfer for ACES sources and linear gains for adjustments", () => {
    const project = createDemoProject();
    project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
    const clip = project.tracks[0].clips[0];
    clip.color.whiteBalanceRed = .5;
    const adjustment = structuredClone(clip);
    adjustment.id = "wb-adjustment"; adjustment.trackId = "adjustment";
    adjustment.layer = { enabled: true, blendMode: "normal", ...adjustment.layer, role: "adjustment" };
    project.tracks.push({ id: "adjustment", name: "adjustment", kind: "video", locked: false, muted: false, clips: [adjustment] });
    const graph = buildEngineRenderGraph(project);
    expect(graph.nodes.find(node => node.id === "color:clip-demo")).toMatchObject({
      processor: "editkin-rec709-to-linear-rec709-primary/v2", inputSpace: "rec709", workingSpace: "linear_rec709", outputSpace: "linear_rec709",
    });
    expect(graph.nodes.find(node => node.id === "color:wb-adjustment")).toMatchObject({
      processor: "editkin-linear-primary/v2", inputSpace: "linear_rec709", workingSpace: "linear_rec709",
    });
    expect(graph.nodes.filter(node => node.id === "display:aces2")).toHaveLength(1);
  });

  it.each([NaN, Infinity, -Infinity, -4.001, 4.001])("rejects invalid physical gains before native dispatch: %s", value => {
    const project = createDemoProject(); project.tracks[0].clips[0].color.whiteBalanceGreen = value;
    expect(() => buildEngineRenderGraph(project)).toThrow("[-4,4]");
  });
});
