import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { readBoundedFile } from "../shared/boundedFile";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { longformWordTimingRequestV1Schema, type LongformWordTimingRequestV1 } from "../domain/longformWordTimingV1";
import { inspectMedia } from "./inspectMedia";

export interface LongformMaterialIdentityV1 {
  id: string; kind: "narration" | "recording" | "screenshot"; path: string; sha256: string; bytes: number;
  sourceStart: number; duration: number; mediaDuration: number; width: number; height: number; hasAudio: boolean;
}
export interface LongformMaterialIntakeV1 {
  request: LongformWordTimingRequestV1; materials: LongformMaterialIdentityV1[];
  script: { text: string; sha256: string; file?: { path: string; sha256: string };
    paragraphs: Array<{ id: string; text: string }> };
}
export interface LongformIntakeRuntimeV1 {
  sourceRoot: string; ffprobePath?: string; signal?: AbortSignal;
  probe?: typeof inspectMedia;
}

export async function longformSourceSha256V1(path: string, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  signal?.throwIfAborted(); assertLocalMediaPath(path);
  const before = await stat(path);
  if (!before.isFile()) throw new Error("LONGFORM_SOURCE_NOT_FILE");
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(path)) { signal?.throwIfAborted(); hash.update(chunk); bytes += chunk.length; }
  const after = await stat(path);
  if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new Error("LONGFORM_SOURCE_CHANGED");
  return { sha256: hash.digest("hex"), bytes };
}

export async function resolveLongformSourceV1(root: string, input: string): Promise<string> {
  assertLocalMediaPath(root); assertLocalMediaPath(input);
  const base = await realpath(resolve(root)), target = await realpath(resolve(base, input));
  const relation = relative(base, target);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) throw new Error("LONGFORM_SOURCE_BOUNDARY");
  assertLocalMediaPath(target);
  if (!(await stat(target)).isFile()) throw new Error("LONGFORM_SOURCE_NOT_FILE");
  return target;
}

export async function assertLongformIntakeCurrentV1(intake: LongformMaterialIntakeV1, signal?: AbortSignal) {
  for (const row of intake.materials) {
    const actual = await longformSourceSha256V1(row.path, signal);
    if (actual.sha256 !== row.sha256 || actual.bytes !== row.bytes) throw new Error("LONGFORM_SOURCE_CHANGED");
  }
  if (intake.script.file && (await longformSourceSha256V1(intake.script.file.path, signal)).sha256 !== intake.script.file.sha256)
    throw new Error("LONGFORM_SCRIPT_CHANGED");
}

/** Read-only material intake. It establishes identities and ranges, not rights,
 * speech verification, shot selection, privacy detection or permission to edit. */
export async function prepareLongformMaterialIntakeV1(raw: unknown, runtime: LongformIntakeRuntimeV1): Promise<LongformMaterialIntakeV1> {
  const request = longformWordTimingRequestV1Schema.parse(raw);
  runtime.signal?.throwIfAborted();
  const materials: LongformMaterialIdentityV1[] = [];
  const sources = [{ ...request.narration, kind: "narration" as const },
    ...request.recordings.map(row => ({ ...row, kind: "recording" as const })),
    ...request.screenshots.map(row => ({ ...row, sourceStart: 0, duration: 0, kind: "screenshot" as const }))];
  for (const source of sources) {
    const path = await resolveLongformSourceV1(runtime.sourceRoot, source.path);
    if (source.kind === "screenshot" && ![".png", ".jpg", ".jpeg", ".webp"].includes(extname(path).toLowerCase()))
      throw new Error("LONGFORM_SCREENSHOT_FORMAT");
    const identity = await longformSourceSha256V1(path, runtime.signal);
    if (source.expectedSha256 && source.expectedSha256 !== identity.sha256) throw new Error("LONGFORM_SOURCE_SHA_MISMATCH");
    const probe = await (runtime.probe ?? inspectMedia)(path, runtime.ffprobePath);
    runtime.signal?.throwIfAborted();
    if (source.kind === "narration" && !probe.hasAudio) throw new Error("LONGFORM_NARRATION_AUDIO_MISSING");
    if (source.kind !== "narration" && !((probe.width ?? 0) > 0 && (probe.height ?? 0) > 0)) throw new Error("LONGFORM_PICTURE_MISSING");
    if (source.kind !== "screenshot" && (!Number.isFinite(probe.duration) || probe.duration <= 0
      || source.sourceStart + source.duration > probe.duration + .05)) throw new Error("LONGFORM_SOURCE_RANGE");
    materials.push({ id: source.id, kind: source.kind, path, ...identity, sourceStart: source.sourceStart,
      duration: source.duration, mediaDuration: source.kind === "screenshot" ? 0 : probe.duration,
      width: probe.width ?? 0, height: probe.height ?? 0, hasAudio: probe.hasAudio });
  }
  let text: string, paragraphs: Array<{ id: string; text: string }>, file: LongformMaterialIntakeV1["script"]["file"];
  if (request.script.kind === "paragraphs") {
    paragraphs = request.script.paragraphs.map(row => ({ ...row })); text = paragraphs.map(row => row.text).join("\n\n");
  } else {
    if (request.script.kind === "file") {
      const path = await resolveLongformSourceV1(runtime.sourceRoot, request.script.path);
      const bytes = await readBoundedFile(path, 2 * 1024 * 1024);
      runtime.signal?.throwIfAborted();
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      file = { path, sha256: createHash("sha256").update(bytes).digest("hex") };
    } else text = request.script.text;
    paragraphs = text.split(/\r?\n\s*\r?\n/u).map(part => part.trim()).filter(Boolean)
      .map((part, index) => ({ id: `paragraph-${index + 1}`, text: part }));
  }
  if (!text.trim() || text.length > 500000 || paragraphs.length > 1024) throw new Error("LONGFORM_SCRIPT_BUDGET");
  const intake: LongformMaterialIntakeV1 = { request, materials, script: { text,
    sha256: createHash("sha256").update(text).digest("hex"), paragraphs, ...(file ? { file } : {}) } };
  await assertLongformIntakeCurrentV1(intake, runtime.signal);
  return intake;
}
