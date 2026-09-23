import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildReceipt } from "./lib/build-input-identity.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const benchmarkRoot = join(repoRoot, ".rd/benchmarks");
const outputRoot = join(appRoot, ".rd/benchmarks/editkin-native-25d-internal");
const outputPath = join(outputRoot, "report.json");
const planner = "editkin-resident-video-scene-linear-aces2-formal-sequence/v1";
const imageNodes = ["back-source", "back-3d", "front-source", "front-3d", "scene-composite", "camera", "ambient", "key", "output"];
const videoControls = ["missing-transform", "ninth-plane", "parent-cycle", "particle-mix", "pq-input"];
const depthControls = ["missing-transform", "zero-scale", "translucent-plane", "non-normal-blend", "ninth-plane", "parent-cycle", "particle-mix", "pq-input"];
const dofControls = ["focus-at-near", "focus-at-far", "zero-aperture", "zero-radius", "oversized-radius", "ninth-plane", "translucent-plane", "effect-mix", "particle-mix", "pq-input"];
const lensControls = ["zero-time", "duplicate-frame", "end-frame", "focus-at-near", "focus-at-far", "zero-aperture", "oversized-radius", "seventeenth-keyframe", "unknown-easing"];
const cameraControls = ["zero-time", "duplicate-frame", "end-frame", "coincident-position-target", "fov-zero", "fov-180", "seventeenth-keyframe", "unknown-easing"];
const lightControls = ["zero-time", "duplicate-frame", "end-frame", "negative-ambient", "negative-intensity", "negative-color", "zero-direction", "seventeenth-keyframe", "unknown-easing"];
const reportPaths = {
  nativeImage: join(benchmarkRoot, "editkin-native-25d-scene/report.json"),
  formalImage: join(benchmarkRoot, "editkin-native-25d-project-render/report.json"),
  video: join(benchmarkRoot, "editkin-resident-25d-video-project-render/report.json"),
  depth: join(benchmarkRoot, "editkin-resident-25d-depth-video-project-render/report.json"),
  dof: join(benchmarkRoot, "editkin-resident-25d-depth-of-field-video-project-render/report.json"),
  lens: join(benchmarkRoot, "editkin-resident-25d-animated-depth-of-field-video-project-render/report.json"),
  camera: join(benchmarkRoot, "editkin-resident-25d-animated-camera-video-project-render/report.json"),
  light: join(benchmarkRoot, "editkin-resident-25d-animated-light-video-project-render/report.json"),
  smoke: join(benchmarkRoot, "editkin-tauri-cdp-smoke.json"),
  manifest: join(appRoot, ".release-input-manifest.json"),
};

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exactStrings = (actual, expected) => Array.isArray(actual) && actual.join() === expected.join();
const sameSet = (actual, expected) => Array.isArray(actual) && [...actual].sort().join() === [...expected].sort().join();
const identitiesMatch = (left, right) => left?.files === right?.files && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
const zeroDelta = (delta) => delta?.changed === 0 && delta.high === 0 && delta.maximum === 0;
const residentPlan = (report, passes) => report.resourcePlan?.schema === "editkin.resident-video-resource-plan/v1"
  && report.resourcePlan.width === 960 && report.resourcePlan.height === 540
  && report.resourcePlan.sceneDepthAttachmentCount === 1 && report.resourcePlan.sceneDepthBytes === 2_073_600
  && report.resourcePlan.requiredBytes === 51_840_000
  && report.resourcePlan.maximumFullFramePassesPerPresent === passes;
const scene = (value, animatedCamera = false, animatedLight = false) => value?.sceneContract === "single_camera_textured_planes/v1"
  && value.planeCount === 2 && value.videoPlaneCount === 2 && value.depthFormat === "depth32_float"
  && value.depthMode === "per_pixel_opaque_plane_depth32float" && value.depthPassCount === 1
  && value.depthTestedPlaneCount === 2 && value.geometryExecutor === "hao-core-native-camera-matrix-depth-plane/v1"
  && value.pixelExecutor === "wgpu-projective-plane-depth-compositor/v1"
  && value.cameraAnimationContract === (animatedCamera ? "timeline-keyframes/v1" : "static/v1")
  && value.lightAnimationContract === (animatedLight ? "timeline-keyframes/v1" : "static/v1");

function evaluate(reports, delivery) {
  const { nativeImage, formalImage, video, depth, dof, lens, camera, light } = reports;
  return {
    imageCompatibilityAndFormalRoundTrip: nativeImage.schema === "editkin.native-25d-scene-gate/v1"
      && nativeImage.status === "GREEN" && nativeImage.baselineRejected === true
      && nativeImage.sceneContract === "single_camera_textured_planes/v1" && nativeImage.planeCount === 2
      && nativeImage.parentedPlaneCount === 1 && nativeImage.directionalLightCount === 1 && nativeImage.ambientLightCount === 1
      && nativeImage.directExecution === true && nativeImage.cpuGpuMaxChannelError === 0 && nativeImage.previewExportMaxChannelError === 0
      && nativeImage.residentFrames === 30 && nativeImage.residentP95Ms <= 20
      && sameSet(nativeImage.requiredNodeIds, imageNodes) && sameSet(nativeImage.executedNodeIds, imageNodes)
      && nativeImage.blockedNodeIds?.length === 0 && nativeImage.ignoredNodeIds?.length === 0
      && formalImage.schema === "editkin.native-25d-project-render-gate/v1" && formalImage.status === "GREEN"
      && formalImage.persistedProjectRoundTrip === true && formalImage.graphSchema === "editkin.engine-graph/v1"
      && formalImage.scene25d?.planeCount === 2 && formalImage.scene25d?.parentedPlaneCount === 1
      && formalImage.scene25d?.geometryExecutor === "hao-core-native-camera-matrix/v1"
      && formalImage.scene25d?.pixelExecutor === "wgpu-projective-plane-compositor/v1"
      && formalImage.cpuGpuOutputParity === true && sha256(formalImage.outputSha256),
    residentVideoPlanes: video.schema === "editkin.resident-25d-video-project-render-gate/v1"
      && video.status === "GREEN" && video.baselineProductRouteRejected === true && video.planner === planner
      && video.frameCount === 12 && scene(video.scene25d) && video.scene25d.parentedPlaneCount === 1
      && video.sceneReceiptFrames === 12 && video.productPathCpuPixelCopies === 0 && video.verificationReadback === true
      && video.changedPixelsAgainstFlatControl > 500_000 && video.bt709Tagged === true
      && exactStrings(video.rejectedNegativeControls, videoControls),
    perPixelDepthAndLighting: depth.schema === "editkin.resident-25d-depth-video-project-render-gate/v1"
      && depth.status === "GREEN" && depth.frozenRedBaseline === true && depth.planner === planner && depth.frameCount === 12
      && scene(depth.scene25d) && depth.sceneReceiptFrames === 12 && depth.depthReceiptFrames === 12
      && depth.productPathCpuPixelCopies === 0 && depth.verificationReadback === true
      && depth.crossing?.oppositeDominance === true && zeroDelta(depth.orderDeltaOutsideIntersection)
      && depth.lightingDelta?.changed > 100_000 && depth.bt709Tagged === true && depth.audioPresent === true
      && exactStrings(depth.rejectedNegativeControls, depthControls),
    staticDepthOfField: dof.schema === "editkin.resident-25d-depth-of-field-video-project-render-gate/v1"
      && dof.status === "GREEN" && dof.frozenRedBaseline === true && dof.planner === planner && dof.frameCount === 12
      && dof.depthReceiptFrames === 12 && dof.depthOfFieldReceiptFrames === 12 && dof.productPathCpuPixelCopies === 0
      && dof.verificationReadback === true && dof.compositeFullFramePassCount === 3
      && dof.depthOfField?.contract === "camera_depth_of_field/v1" && dof.depthOfField?.depthSource === "depth32_float"
      && dof.depthOfField?.executionMode === "scene-linear-depth32f-gather-dof/v1"
      && dof.depthOfField?.executor === "wgpu-depth-aware-gather/v1" && dof.depthOfField?.passCount === 1
      && residentPlan(dof, 3) && dof.focusEvidence?.nearFocusRatio > 1.2 && dof.focusEvidence?.farFocusRatio > 1.2
      && dof.focusEvidence?.focusFlipPixels?.changed > 80_000 && zeroDelta(dof.orderDelta) && dof.lensOffDelta?.changed > 40_000
      && dof.bt709Tagged === true && dof.audioPresent === true && exactStrings(dof.rejectedNegativeControls, dofControls),
    animatedLens: lens.schema === "editkin.resident-25d-animated-depth-of-field-video-project-render-gate/v1"
      && lens.status === "GREEN" && lens.frozenRedBaseline === true && lens.planner === planner && lens.frameCount === 12
      && lens.depthReceiptFrames === 12 && lens.depthOfFieldReceiptFrames === 12 && lens.animatedFrameTransitions === 11
      && lens.firstLens?.animationContract === "timeline-keyframes/v1" && lens.firstLens?.sampledTimelineFrame === 0
      && lens.firstLens?.focusDistance === 3.25 && lens.lastLens?.sampledTimelineFrame === 11 && lens.lastLens?.focusDistance === 4.75
      && zeroDelta(lens.endpointNearDelta) && zeroDelta(lens.endpointFarDelta)
      && lens.midpointNearDelta?.changed > 60_000 && lens.midpointFarDelta?.changed > 60_000
      && residentPlan(lens, 3) && lens.resourcePlanStableAcrossControls === true && lens.productPathCpuPixelCopies === 0
      && lens.bt709Tagged === true && lens.audioPresent === true && exactStrings(lens.rejectedNegativeControls, lensControls),
    animatedCamera: camera.schema === "editkin.resident-25d-animated-camera-video-project-render-gate/v1"
      && camera.status === "GREEN" && camera.frozenRedBaseline === true && camera.planner === planner && camera.frameCount === 12
      && camera.sceneReceiptFrames === 12 && camera.depthReceiptFrames === 12 && camera.animatedFrameTransitions === 11
      && scene(camera.firstCamera, true, false) && scene(camera.lastCamera, true, false)
      && camera.firstCamera.sampledTimelineFrame === 0 && camera.lastCamera.sampledTimelineFrame === 11
      && zeroDelta(camera.endpointStartDelta) && zeroDelta(camera.endpointEndDelta)
      && camera.midpointStartDelta?.changed > 80_000 && camera.midpointEndDelta?.changed > 80_000
      && residentPlan(camera, 2) && camera.resourcePlanStableAcrossControls === true && camera.productPathCpuPixelCopies === 0
      && camera.bt709Tagged === true && camera.audioPresent === true && exactStrings(camera.rejectedNegativeControls, cameraControls),
    animatedLight: light.schema === "editkin.resident-25d-animated-light-video-project-render-gate/v1"
      && light.status === "GREEN" && light.frozenRedBaseline === true && light.planner === planner && light.frameCount === 12
      && light.sceneReceiptFrames === 12 && light.depthReceiptFrames === 12 && light.animatedFrameTransitions === 11
      && scene(light.firstLight, false, true) && scene(light.lastLight, false, true)
      && light.firstLight.sampledLightTimelineFrame === 0 && light.lastLight.sampledLightTimelineFrame === 11
      && light.firstLight.ambientLightKeyframeCount === 1 && light.firstLight.directionalLightKeyframeCount === 1
      && zeroDelta(light.endpointStartDelta) && zeroDelta(light.endpointEndDelta)
      && light.midpointStartDelta?.changed > 100_000 && light.midpointEndDelta?.changed > 100_000
      && residentPlan(light, 2) && light.resourcePlanStableAcrossControls === true && light.productPathCpuPixelCopies === 0
      && light.bt709Tagged === true && light.audioPresent === true && exactStrings(light.rejectedNegativeControls, lightControls),
    sourceBoundDesktopDelivery: delivery.smokeGreen === true && delivery.identityExact === true
      && delivery.requiredJourneys === true && delivery.bridgeCoverage === true
      && delivery.executableInsideRepoEvidence === true && delivery.executableBytes > 1_000_000 && sha256(delivery.executableSha256),
  };
}

function validFixture() {
  const control = (changed = 0) => ({ changed, high: changed, maximum: changed ? 1 : 0 });
  const plan = (passes) => ({ schema: "editkin.resident-video-resource-plan/v1", width: 960, height: 540,
    sceneDepthAttachmentCount: 1, sceneDepthBytes: 2_073_600, requiredBytes: 51_840_000, maximumFullFramePassesPerPresent: passes });
  const sceneValue = (animatedCamera = false, animatedLight = false, frame = 0) => ({ sceneContract: "single_camera_textured_planes/v1",
    planeCount: 2, videoPlaneCount: 2, parentedPlaneCount: 1, depthFormat: "depth32_float", depthMode: "per_pixel_opaque_plane_depth32float",
    depthPassCount: 1, depthTestedPlaneCount: 2, geometryExecutor: "hao-core-native-camera-matrix-depth-plane/v1",
    pixelExecutor: "wgpu-projective-plane-depth-compositor/v1", cameraAnimationContract: animatedCamera ? "timeline-keyframes/v1" : "static/v1",
    lightAnimationContract: animatedLight ? "timeline-keyframes/v1" : "static/v1", sampledTimelineFrame: animatedCamera ? frame : 0,
    sampledLightTimelineFrame: animatedLight ? frame : 0, ambientLightKeyframeCount: animatedLight ? 1 : 0,
    directionalLightKeyframeCount: animatedLight ? 1 : 0 });
  return { reports: {
    nativeImage: { schema: "editkin.native-25d-scene-gate/v1", status: "GREEN", baselineRejected: true,
      sceneContract: "single_camera_textured_planes/v1", planeCount: 2, parentedPlaneCount: 1, directionalLightCount: 1,
      ambientLightCount: 1, directExecution: true, cpuGpuMaxChannelError: 0, previewExportMaxChannelError: 0,
      residentFrames: 30, residentP95Ms: 1, requiredNodeIds: imageNodes, executedNodeIds: [...imageNodes].reverse(), blockedNodeIds: [], ignoredNodeIds: [] },
    formalImage: { schema: "editkin.native-25d-project-render-gate/v1", status: "GREEN", persistedProjectRoundTrip: true,
      graphSchema: "editkin.engine-graph/v1", scene25d: { planeCount: 2, parentedPlaneCount: 1,
        geometryExecutor: "hao-core-native-camera-matrix/v1", pixelExecutor: "wgpu-projective-plane-compositor/v1" },
      cpuGpuOutputParity: true, outputSha256: "a".repeat(64) },
    video: { schema: "editkin.resident-25d-video-project-render-gate/v1", status: "GREEN", baselineProductRouteRejected: true,
      planner, frameCount: 12, scene25d: sceneValue(), sceneReceiptFrames: 12, productPathCpuPixelCopies: 0,
      verificationReadback: true, changedPixelsAgainstFlatControl: 510_000, bt709Tagged: true, rejectedNegativeControls: videoControls },
    depth: { schema: "editkin.resident-25d-depth-video-project-render-gate/v1", status: "GREEN", frozenRedBaseline: true,
      planner, frameCount: 12, scene25d: sceneValue(), sceneReceiptFrames: 12, depthReceiptFrames: 12,
      productPathCpuPixelCopies: 0, verificationReadback: true, crossing: { oppositeDominance: true }, orderDeltaOutsideIntersection: control(),
      lightingDelta: control(150_000), bt709Tagged: true, audioPresent: true, rejectedNegativeControls: depthControls },
    dof: { schema: "editkin.resident-25d-depth-of-field-video-project-render-gate/v1", status: "GREEN", frozenRedBaseline: true,
      planner, frameCount: 12, depthReceiptFrames: 12, depthOfFieldReceiptFrames: 12, productPathCpuPixelCopies: 0,
      verificationReadback: true, compositeFullFramePassCount: 3, depthOfField: { contract: "camera_depth_of_field/v1", depthSource: "depth32_float",
        executionMode: "scene-linear-depth32f-gather-dof/v1", executor: "wgpu-depth-aware-gather/v1", passCount: 1 }, resourcePlan: plan(3),
      focusEvidence: { nearFocusRatio: 1.3, farFocusRatio: 1.3, focusFlipPixels: control(90_000) }, orderDelta: control(), lensOffDelta: control(50_000),
      bt709Tagged: true, audioPresent: true, rejectedNegativeControls: dofControls },
    lens: { schema: "editkin.resident-25d-animated-depth-of-field-video-project-render-gate/v1", status: "GREEN", frozenRedBaseline: true,
      planner, frameCount: 12, depthReceiptFrames: 12, depthOfFieldReceiptFrames: 12, animatedFrameTransitions: 11,
      firstLens: { animationContract: "timeline-keyframes/v1", sampledTimelineFrame: 0, focusDistance: 3.25 },
      lastLens: { animationContract: "timeline-keyframes/v1", sampledTimelineFrame: 11, focusDistance: 4.75 },
      endpointNearDelta: control(), endpointFarDelta: control(), midpointNearDelta: control(70_000), midpointFarDelta: control(70_000),
      resourcePlan: plan(3), resourcePlanStableAcrossControls: true, productPathCpuPixelCopies: 0, bt709Tagged: true, audioPresent: true,
      rejectedNegativeControls: lensControls },
    camera: { schema: "editkin.resident-25d-animated-camera-video-project-render-gate/v1", status: "GREEN", frozenRedBaseline: true,
      planner, frameCount: 12, sceneReceiptFrames: 12, depthReceiptFrames: 12, animatedFrameTransitions: 11,
      firstCamera: sceneValue(true, false, 0), lastCamera: sceneValue(true, false, 11), endpointStartDelta: control(), endpointEndDelta: control(),
      midpointStartDelta: control(90_000), midpointEndDelta: control(90_000), resourcePlan: plan(2), resourcePlanStableAcrossControls: true,
      productPathCpuPixelCopies: 0, bt709Tagged: true, audioPresent: true, rejectedNegativeControls: cameraControls },
    light: { schema: "editkin.resident-25d-animated-light-video-project-render-gate/v1", status: "GREEN", frozenRedBaseline: true,
      planner, frameCount: 12, sceneReceiptFrames: 12, depthReceiptFrames: 12, animatedFrameTransitions: 11,
      firstLight: sceneValue(false, true, 0), lastLight: sceneValue(false, true, 11), endpointStartDelta: control(), endpointEndDelta: control(),
      midpointStartDelta: control(125_000), midpointEndDelta: control(125_000), resourcePlan: plan(2), resourcePlanStableAcrossControls: true,
      productPathCpuPixelCopies: 0, bt709Tagged: true, audioPresent: true, rejectedNegativeControls: lightControls },
  }, delivery: { smokeGreen: true, identityExact: true, requiredJourneys: true, bridgeCoverage: true,
    executableInsideRepoEvidence: true, executableBytes: 5_000_000, executableSha256: "b".repeat(64) } };
}

if (process.argv.includes("--self-test")) {
  const mutations = [
    ["image", (f) => { f.reports.nativeImage.cpuGpuMaxChannelError = 2; }],
    ["formal-roundtrip", (f) => { f.reports.formalImage.persistedProjectRoundTrip = false; }],
    ["resident-video", (f) => { f.reports.video.productPathCpuPixelCopies = 1; }],
    ["depth", (f) => { f.reports.depth.crossing.oppositeDominance = false; }],
    ["static-dof", (f) => { f.reports.dof.focusEvidence.nearFocusRatio = 1; }],
    ["animated-lens", (f) => { f.reports.lens.endpointNearDelta.changed = 1; }],
    ["animated-camera", (f) => { f.reports.camera.midpointStartDelta.changed = 1; }],
    ["animated-light", (f) => { f.reports.light.lastLight.sampledLightTimelineFrame = 10; }],
    ["negative-controls", (f) => { f.reports.depth.rejectedNegativeControls.pop(); }],
    ["delivery-identity", (f) => { f.delivery.identityExact = false; }],
  ];
  const valid = validFixture();
  if (!Object.values(evaluate(valid.reports, valid.delivery)).every(Boolean)) throw new Error("native 2.5D evaluator rejected its valid fixture");
  for (const [name, mutate] of mutations) {
    const fixture = structuredClone(valid); mutate(fixture);
    if (Object.values(evaluate(fixture.reports, fixture.delivery)).every(Boolean)) throw new Error(`native 2.5D evaluator missed ${name}`);
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", evaluatorMutationsRejected: mutations.length })}\n`);
  process.exit(0);
}

const entries = await Promise.all(Object.entries(reportPaths).map(async ([name, path]) => {
  const bytes = await readFile(path); return [name, { path, bytes, json: JSON.parse(bytes.toString("utf8")) }];
}));
const inputs = Object.fromEntries(entries);
const reports = Object.fromEntries(Object.keys(reportPaths).filter((name) => !["smoke", "manifest"].includes(name)).map((name) => [name, inputs[name].json]));
const smoke = inputs.smoke.json;
const manifest = inputs.manifest.json;
const executablePath = resolve(smoke.executable ?? "");
const executableBytes = await readFile(executablePath);
const stagedManifest = JSON.parse(await readFile(join(dirname(executablePath), "runtime/BUILD-MANIFEST.json"), "utf8"));
const currentReceipt = await computeBuildReceipt(appRoot);
const executableRelative = relative(repoRoot, executablePath);
const journeyNames = smoke.journeySteps?.map((step) => step.name) ?? [];
const bridge = smoke.bridge?.gpuNative25d;
const delivery = {
  smokeGreen: smoke.status === "GREEN" && smoke.isDesktop === true && smoke.buildManifest?.status === "GREEN",
  identityExact: identitiesMatch(smoke.buildManifest?.inputIdentity, manifest.inputIdentity)
    && identitiesMatch(currentReceipt.inputIdentity, manifest.inputIdentity)
    && identitiesMatch(currentReceipt.outputIdentity, manifest.outputIdentity)
    && identitiesMatch(stagedManifest.inputIdentity, manifest.inputIdentity)
    && identitiesMatch(stagedManifest.outputIdentity, manifest.outputIdentity),
  requiredJourneys: ["gpu-native-25d-bridge", "gpu-common-video-engine-bridge", "render"].every((name) => journeyNames.includes(name)),
  bridgeCoverage: bridge?.status === "GREEN" && bridge.coverageComplete === true && bridge.sceneComplete === true
    && bridge.loaded?.engineGraph?.directExecution === true && bridge.loaded?.engineGraph?.blockedNodeIds?.length === 0
    && bridge.loaded?.engineGraph?.ignoredNodeIds?.length === 0 && bridge.loaded?.scene25d?.planeCount === 2
    && bridge.loaded?.scene25d?.parentedPlaneCount === 1 && bridge.loaded?.scene25d?.geometryExecutor === "hao-core-native-camera-matrix/v1"
    && bridge.loaded?.scene25d?.pixelExecutor === "wgpu-projective-plane-compositor/v1"
    && sha256(bridge.renderedHash) && bridge.released?.released === true,
  executableInsideRepoEvidence: isAbsolute(executablePath) && executableRelative !== "" && executableRelative !== ".."
    && !executableRelative.startsWith(`..${sep}`) && executableRelative.split(sep).slice(0, 2).join("/") === ".rd/tmp",
  executableBytes: executableBytes.length,
  executableSha256: hash(executableBytes),
};
const checks = evaluate(reports, delivery);
const status = Object.values(checks).every(Boolean) ? "GREEN_INTERNAL_BOUNDED" : "FAIL";
const report = {
  schema: "editkin.native-25d-internal-gate/v1", measuredAt: new Date().toISOString(), status,
  capabilityStatus: status === "GREEN_INTERNAL_BOUNDED" ? "verified" : "planned", checks,
  measurements: {
    imageResidentP95Ms: reports.nativeImage.residentP95Ms, videoFrames: reports.video.frameCount,
    depthReceiptFrames: reports.depth.depthReceiptFrames, depthAttachmentBytes: reports.dof.resourcePlan?.sceneDepthBytes,
    requiredResourceBytes: reports.dof.resourcePlan?.requiredBytes,
    nearFocusRatio: reports.dof.focusEvidence?.nearFocusRatio, farFocusRatio: reports.dof.focusEvidence?.farFocusRatio,
    lensTransitions: reports.lens.animatedFrameTransitions, cameraTransitions: reports.camera.animatedFrameTransitions,
    lightTransitions: reports.light.animatedFrameTransitions, productPathCpuPixelCopies: Math.max(...[reports.video, reports.depth, reports.dof, reports.lens, reports.camera, reports.light].map((item) => item.productPathCpuPixelCopies)),
    executableBytes: delivery.executableBytes, executableSha256: delivery.executableSha256, buildInputIdentity: manifest.inputIdentity,
  },
  delivery,
  inputs: Object.fromEntries(await Promise.all(Object.entries(inputs).map(async ([name, input]) => [name, {
    path: input.path, bytes: (await stat(input.path)).size, sha256: hash(input.bytes),
  }]))),
  verifiedBoundary: "Windows/DX12 internal bounded 2.5D cell: two textured image or opaque resident-video planes; one camera; one-level parenting; ambient and directional Lambert light; projective sampling; per-pixel Depth32Float for crossing video planes; one 17-tap depth-aware DOF; and at most 16 project-time lens, camera, ambient and directional-light keyframes with exact source-bound Tauri delivery.",
  remainingBlockers: ["arbitrary-mesh-material-and-multitexture", "transparent-depth-ordering", "point-and-spot-lights", "shadows-and-volumetrics", "caption-vfx-and-arbitrary-graph-convergence", "hdr-lighting-holdout", "multiple-lens-and-bokeh-models", "3d-gizmo", "motion-vector-camera-and-object-blur", "direct-encoder-surface-interop", "long-duration-device-recovery", "macos-metal-parity"],
  aggregateBoundary: "The umbrella native-2_5d-scene capability remains planned. This report verifies only the named Windows internal bounded cell and must not be represented as a complete 3D scene engine or After Effects parity.",
};
await mkdir(outputRoot, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`NATIVE_25D_INTERNAL status=${status} report=${outputPath}\n`);
if (status === "FAIL") process.exitCode = 1;
