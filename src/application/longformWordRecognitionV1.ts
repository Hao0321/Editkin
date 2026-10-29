import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson } from "../shared/canonicalJson";
import { readBoundedFile } from "../shared/boundedFile";
import { LONGFORM_WORD_TIMING_V1, type LongformParsedWordWindowV1, type LongformTimedWordV1, type LongformWordTimingWindowV1 } from "../domain/longformWordTimingV1";
import { automaticCaptionRuntimeSha256, inspectWhisperModel, PINNED_WHISPER_MODEL } from "./automaticCaptions";
import { selectedWhisperModelV1 } from "./whisperModelChoiceV1";
import { ensurePinnedModelFileV1 } from "./whisperPinnedDownloadV1";
import { withLongformWhisperModelV1, type LongformWhisperModelRuntimeFieldsV1 } from "./longformWhisperModelV1";
import { runAnalysisProcess } from "./analysisProcess";
import { captionWindows } from "./segmentedCaptions";
import { assertLongformIntakeCurrentV1, prepareLongformMaterialIntakeV1,
  resolveLongformSourceV1, type LongformIntakeRuntimeV1, type LongformMaterialIntakeV1 } from "./longformMaterialIntakeV1";
import { parseLongformWordWindowV1 } from "./longformWordTimingV1";
import { resolveLongformWhisperPromptV1, longformWhisperPromptArgumentsV1, type LongformWhisperPromptV1 } from "./longformWhisperPromptV1";

export interface LongformWordRecognitionRuntimeV1 extends LongformIntakeRuntimeV1, LongformWhisperModelRuntimeFieldsV1 {
  ffmpegPath: string; whisperCliPath: string; modelPath: string; modelRoot: string;
  cacheRoot: string; workRoot: string; threads?: number;
  onProgress?: (value: { completedWindows: number; totalWindows: number; cachedWindows: number }) => void | Promise<void>;
}
export interface LongformWordRecognitionDepsV1 {
  run: typeof runAnalysisProcess; inspectModel: typeof inspectWhisperModel; runtimeIdentity: typeof automaticCaptionRuntimeSha256;
  ensureModel?: typeof ensurePinnedModelFileV1;
}
const production: LongformWordRecognitionDepsV1 = { run: runAnalysisProcess, inspectModel: inspectWhisperModel, runtimeIdentity: automaticCaptionRuntimeSha256, ensureModel: ensurePinnedModelFileV1 };
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const bytesSha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const decode = (value: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
const safeId = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("WORD_TIMING_ARTIFACT_ID"); return value; };
const runtimeIdentityInput = (runtime: LongformWordRecognitionRuntimeV1) => ({
  ffmpegPath: runtime.ffmpegPath, whisperCliPath: runtime.whisperCliPath, modelRoot: runtime.modelRoot,
  modelPath: runtime.modelPath, whisperModel: runtime.whisperModel, cacheRoot: runtime.cacheRoot, signal: runtime.signal,
});

interface WindowIndex {
  schema: "editkin.longform-word-cache-window/v1"; key: string; rawFile: string; parsedFile: string;
  rawSha256: string; parsedSha256: string; wordCount: number; issueCount: number; segmentCount: number;
}
export interface LongformWordTimingArtifactV1 {
  schema: "editkin.longform-word-artifact/v1"; artifactId: string; intake: LongformMaterialIntakeV1;
  recognizer: { modelId: string; modelSha256: string; runtimeSha256: string; pipelineSha256: string; threads: number; prompt?: Readonly<LongformWhisperPromptV1> };
  windows: WindowIndex[]; wordCount: number; issueCount: number; segmentCount: number;
  state: "WORDS_AVAILABLE" | "REVIEW_REQUIRED" | "EMPTY"; contentVerified: false; syntheticTimingUsed: false;
}

async function exclusive(path: string, bytes: Buffer) {
  try { await writeFile(path, bytes, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readBoundedFile(path, bytes.length);
    if (!existing.equals(bytes)) throw new Error("WORD_TIMING_CACHE_CONFLICT");
  }
}
async function pipelineIdentity() {
  const files = ["longformWordRecognitionV1.ts", "longformWordTimingV1.ts", "longformMaterialIntakeV1.ts",
    "segmentedCaptions.ts", "automaticCaptions.ts", "analysisProcess.ts", "../domain/longformWordTimingV1.ts",
    "longformWhisperPromptV1.ts", "../domain/longformCaptionLexiconV1.ts",
    "whisperModelChoiceV1.ts", "whisperPinnedDownloadV1.ts", "longformWhisperModelV1.ts"];
  return digest(await Promise.all(files.map(async path => ({ path, sha256: bytesSha(await readFile(resolve(import.meta.dirname,path))) }))));
}
async function readWindow(root: string, key: string, duration: number, language: LongformMaterialIntakeV1["request"]["language"],
  expectedWindow: LongformWordTimingWindowV1, allowMissingIndex = false) {
  let indexBytes: Buffer;
  try { indexBytes = await readBoundedFile(join(root, safeId(key) + ".index.json"), 16384); }
  catch (error) { if (allowMissingIndex && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const index = JSON.parse(decode(indexBytes)) as WindowIndex;
  if (index.schema !== "editkin.longform-word-cache-window/v1" || index.key !== key
    || !new RegExp(`^${key}-[a-f0-9-]{36}\\.raw\\.json$`).test(index.rawFile)
    || !new RegExp(`^${key}-[a-f0-9-]{36}\\.parsed\\.json$`).test(index.parsedFile)
    || basename(index.rawFile) !== index.rawFile || basename(index.parsedFile) !== index.parsedFile)
    throw new Error("WORD_TIMING_WINDOW_CACHE_IDENTITY");
  const raw = await readBoundedFile(join(root,index.rawFile), LONGFORM_WORD_TIMING_V1.maximumWindowJsonBytes);
  const parsedBytes = await readBoundedFile(join(root,index.parsedFile), 8 * 1024 * 1024);
  if (bytesSha(raw) !== index.rawSha256 || bytesSha(parsedBytes) !== index.parsedSha256) throw new Error("WORD_TIMING_WINDOW_CACHE_SHA");
  const saved = JSON.parse(decode(parsedBytes)) as LongformParsedWordWindowV1;
  if (canonicalJson(saved.window) !== canonicalJson(expectedWindow)) throw new Error("WORD_TIMING_WINDOW_CACHE_CLOCK");
  const parsed = parseLongformWordWindowV1(decode(raw), saved.window, duration, language);
  if (canonicalJson(parsed) !== canonicalJson(saved) || parsed.words.length !== index.wordCount
    || parsed.issues.length !== index.issueCount || parsed.segments.length !== index.segmentCount)
    throw new Error("WORD_TIMING_WINDOW_CACHE_CONTENT");
  return { index, parsed };
}

/** Only the existing small and explicitly selected pinned medium are admitted. Cached recognition is source-
 * and pipeline-bound; it never claims the transcript is physically verified. */
export async function prepareLongformWordRecognitionV1(raw: unknown, runtime: LongformWordRecognitionRuntimeV1,
  deps: LongformWordRecognitionDepsV1 = production) {
  const intake = await prepareLongformMaterialIntakeV1(raw,runtime);
  runtime = withLongformWhisperModelV1(runtime, intake.request.whisperModel);
  const selectedModel = selectedWhisperModelV1(runtime.whisperModel, PINNED_WHISPER_MODEL);
  const prompt = resolveLongformWhisperPromptV1(intake.request.language, intake.request.initialPrompt);
  let model = await deps.inspectModel(runtime.modelPath, selectedModel);
  if (!model.valid && runtime.whisperModel === "medium") {
    const expectedPath = resolve(runtime.modelRoot, selectedModel.fileName), selectedPath = resolve(runtime.modelPath);
    const isDefaultPath = process.platform === "win32" ? selectedPath.toLowerCase() === expectedPath.toLowerCase() : selectedPath === expectedPath;
    await (deps.ensureModel ?? ensurePinnedModelFileV1)({ ...runtime, modelPath: isDefaultPath ? undefined : runtime.modelPath }, selectedModel);
    model = await deps.inspectModel(runtime.modelPath, selectedModel);
  }
  if (!model.valid) throw new Error("WORD_TIMING_PINNED_MODEL_UNAVAILABLE");
  runtime.signal?.throwIfAborted();
  const threads = runtime.threads ?? 4;
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 16) throw new Error("WORD_TIMING_THREADS");
  const runtimeSha256 = await deps.runtimeIdentity(runtimeIdentityInput(runtime)), pipelineSha256 = await pipelineIdentity();
  const help = await deps.run(runtime.whisperCliPath,["--help"],{ timeoutMs:10000,label:"Word timing runtime",signal:runtime.signal });
  if (!/--output-json-full\b/.test(help.stdout.toString("utf8") + help.stderr)) throw new Error("WORD_TIMING_RUNTIME_FULL_JSON_MISSING");
  const promptArguments = longformWhisperPromptArgumentsV1(prompt, help.stdout.toString("utf8") + help.stderr);
  const recognizer = { modelId:selectedModel.id,modelSha256:selectedModel.sha256,runtimeSha256,pipelineSha256,threads,prompt };
  const narration = intake.materials.find(row=>row.kind === "narration")!;
  const scope = { narration,language:intake.request.language,recognizer,contract:LONGFORM_WORD_TIMING_V1 };
  const artifactId = digest({ intake,recognizer,contract:LONGFORM_WORD_TIMING_V1 });
  const root = join(resolve(runtime.cacheRoot),"longform-word-timing-v1"), windowRoot = join(root,"windows");
  await mkdir(windowRoot,{recursive:true}); await mkdir(join(root,"artifacts"),{recursive:true});
  await mkdir(resolve(runtime.workRoot),{recursive:true});
  const work = await mkdtemp(join(resolve(runtime.workRoot),"longform-word-"));
  const windows: WindowIndex[] = []; let cachedWindows = 0;
  try {
    const plans = captionWindows(narration.duration);
    for (const window of plans) {
      runtime.signal?.throwIfAborted();
      const key = digest({scope,window});
      const cached = await readWindow(windowRoot,key,narration.duration,intake.request.language,window,true);
      if (cached) { windows.push(cached.index); cachedWindows++; }
      else {
        const audio = join(work,`speech-${window.index}.wav`), prefix = join(work,`recognition-${window.index}`);
        await deps.run(runtime.ffmpegPath,["-v","error","-nostdin","-y","-ss",String(narration.sourceStart+window.start),
          "-t",String(window.duration),"-i",narration.path,"-map","0:a:0","-vn","-sn","-dn","-ac","1","-ar","16000","-c:a","pcm_s16le",audio],
          {timeoutMs:180000,label:"Word timing audio extraction",signal:runtime.signal});
        await deps.run(runtime.whisperCliPath,["-m",runtime.modelPath,"-f",audio,"-l",intake.request.language,"-ojf","-of",prefix,"-np","-t",String(threads),...promptArguments],
          {timeoutMs:180000,label:"Word timing recognition",signal:runtime.signal});
        const rawBytes = await readBoundedFile(prefix+".json",LONGFORM_WORD_TIMING_V1.maximumWindowJsonBytes);
        const parsed = parseLongformWordWindowV1(decode(rawBytes),window,narration.duration,intake.request.language);
        const parsedBytes = jsonBytes(parsed), suffix = randomUUID();
        const index: WindowIndex = {schema:"editkin.longform-word-cache-window/v1",key,
          rawFile:`${key}-${suffix}.raw.json`,parsedFile:`${key}-${suffix}.parsed.json`,rawSha256:bytesSha(rawBytes),parsedSha256:bytesSha(parsedBytes),
          wordCount:parsed.words.length,issueCount:parsed.issues.length,segmentCount:parsed.segments.length};
        await exclusive(join(windowRoot,index.rawFile),rawBytes); await exclusive(join(windowRoot,index.parsedFile),parsedBytes);
        await exclusive(join(windowRoot,key+".index.json"),jsonBytes(index));
        windows.push(index);
      }
      await runtime.onProgress?.({completedWindows:windows.length,totalWindows:plans.length,cachedWindows});
    }
    await assertLongformIntakeCurrentV1(intake,runtime.signal);
    if (!(await deps.inspectModel(runtime.modelPath, selectedModel)).valid || await deps.runtimeIdentity(runtimeIdentityInput(runtime)) !== runtimeSha256
      || await pipelineIdentity() !== pipelineSha256) throw new Error("WORD_TIMING_RECOGNIZER_CHANGED");
    const wordCount = windows.reduce((sum,row)=>sum+row.wordCount,0), issueCount = windows.reduce((sum,row)=>sum+row.issueCount,0);
    const artifact: LongformWordTimingArtifactV1 = {schema:"editkin.longform-word-artifact/v1",artifactId,intake,recognizer,windows,wordCount,issueCount,
      segmentCount:windows.reduce((sum,row)=>sum+row.segmentCount,0),state:wordCount === 0 ? "EMPTY" : issueCount ? "REVIEW_REQUIRED" : "WORDS_AVAILABLE",
      contentVerified:false,syntheticTimingUsed:false};
    const payload = jsonBytes(artifact); if (payload.length > 8*1024*1024) throw new Error("WORD_TIMING_ARTIFACT_BUDGET");
    await exclusive(join(root,"artifacts",artifactId+".json"),jsonBytes({artifact,sha256:bytesSha(payload)}));
    return {artifact,cachedWindows};
  } finally {
    const [parent,target] = await Promise.all([realpath(runtime.workRoot),realpath(work)]);
    const relation = relative(parent,target);
    if (!relation || relation.startsWith("..") || isAbsolute(relation)) throw new Error("WORD_TIMING_WORKSPACE_OWNERSHIP");
    await rm(target,{recursive:true,force:true});
  }
}

export async function readLongformWordArtifactV1(runtime: Pick<LongformWordRecognitionRuntimeV1,"cacheRoot"|"sourceRoot"|"signal">, artifactId: string) {
  const path = join(resolve(runtime.cacheRoot),"longform-word-timing-v1/artifacts",safeId(artifactId)+".json");
  const stored = JSON.parse(decode(await readBoundedFile(path, 9*1024*1024))) as {artifact:LongformWordTimingArtifactV1;sha256:string};
  if (stored.artifact.schema !== "editkin.longform-word-artifact/v1" || stored.artifact.artifactId !== artifactId
    || digest({intake:stored.artifact.intake,recognizer:stored.artifact.recognizer,contract:LONGFORM_WORD_TIMING_V1}) !== artifactId
    || bytesSha(jsonBytes(stored.artifact)) !== stored.sha256) throw new Error("WORD_TIMING_ARTIFACT_SHA");
  for (const material of stored.artifact.intake.materials) await resolveLongformSourceV1(runtime.sourceRoot,material.path);
  if (stored.artifact.intake.script.file) await resolveLongformSourceV1(runtime.sourceRoot,stored.artifact.intake.script.file.path);
  await assertLongformIntakeCurrentV1(stored.artifact.intake,runtime.signal);
  return stored.artifact;
}
export async function readLongformWordPageV1(runtime: Pick<LongformWordRecognitionRuntimeV1,"cacheRoot"|"sourceRoot"|"signal">,
  artifactId: string, offset = 0, limit = 100) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("WORD_TIMING_PAGE");
  const artifact = await readLongformWordArtifactV1(runtime,artifactId), words: LongformTimedWordV1[] = [];
  let seen = 0;
  const plans = captionWindows(artifact.intake.request.narration.duration);
  if (artifact.windows.length !== plans.length) throw new Error("WORD_TIMING_WINDOW_REFERENCE");
  for (const [index,row] of artifact.windows.entries()) {
    if (seen+row.wordCount > offset && words.length < limit) {
      const actual = await readWindow(join(resolve(runtime.cacheRoot),"longform-word-timing-v1/windows"),row.key,
        artifact.intake.request.narration.duration,artifact.intake.request.language,plans[index]);
      if (!actual) throw new Error("WORD_TIMING_WINDOW_REFERENCE");
      if (canonicalJson(actual.index) !== canonicalJson(row)) throw new Error("WORD_TIMING_WINDOW_REFERENCE");
      words.push(...actual.parsed.words.slice(Math.max(0,offset-seen),Math.max(0,offset-seen)+limit-words.length));
    }
    seen += row.wordCount;
  }
  return {artifactId,state:artifact.state,clock:"narration_local_seconds"as const,total:artifact.wordCount,offset,words,
    nextOffset:offset+words.length < artifact.wordCount ? offset+words.length : null,contentVerified:false};
}

/** Missing and disputed ranges remain inspectable; word pages never conceal
 * them by manufacturing timestamps for the omitted text. */
export async function readLongformWordIssuePageV1(runtime:Pick<LongformWordRecognitionRuntimeV1,"cacheRoot"|"sourceRoot"|"signal">,
  artifactId:string,offset=0,limit=100){
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error("WORD_TIMING_PAGE");
  const artifact=await readLongformWordArtifactV1(runtime,artifactId),issues:LongformParsedWordWindowV1["issues"]=[];
  const plans=captionWindows(artifact.intake.request.narration.duration);let seen=0;
  if(artifact.windows.length!==plans.length)throw new Error("WORD_TIMING_WINDOW_REFERENCE");
  for(const [index,row]of artifact.windows.entries()){
    runtime.signal?.throwIfAborted();
    if(seen+row.issueCount>offset&&issues.length<limit){
      const actual=await readWindow(join(resolve(runtime.cacheRoot),"longform-word-timing-v1/windows"),row.key,
        artifact.intake.request.narration.duration,artifact.intake.request.language,plans[index]);
      if(!actual||canonicalJson(actual.index)!==canonicalJson(row))throw new Error("WORD_TIMING_WINDOW_REFERENCE");
      issues.push(...actual.parsed.issues.slice(Math.max(0,offset-seen),Math.max(0,offset-seen)+limit-issues.length));
    }seen+=row.issueCount;
  }
  return {artifactId,state:artifact.state,total:artifact.issueCount,offset,issues,
    nextOffset:offset+issues.length<artifact.issueCount?offset+issues.length:null,contentVerified:false,syntheticTimingUsed:false};
}

export { readWindow as readLongformWordWindowV1 };
