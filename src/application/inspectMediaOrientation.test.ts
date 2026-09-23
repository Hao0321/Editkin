import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { inspectMedia } from "./inspectMedia";
import { probeMedia } from "../render/ffmpegMedia";

const app = resolve(import.meta.dirname, "../..");
const ffmpeg = process.env.HAO_FFMPEG_PATH ?? join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = process.env.HAO_FFPROBE_PATH ?? join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const cases = [
  { name: "landscape-0", width: 96, height: 64, rotation: 0, display: [96, 64] },
  { name: "landscape-90", width: 96, height: 64, rotation: 90, display: [64, 96] },
  { name: "landscape-180", width: 96, height: 64, rotation: 180, display: [96, 64] },
  { name: "landscape-270", width: 96, height: 64, rotation: 270, display: [64, 96] },
  { name: "landscape-minus90", width: 96, height: 64, rotation: -90, display: [64, 96] },
  { name: "portrait-0", width: 64, height: 96, rotation: 0, display: [64, 96] },
  { name: "portrait-90", width: 64, height: 96, rotation: 90, display: [96, 64] },
  { name: "portrait-180", width: 64, height: 96, rotation: 180, display: [64, 96] },
  { name: "portrait-270", width: 64, height: 96, rotation: 270, display: [96, 64] },
  { name: "portrait-minus90", width: 64, height: 96, rotation: -90, display: [96, 64] },
];
let root: string;
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function run(executable: string, args: string[]) {
  const result = spawnSync(executable, args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw Error(`${executable} exit ${result.status}: ${result.error?.message ?? result.stderr.toString()}`);
  return result;
}

beforeAll(async () => {
  const evidence = join(app, ".rd/ui-library-20260831/orientation");
  await mkdir(evidence, { recursive: true });
  root = await mkdtemp(join(evidence, "test-"));
  for (const [width, height] of [[96, 64], [64, 96]]) {
    run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:r=4:d=0.5`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0", join(root, `base-${width}.mp4`)]);
  }
  for (const item of cases) run(ffmpeg, ["-v", "error", "-display_rotation:v:0", String(item.rotation), "-i", join(root, `base-${item.width}.mp4`), "-map", "0:v:0", "-c", "copy", join(root, `${item.name}.mp4`)]);
}, 30000);

describe("inspect/import display geometry while render probe retains encoded geometry", () => {
  it.each(cases)("real $name matches actual autorotated decoder dimensions", async item => {
    const source = join(root, `${item.name}.mp4`), before = hash(await readFile(source));
    const lowLevel = await probeMedia(source, ffprobe), imported = await inspectMedia(source, ffprobe);
    const actual = run(ffmpeg, ["-hide_banner", "-v", "info", "-i", source, "-vf", "showinfo", "-frames:v", "1", "-f", "null", "-"]);
    const dimensions = actual.stderr.toString().match(/\[Parsed_showinfo_[^\]]+\].*?\bs:(\d+)x(\d+)/);
    if (!dimensions) throw Error("Independent decoder did not emit frame geometry");
    const decoded = [Number(dimensions[1]), Number(dimensions[2])];
    const sourceProbe = JSON.parse(run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=side_data_type,rotation", "-of", "json", source]).stdout.toString());
    const rawRotation = sourceProbe.streams[0].side_data_list?.find((value: { side_data_type?: string }) => value.side_data_type === "Display Matrix")?.rotation ?? 0;
    const evidence = { item, decoded, lowLevel, imported, rawRotation, before, after: hash(await readFile(source)), originalUnchanged: before === hash(await readFile(source)), technicalOnly: true };
    await writeFile(join(root, `${item.name}.json`), JSON.stringify(evidence, null, 2));
    expect(decoded).toEqual(item.display);
    expect([lowLevel.width, lowLevel.height]).toEqual([item.width, item.height]);
    expect([imported.width, imported.height]).toEqual(decoded);
    expect(imported.encodedWidth).toBe(item.width);
    expect(imported.encodedHeight).toBe(item.height);
    expect(imported.displayRotationDegrees ?? 0).toBe(rawRotation);
    expect(imported.colorTransfer).toBe("bt709");
    expect(imported.colorPrimaries).toBe("bt709");
    expect(evidence.originalUnchanged).toBe(true);
    if (Math.abs(item.rotation % 180) === 90) expect([lowLevel.width, lowLevel.height]).not.toEqual(decoded);
  });
});
