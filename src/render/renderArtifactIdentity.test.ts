import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collectRenderArtifactIdentity, parseOutputFrameIdentity } from "./renderArtifactIdentity";
import { renderReviewContentJson } from "../shared/renderReviewContent";
import { canonicalJson } from "../shared/canonicalJson";
import { createDemoProject } from "../domain/demo";
import { resolveAestheticSystem } from "../application/editkinAesthetic";
import { runProcess } from "./ffmpegMedia";
import { renderProject } from "./ffmpeg";

const fingerprint = "a".repeat(64);
describe("render output identity (not aesthetic certification)", () => {
  it("uses canonical encoding and excludes only specified review metadata", () => {
    const project = createDemoProject(); project.aestheticSystem = resolveAestheticSystem("gaming");
    const before = renderReviewContentJson(project);
    project.revision += 1; project.updatedAt = new Date().toISOString();
    project.aestheticSystem.review.score = 83;
    project.director.updatedAt = "changed";
    expect(renderReviewContentJson(project)).toBe(before);
    const changed = structuredClone(project); changed.tracks[0].clips[0].duration -= 1;
    expect(renderReviewContentJson(changed)).not.toBe(before);
    const sourceChanged = structuredClone(project); sourceChanged.assets[0].uri = "different.mp4";
    expect(renderReviewContentJson(sourceChanged)).not.toBe(before);
    const captionChanged = structuredClone(project); captionChanged.captionStyle.color = "#ff0000";
    expect(renderReviewContentJson(captionChanged)).not.toBe(before);
    const effectChanged = structuredClone(project); effectChanged.tracks[0].clips[0].transform.opacity = 0.5;
    expect(renderReviewContentJson(effectChanged)).not.toBe(before);
    expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });
  it("does not fabricate frame counts or fps", () => {
    expect(parseOutputFrameIdentity('{"streams":[{"avg_frame_rate":"30000/1001","nb_frames":"30"}]}')).toEqual({ fps: 30000/1001, durationFrames: 30 });
    expect(parseOutputFrameIdentity('{"streams":[{"avg_frame_rate":"30/1"}]}').durationFrames).toBeUndefined();
    expect(() => parseOutputFrameIdentity('{"streams":[{"avg_frame_rate":"0/0"}]}')).toThrow();
  });
  it("rejects mutation during probing and preserves the output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "editkin-identity-mutation-"));
    const path = join(dir, "owned.mp4"); await writeFile(path, "initial");
    await expect(collectRenderArtifactIdentity(path, fingerprint, "fixture", async () => {
      await writeFile(path, "changed bytes");
      return { stdout: '{"streams":[{"avg_frame_rate":"30/1","nb_frames":"30"}]}', stderr: "" };
    })).rejects.toThrow("變更");
    expect((await stat(path)).size).toBeGreaterThan(0);
  });
  it("uses bounded count fallback and rejects missing counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "editkin-identity-probe-")); const path = join(dir, "owned.bin"); await writeFile(path, "synthetic probe fixture");
    const calls: string[][] = [];
    const receipt = await collectRenderArtifactIdentity(path, fingerprint, "fixture", async (_exe,args,timeout) => {
      calls.push(args); expect(timeout).toBeLessThanOrEqual(60000);
      return { stdout: JSON.stringify({ streams: [{ avg_frame_rate: "30/1", ...(args.includes("-count_frames") ? { nb_read_frames: "30" } : {}) }] }), stderr: "" };
    });
    expect(calls).toHaveLength(2); expect(receipt.durationFrames).toBe(30);
    await expect(collectRenderArtifactIdentity(path, fingerprint, "fixture", async () => ({ stdout: '{"streams":[{"avg_frame_rate":"30/1"}]}', stderr: "" }))).rejects.toThrow("幀數");
  });
  it("binds a real rendered synthetic video to actual bytes and measured frames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "editkin-render-identity-real-"));
    const source = join(dir,"synthetic-source.mp4"); const output = join(dir,"rendered.mp4");
    const ffmpegPath = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"); const ffprobePath = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
    await runProcess(ffmpegPath,["-v","error","-f","lavfi","-i","testsrc2=size=160x90:rate=30","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","1","-c:v","libx264","-c:a","aac",source],30000);
    const project = createDemoProject(); project.width=160; project.height=90;
    project.assets=project.assets.slice(0,1); project.assets[0].uri=source; project.assets[0].duration=1;
    project.tracks=project.tracks.slice(0,1); project.tracks[0].clips=project.tracks[0].clips.slice(0,1); project.tracks[0].clips[0].duration=1;
    project.captions=[]; project.motionGraphics=[]; project.motionTracks=[];
    const result = await renderProject(project,output,{ffmpegPath,ffprobePath,preferGpu:false});
    expect(result.artifactIdentity).toMatchObject({ fps:30,durationFrames:30,outputSha256:createHash("sha256").update(await readFile(output)).digest("hex"),projectContentSha256:createHash("sha256").update(renderReviewContentJson(project)).digest("hex") });
    console.log("RETAINED_SYNTHETIC_RENDER_IDENTITY",dir,result.artifactIdentity);
  },120000);
});
