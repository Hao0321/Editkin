// Independently verify the rendered pixels, saved timeline and source hash of an isolated Smart Cut run.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseAutopilotPlan } from "../src/application/autopilotPlan";

const root = resolve(import.meta.dirname, "../../artifacts/autopilot-desk");
const at = process.argv.indexOf("--workspace");
assert(at >= 0 && process.argv[at + 1]);
const workspace = realpathSync(resolve(process.argv[at + 1]));
assert.equal(dirname(workspace).toLowerCase(), realpathSync(root).toLowerCase());
assert.match(basename(workspace), /^kit-bound-create-[a-z0-9]+$/i);
const run = join(workspace, "videos/_AUTOPILOT/editkin-v4/gateway-smoke");
const state = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
for (const step of ["plan", "audit", "apply", "render"]) assert.equal(state.steps[step].status, "completed");
assert.equal(state.steps["human-review"].status, "pending");
const plan = parseAutopilotPlan(JSON.parse(await readFile(join(run, "plan.v4.json"), "utf8")));
const cut = plan.commands.find(command => command.type === "smart_cut_clip");
assert(cut && cut.clipId === "clip-source");
assert.deepEqual(cut.keepRanges, [{ start: 0, end: 2 }, { start: 4, end: 6 }]);
const sourceHash = createHash("sha256").update(await readFile(join(workspace, "source.mp4"))).digest("hex");
assert.equal(sourceHash, state.binding.materials[0].source_sha256);
const project = JSON.parse(await readFile(join(workspace, "movie.editkin.json"), "utf8"));
const clips = project.tracks.flatMap((track: { clips: Array<{ id: string; timelineStart: number; sourceStart: number; duration: number }> }) => track.clips);
assert.equal(clips.length, 2);
assert.deepEqual(clips.map((clip: { id: string; timelineStart: number; sourceStart: number; duration: number }) =>
  ({ id: clip.id, timelineStart: clip.timelineStart, sourceStart: clip.sourceStart, duration: clip.duration })),
  cut.segmentIds.map((id, index) => ({ id, timelineStart: index * 2, sourceStart: index * 4, duration: 2 })));
assert(project.captions.some((caption: { text: string }) => caption.text.includes("合成")));
const output = realpathSync(join(run, "render/current.mp4"));
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const probe = JSON.parse(execFileSync(executable("ffprobe"), ["-v", "error", "-show_entries", "format=duration,size", "-of", "json", output],
  { encoding: "utf8", timeout: 30_000 }));
assert(Math.abs(Number(probe.format.duration) - 4) < 0.1);
execFileSync(executable("ffmpeg"), ["-v", "error", "-i", output, "-f", "null", "-"], { timeout: 60_000, stdio: "ignore" });
const center = (second: number) => {
  const bytes = execFileSync(executable("ffmpeg"), ["-v", "error", "-ss", String(second), "-i", output,
    "-frames:v", "1", "-vf", "crop=2:2:(iw-2)/2:(ih-2)/2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { timeout: 60_000, maxBuffer: 4096 });
  return [bytes[0], bytes[1], bytes[2]];
};
const first = center(0.5), last = center(2.5);
assert(first[0] > first[1] * 1.5 && first[0] > first[2] * 1.5, `First output scene is not red: ${first}`);
assert(last[2] > last[0] * 1.5 && last[2] > last[1] * 1.5, `Last output scene is not blue: ${last}`);
const report = { status: "PASS", workspace, output, sourceSha256: sourceHash, duration: Number(probe.format.duration),
  outputBytes: Number(probe.format.size), editableClips: clips.length, editableCaptions: project.captions.length,
  firstCenterRgb: first, lastCenterRgb: last, nextStep: "human-review" };
await writeFile(join(workspace, "cut-render-qc.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
