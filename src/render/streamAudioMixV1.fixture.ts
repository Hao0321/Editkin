import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import type { EditProject } from "../domain/types";
import type { RenderPlan } from "./planner";
import { clipAudioEnvelopeFilter } from "./clipAudioEnvelopeFilters";
import { finite } from "./ffmpegExpressions";
import { masterAudioFilter } from "./ffmpegMedia";
import { FFMPEG_PROGRESS_ARGS } from "./mediaProcess";

/** Independent test oracle: execute the actual unchanged legacy function body.
 * It captures its command, without reimplementing the candidate's filter algorithm. */
export async function captureLegacyAudioCommandV1(project: EditProject, plan: RenderPlan,
  probe: (path: string) => Promise<{ hasAudio: boolean }>): Promise<string[]> {
  const raw = await readFile(resolve("src/render/ffmpeg.ts"), "utf8");
  const tree = ts.createSourceFile("ffmpeg.ts", raw, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "renderAudioBed");
  if (!node || !ts.isFunctionDeclaration(node)) throw Error("legacy audio oracle function missing");
  const javascript = ts.transpileModule(node.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let command: string[] | undefined;
  const legacy = new Function("probeMedia", "clipAudioEnvelopeFilter", "finite", "masterAudioFilter", "runProcess", "FFMPEG_PROGRESS_ARGS",
    `${javascript}; return renderAudioBed;`)(probe, clipAudioEnvelopeFilter, finite, masterAudioFilter,
    async (_executable: string, args: string[]) => { command = args; }, FFMPEG_PROGRESS_ARGS);
  await legacy(project, plan, "oracle-audio.m4a", "oracle-ffmpeg", 30_000, "oracle-ffprobe");
  if (!command) throw Error("legacy audio oracle command missing");
  return command;
}

/** Stabilize the independently captured original graph only when it uses a sidechain.
 * n8.1.3 sidechaincompress forwards either EOF before both FIFO tails are drained. */
export function stabilizeLegacySidechainEofV1(filter: string, duration: number): string {
  if (!filter.includes("sidechaincompress=")) return filter;
  return filter.replace("[musicbus];", "[musicbus-source];[musicbus-source]apad[musicbus];")
    .replace("[voicekey];", "[voicekey-source];[voicekey-source]apad[voicekey];")
    .replace("[premaster];", `[premaster-untrimmed];[premaster-untrimmed]atrim=duration=${finite(duration)}[premaster];`);
}
