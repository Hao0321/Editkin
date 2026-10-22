import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { extractMaterialKeyframes, materialKeyframeFilters } from "./materialKeyframeExtraction";
import { colorDigest, colorFileSha, getMaterialColorRuntimeIdentity } from "./materialColorSamplingRuntime";
import { verifyMaterialKeyframeDisplay } from "./materialKeyframeValidation";
import type { MaterialKeyframeDisplay } from "./materialKeyframeTypes";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), runtime = { ffmpegPath, ffprobePath: join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe") };
const temp = useTempRoots();
let fixture: { display: MaterialKeyframeDisplay; data: Buffer; sourceSha256: string; runtimeSha: string; analysis: Awaited<ReturnType<typeof extractMaterialKeyframes>>["analysis"] };

/** One real untagged synthetic PNG still, extracted once. */
beforeAll(async () => {
  const root = await temp.create("kv-"), path = join(root, "untagged.png");
  const made = spawnSync(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:d=1", "-frames:v", "1", "-vf", "format=rgb24", path], { windowsHide: true, timeout: 30000 });
  expect(made.status, made.stderr.toString()).toBe(0);
  const identity = await getMaterialColorRuntimeIdentity(runtime), sourceSha256 = await colorFileSha(path);
  const result = await extractMaterialKeyframes({ sourcePath: path, sourceSha256, sourceStart: 0, duration: 3, kind: "image",
    samples: [{ id: "kf-1", time: 0, sceneIndex: 0 }], sceneCount: 1, sceneCountVerified: true, sceneCuts: [] }, runtime, identity);
  expect(result.analysis.state, JSON.stringify(result.analysis.omitted)).toBe("ready");
  fixture = { display: result.frames[0].display, data: result.frames[0].data, sourceSha256, runtimeSha: identity.identitySha256, analysis: result.analysis };
}, 60000);

function verify(display: MaterialKeyframeDisplay, kind = "image") {
  const resealed = { ...display, receiptSha256: "" };
  resealed.receiptSha256 = colorDigest({ ...resealed, receiptSha256: undefined });
  verifyMaterialKeyframeDisplay(fixture.analysis, [{ id: "kf-1", time: 0, sceneIndex: 0, sha256: display.jpeg.sha256, bytes: display.jpeg.bytes, display: resealed }],
    { sourceSha256: fixture.sourceSha256, sourceStart: 0, duration: 3, kind }, fixture.runtimeSha, []);
}
const reason = (run: () => unknown) => { try { run(); } catch (error) { return (error as Error).message; } return "VERIFIED"; };

describe("keyframe display validation of sRGB stills", () => {
  it("verifies the extracted still and recomputes its exact sRGB normalization from the recorded probe", () => {
    expect(fixture.display.normalization).toMatchObject({ interpretation: "srgb", colorInterpretation: "srgb_assumed_untagged_image", sourceEncoding: "rgb" });
    expect(reason(() => verify(fixture.display))).toBe("VERIFIED");
  });

  it("refuses a re-sealed receipt that upgrades 'assumed' to 'tagged', or that relabels the still as Rec.709 video", () => {
    expect(reason(() => verify({ ...fixture.display, normalization: { ...fixture.display.normalization, colorInterpretation: "srgb_tagged" } as MaterialKeyframeDisplay["normalization"] })))
      .toBe("keyframe-display-normalization");
    const width = Number(fixture.display.probe.metadata.stream.width), height = Number(fixture.display.probe.metadata.stream.height);
    const asVideo = { interpretation: "rec709" as const, filters: materialKeyframeFilters("rec709", width, height, { interpretation: "rec709" }), intermediateTransfer: "bt709" as const,
      displayEotf: "bt1886-ideal" as const, purpose: "neutral-display-proxy" as const, transfer: "srgb" as const, primaries: "bt709" as const, range: "full" as const,
      exposure: 0 as const, creativeLook: false as const, maximumDimension: 1280 as const };
    expect(reason(() => verify({ ...fixture.display, normalization: asVideo }))).toBe("keyframe-display-normalization");
  });

  it("a probe re-tagged as sRGB would need the 'tagged' record; video never takes the still path", () => {
    const stream = { ...fixture.display.probe.metadata.stream, color_transfer: "iec61966-2-1" };
    expect(reason(() => verify({ ...fixture.display, probe: { ...fixture.display.probe, metadata: { ...fixture.display.probe.metadata, stream } } })))
      .toBe("keyframe-display-normalization");
    expect(reason(() => verify(fixture.display, "video"))).toBe("unknown-or-incomplete-color-tags");
  });
});
