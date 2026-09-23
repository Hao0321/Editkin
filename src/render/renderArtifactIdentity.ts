import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { runProcess } from "./mediaProcess";

export interface RenderArtifactIdentity {
  schema: "editkin.render-artifact-identity/v1";
  outputSha256: string;
  bytes: number;
  fps: number;
  durationFrames: number;
  projectContentSha256: string;
}

export function parseOutputFrameIdentity(stdout: string, counted = false) {
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];
  const rate = String(stream?.avg_frame_rate ?? "").split("/").map(Number);
  const fps = rate.length === 2 ? rate[0] / rate[1] : NaN;
  const durationFrames = Number(counted ? stream?.nb_read_frames : stream?.nb_frames);
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("輸出沒有有效的實測 fps");
  return { fps, durationFrames: Number.isSafeInteger(durationFrames) && durationFrames > 0 ? durationFrames : undefined };
}

/** Actual output identity only, not a quality certificate. Never removes output on failure. */
export async function collectRenderArtifactIdentity(outputPath: string, projectContentSha256: string, ffprobePath = "ffprobe", probe = runProcess): Promise<RenderArtifactIdentity> {
  if (!/^[a-f0-9]{64}$/.test(projectContentSha256)) throw new Error("Invalid project content fingerprint");
  const before = await stat(outputPath, { bigint: true });
  if (!before.isFile() || before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("輸出不是有效影片檔案");
  const args = ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate,nb_frames,nb_read_frames", "-of", "json", outputPath];
  let frames = parseOutputFrameIdentity((await probe(ffprobePath, args, 30_000)).stdout);
  if (!frames.durationFrames) frames = parseOutputFrameIdentity((await probe(ffprobePath, ["-count_frames", ...args], 60_000)).stdout, true);
  if (!frames.durationFrames) throw new Error("輸出幀數無法實測，未簽發身分收據");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(outputPath, { highWaterMark: 1024 * 1024 })) digest.update(chunk);
  const after = await stat(outputPath, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("輸出在身分驗證期間變更");
  return { schema: "editkin.render-artifact-identity/v1", outputSha256: digest.digest("hex"), bytes: Number(after.size), fps: frames.fps, durationFrames: frames.durationFrames, projectContentSha256 };
}
