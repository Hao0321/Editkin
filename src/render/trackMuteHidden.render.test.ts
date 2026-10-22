import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_TMP, useTempRoots } from "../test/tempRoot.mjs";
import { parseProject } from "../application/projectCodec";
import { renderProject } from "./ffmpeg";

// Real exports through the product's export entry (renderProject) of saved-project JSON loaded through the real load path
// (parseProject: migration, schema, validation), decoded back to raw frames and PCM. 「靜音」 is sound only and
// 「隱藏畫面」 picture only; a project saved before the split (muted picture track, no `hidden`) renders exactly as before:
// the muted track adds neither picture nor sound, byte for byte.
const app = fileURLToPath(new URL("../../", import.meta.url));
const ff = resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const fp = resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const temp = useTempRoots();
function run(args: string[]): Buffer {
  const result = spawnSync(ff, args, { windowsHide: true, timeout: 60_000, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const clip = (id: string, assetId: string, trackId: string, timelineStart: number, duration: number) => ({ id, assetId, trackId, timelineStart, sourceStart: 0, duration,
  volume: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1 }, keyframes: [] });

it("old muted picture tracks render byte-identically; mute now silences only, hide now only removes the picture", async () => {
  const dir = await temp.create("track-mute-hidden-", { parent: REPO_TMP });
  const media = (name: string, color: string, tone: number) => {
    const file = resolve(dir, name);
    run(["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=30:d=2`, "-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=48000:duration=2`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    return file;
  };
  const main = media("main.mp4", "red", 440), over = media("over.mp4", "blue", 880);
  const saved = (overTrack?: Record<string, unknown>) => ({
    schemaVersion: 9, revision: 1, id: "mute-hidden", name: "Mute hidden", width: 160, height: 90, fps: 30, editorialProfile: "auto",
    assets: [{ id: "main", name: "Main", kind: "video", uri: main, duration: 2, width: 160, height: 90 }, { id: "over", name: "Over", kind: "video", uri: over, duration: 2, width: 160, height: 90 }],
    compositions: [],
    tracks: [{ id: "video-main", name: "主畫面", kind: "video", locked: false, muted: false, clips: [clip("main-clip", "main", "video-main", 0, 2)] },
      { id: "audio-main", name: "聲音", kind: "audio", locked: false, muted: false, clips: [] },
      { id: "caption-main", name: "字幕", kind: "caption", locked: false, muted: false, clips: [] },
      ...(overTrack ? [{ id: "v2", name: "畫面軌 2", kind: "video", locked: false, muted: false, clips: [clip("over-clip", "over", "v2", 0.5, 1)], ...overTrack }] : [])],
    captions: [], motionTracks: [], motionGraphics: [],
    director: { schema: "editkin.director-console/v1", reviewState: "draft", markers: [], updatedAt: "2026-10-01T00:00:00.000Z" }, updatedAt: "2026-10-01T00:00:00.000Z",
  });
  const render = async (name: string, raw: unknown) => {
    const output = resolve(dir, `${name}.mp4`);
    await renderProject(parseProject(raw), output, { ffmpegPath: ff, ffprobePath: fp, preferGpu: false, workRoot: dir });
    return { frames: sha(run(["-v", "error", "-i", output, "-an", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])),
      pcm: sha(run(["-v", "error", "-i", output, "-vn", "-f", "s16le", "-ac", "2", "-ar", "48000", "-"])), file: sha(run(["-v", "error", "-i", output, "-c", "copy", "-f", "nut", "-"])) };
  };
  const none = await render("none", saved());
  const old = await render("old-muted", saved({ muted: true }));
  const shown = await render("on", saved({}));
  const soundOff = await render("muted", saved({ muted: true, hidden: false }));
  const pictureOff = await render("hidden", saved({ muted: false, hidden: true }));
  // Old project: exactly the same pixels and sound as if the muted track were not there (as before the split).
  expect(old).toEqual(none);
  // Mute (sound only): the picture shows, the sound is the main clip's alone.
  expect(soundOff.frames).toBe(shown.frames);
  expect(soundOff.frames).not.toBe(none.frames);
  expect(soundOff.pcm).toBe(none.pcm);
  // Hide (picture only): no picture from the track, its sound still plays.
  expect(pictureOff.frames).toBe(none.frames);
  expect(pictureOff.pcm).toBe(shown.pcm);
  expect(pictureOff.pcm).not.toBe(none.pcm);
}, 120_000);
