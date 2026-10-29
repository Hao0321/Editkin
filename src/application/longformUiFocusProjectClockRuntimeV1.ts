import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EditProject } from "../domain/types";
import type { LongformUiFocusArtifactV1 } from "../domain/longformUiFocusFileV1";
import type { MaterialColorRuntime } from "./materialColorSamplingTypes";
import type { LongformUiFocusHoldResultV1 } from "./longformUiFocusHoldJobsV1";
import { colorBytesSha, colorDigest, getMaterialColorRuntimeIdentity } from "./materialColorSamplingRuntime";
import { readBoundedFile } from "../shared/boundedFile";
import { resolveLongformSourceV1, longformSourceSha256V1 } from "./longformMaterialIntakeV1";
import { compositeFrameClock } from "../render/compositeFrameClock";
import { finite } from "../render/ffmpegExpressions";
import { longformUiFocusHoldAlgorithmSha256V1 } from "./longformUiFocusHoldRuntimeV1";
import { assembleLongformUiFocusProjectClockV1, longformUiFocusProjectContextV1 } from "./longformUiFocusProjectClockV1";
import { runLongformUiFocusProjectProcessV1 } from "./longformUiFocusProjectProcessV1";
export async function longformUiFocusProjectClockAlgorithmSha256V1() {
  const entry = fileURLToPath(import.meta.url);
  if (extname(entry) !== ".ts") return colorDigest({ mode: "bundle", sha256: colorBytesSha(await readBoundedFile(entry, 64 * 1024 ** 2)) });
  const paths = ["longformUiFocusProjectClockRuntimeV1.ts", "longformUiFocusProjectClockV1.ts", "longformUiFocusProjectProcessV1.ts", "longformUiFocusProjectTraceV1.ts",
    "../domain/longformUiFocusProjectClockV1.ts", "../render/compositeFrameClock.ts", "../render/ffmpegExpressions.ts", "../domain/clipAlphaPlan.ts"];
  const modules = await Promise.all(paths.map(async path => ({ path, sha256: colorBytesSha(await readBoundedFile(resolve(dirname(entry), path), 1024 * 1024)) })));
  return colorDigest({ holdAlgorithmSha256: await longformUiFocusHoldAlgorithmSha256V1(), modules });
}
export interface LongformUiFocusProjectClockRuntimeV1 extends MaterialColorRuntime {
  sourceRoot: string;
  /** The source owner must re-read its current artifact/project and hold job.
   * This internal port grants no public authority to caller-sealed receipts. */
  validateCurrent: () => Promise<void>;
}
export async function prepareLongformUiFocusProjectClockV1(projectInput: EditProject, artifactInput: LongformUiFocusArtifactV1,
  holdInput: LongformUiFocusHoldResultV1, runtime: LongformUiFocusProjectClockRuntimeV1) {
  const project = structuredClone(projectInput), artifact = structuredClone(artifactInput), hold = structuredClone(holdInput);
  const context = longformUiFocusProjectContextV1(project, artifact, hold); runtime.signal?.throwIfAborted();
  await runtime.validateCurrent(); runtime.signal?.throwIfAborted();
  const sourcePath = await resolveLongformSourceV1(runtime.sourceRoot, artifact.sourcePath);
  const before = await longformSourceSha256V1(sourcePath, runtime.signal), identity = await getMaterialColorRuntimeIdentity(runtime);
  const implementationSha256 = await longformUiFocusProjectClockAlgorithmSha256V1();
  if (before.sha256 !== hold.sourceSha256 || identity.status !== "verified" || identity.identitySha256 !== hold.provider.decodeRuntimeIdentitySha256)
    throw Error("UI_FOCUS_PROJECT_CLOCK_CURRENT_SOURCE_RUNTIME");
  if (await longformUiFocusHoldAlgorithmSha256V1() !== hold.provider.implementationSha256) throw Error("UI_FOCUS_PROJECT_CLOCK_HOLD_ALGORITHM_CHANGED");
  const clock = compositeFrameClock(project.fps, context.project.timelineStart), rate = clock.rate.split("/").map(Number);
  const projectTimeBase = { numerator: rate[1], denominator: rate[0] };
  const filters = [...context.target.frame.display.normalization.filters, "format=gray", "showinfo@clock_input", `fps@clock_rate=${clock.rate}`,
    `trim=duration=${finite(context.project.duration)}`, clock.timestampFilters, "showinfo@clock_output"];
  const args = ["-hide_banner", "-loglevel", "debug", "-debug_ts", "-nostdin", "-ss", finite(context.project.sourceStart),
    "-t", finite(context.project.duration), "-i", sourcePath, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filters.join(","),
    "-fps_mode", "passthrough", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"];
  const actual = await runLongformUiFocusProjectProcessV1(runtime.ffmpegPath, args, {
    sourceTimeBase: hold.sourceTimeBase, projectTimeBase, sourceStart: Number(finite(context.project.sourceStart)), sourceOrigin: context.sourceOrigin,
    timelineStartFrame: clock.startFrame, duration: Number(finite(context.project.duration)),
    width: context.target.frame.display.decoded.width, height: context.target.frame.display.decoded.height,
    videoStreamIndex: Number(context.target.frame.display.probe.metadata.stream.index),
  }, row => row.sourceTime >= hold.sourceStart - 1e-7 && row.sourceTime < hold.sourceEnd - 1e-7, runtime.signal);
  runtime.signal?.throwIfAborted(); await runtime.validateCurrent();
  const after = await longformSourceSha256V1(sourcePath, runtime.signal), currentIdentity = await getMaterialColorRuntimeIdentity(runtime);
  if (colorDigest(before) !== colorDigest(after) || currentIdentity.status !== "verified" || currentIdentity.identitySha256 !== identity.identitySha256
    || await longformUiFocusProjectClockAlgorithmSha256V1() !== implementationSha256) throw Error("UI_FOCUS_PROJECT_CLOCK_INPUT_CHANGED");
  if (colorDigest(projectInput) !== colorDigest(project) || colorDigest(artifactInput) !== colorDigest(artifact) || colorDigest(holdInput) !== colorDigest(hold))
    throw Error("UI_FOCUS_PROJECT_CLOCK_ARGUMENT_CHANGED");
  runtime.signal?.throwIfAborted();
  return assembleLongformUiFocusProjectClockV1(project, artifact, hold, actual,
    { decodeRuntimeIdentitySha256: identity.identitySha256, implementationSha256 }, projectTimeBase);
}
