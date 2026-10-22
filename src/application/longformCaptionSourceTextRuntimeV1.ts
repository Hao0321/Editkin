import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { readBoundedFile } from "../shared/boundedFile";
import { LONGFORM_WORD_TIMING_V1 } from "../domain/longformWordTimingV1";
import type { readLongformWordWindowV1 } from "./longformWordRecognitionV1";
import { projectLongformCaptionSourceTextV1 } from "./longformCaptionSourceTextV1";

export async function readLongformCaptionSourceTextV1(root: string,
  current: NonNullable<Awaited<ReturnType<typeof readLongformWordWindowV1>>>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/.test(current.index.key) || basename(current.index.rawFile) !== current.index.rawFile
    || !new RegExp(`^${current.index.key}-[a-f0-9-]{36}\\.raw\\.json$`).test(current.index.rawFile))
    throw Error("CAPTION_SOURCE_CACHE_IDENTITY");
  const raw = await readBoundedFile(join(root, current.index.rawFile), LONGFORM_WORD_TIMING_V1.maximumWindowJsonBytes);
  signal?.throwIfAborted();
  if (createHash("sha256").update(raw).digest("hex") !== current.index.rawSha256) throw Error("CAPTION_SOURCE_CACHE_SHA");
  return projectLongformCaptionSourceTextV1(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw), current.parsed);
}
