import { randomUUID } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../shared/canonicalJson";
import type { TimeRemapFingerprintV1 } from "./timeRemapCacheContractV1";
import { assertTimeRemapLocalPathV1, timeRemapFingerprintV1, timeRemapSha256V1, timeRemapToolIdentityV1 } from "./timeRemapCacheIdentityV1";
import { timeRemapCacheRootV1 } from "./timeRemapCacheStoreV1";
import { buildDecodedPtsIndexV1 } from "./decodedPtsIndexV1";
import { createOwnedDirectoryV1, openLongRenderJournalV1, replayLongRenderJournalsV1 } from "./longRenderOwnerJournalV1";
import { probeVolumeSpace } from "./renderDiskSpace";
import { withRenderLifetime, renderLifetimeSignal, assertRenderActive } from "./renderLifetime";

type FingerprintStat = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
const fingerprint = (s: FingerprintStat): TimeRemapFingerprintV1 => ({ dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) });
type Indexed = Awaited<ReturnType<typeof buildDecodedPtsIndexV1>>;
interface State {
  sourcePath: string; ffmpegPath: string; ffprobePath: string; helperTemporaryRoot: string; projectRoot: string; projectVolume: string;
  source: FileHandle; metadata: FileHandle; sourceIdentity: TimeRemapFingerprintV1; sourceSha256: string;
  ffmpegIdentity: string; ffprobeIdentity: string; maximumMetadataBytes: number; signal?: AbortSignal;
  journal: Awaited<ReturnType<typeof openLongRenderJournalV1>>; indexed?: Indexed; profile?: string;
  borrowed: boolean; closed: boolean; failure?: unknown;
  receipt: { sourceHashes: number; sourceBytesHashed: number; indexBuilds: number; metadataBytes: number; metadataSha256?: string; borrows: number; closed: boolean };
}
export interface SourceClockIndexSessionV1 {
  readonly schema: "editkin.source-clock-index-session/v1";
  readonly receipt: Readonly<State["receipt"]>;
  close(): Promise<void>;
}
const sessions = new WeakMap<SourceClockIndexSessionV1, State>();
function state(session: SourceClockIndexSessionV1) {
  const s = sessions.get(session); if (!s || s.closed) throw Error("SOURCE_CLOCK_INDEX_SESSION_IDENTITY_REQUIRED");
  if (s.failure) throw Error("SOURCE_CLOCK_INDEX_SESSION_FAILED", { cause: s.failure }); return s;
}
export function sourceClockIndexLifetimeSignalV1(session: SourceClockIndexSessionV1, signal?: AbortSignal) {
  const s = state(session), signals = [s.signal, signal].filter((s): s is AbortSignal => !!s);
  return signals.length ? AbortSignal.any(signals) : undefined;
}
/** One held original and one disk-paged index. The caller closes this after every borrowed render ends.
 * Its token is process-local/non-forgeable; no serialized receipt can stand in for the live handles. */
export async function openSourceClockIndexSessionV1(input: {
  sourcePath: string; expectedSourceSha256: string; ffmpegPath: string; ffprobePath: string;
  projectRoot: string; helperTemporaryRoot: string; maximumMetadataBytes?: number; signal?: AbortSignal; timeoutMs?: number;
}): Promise<SourceClockIndexSessionV1> {
  const maximumMetadataBytes = input.maximumMetadataBytes ?? 64 * 1024 ** 2;
  if (!/^[a-f0-9]{64}$/.test(input.expectedSourceSha256) || !Number.isSafeInteger(maximumMetadataBytes) || maximumMetadataBytes < 24 || maximumMetadataBytes > 512 * 1024 ** 2) throw Error("SOURCE_CLOCK_INDEX_SESSION_BUDGET_OR_SHA_INVALID");
  return withRenderLifetime({ signal: input.signal, timeoutMs: input.timeoutMs ?? 120000 }, async () => {
    const signal = renderLifetimeSignal(), root = await timeRemapCacheRootV1(input.projectRoot, input.helperTemporaryRoot);
    await assertTimeRemapLocalPathV1(input.sourcePath);
    const sourceIdentity = await timeRemapFingerprintV1(input.sourcePath), source = await open(input.sourcePath, "r");
    let metadata: FileHandle | undefined, journal: State["journal"] | undefined;
    try {
      if (BigInt(sourceIdentity.size) > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("SOURCE_CLOCK_INDEX_SOURCE_SIZE_UNSAFE");
      if (canonicalJson(fingerprint(await source.stat({ bigint: true }))) !== canonicalJson(sourceIdentity)) throw Error("SOURCE_CLOCK_INDEX_SOURCE_CHANGED");
      const sourceSha256 = await timeRemapSha256V1(input.sourcePath, signal);
      if (sourceSha256 !== input.expectedSourceSha256) throw Error("SOURCE_CLOCK_INDEX_SOURCE_SHA_MISMATCH");
      await timeRemapToolIdentityV1(input.ffmpegPath, signal); await timeRemapToolIdentityV1(input.ffprobePath, signal);
      const projectVolume = await probeVolumeSpace(input.projectRoot); if (!projectVolume) throw Error("SOURCE_CLOCK_INDEX_PROJECT_VOLUME_UNKNOWN");
      await replayLongRenderJournalsV1({ registryRoot: join(root, ".journals"), retryMs: 1000 });
      const runId = randomUUID(), work = join(root, `.index-session-${runId}`);
      journal = await openLongRenderJournalV1({ workRoot: root, runId, registryRoot: join(root, ".journals") });
      await createOwnedDirectoryV1(work, runId); await journal.recordCreated(work, "run-work-dir");
      metadata = await open(join(work, "pts.bin"), "wx+"); await journal.recordCreated(join(work, "pts.bin"), "file");
      const s: State = { ...input, source, metadata, journal, maximumMetadataBytes, sourceSha256, sourceIdentity,
        ffmpegIdentity: canonicalJson(await timeRemapFingerprintV1(input.ffmpegPath)), ffprobeIdentity: canonicalJson(await timeRemapFingerprintV1(input.ffprobePath)),
        projectVolume: projectVolume.key, borrowed: false, closed: false,
        receipt: { sourceHashes: 1, sourceBytesHashed: Number(sourceIdentity.size), indexBuilds: 0, metadataBytes: 0, borrows: 0, closed: false } };
      const session: SourceClockIndexSessionV1 = { schema: "editkin.source-clock-index-session/v1", get receipt() { return structuredClone(s.receipt); },
        async close() {
          if (s.closed) return; if (s.borrowed) throw Error("SOURCE_CLOCK_INDEX_SESSION_IN_USE");
          s.closed = true; s.receipt.closed = true; await s.metadata.close(); await s.source.close();
          const cleanup = await s.journal.cleanup({ releaseMs: 1000 });
          if (cleanup.leftovers.length) throw Error(`SOURCE_CLOCK_INDEX_SESSION_CLEANUP_LEFTOVERS:${cleanup.leftovers.map(r => r.path).join("|")}`);
        } };
      sessions.set(session, s); return session;
    } catch (e) { await metadata?.close(); await source.close(); await journal?.cleanup({ releaseMs: 1000 }); throw e; }
  });
}
export async function borrowSourceClockIndexSessionV1(session: SourceClockIndexSessionV1, request: {
  sourcePath: string; sourceIdentity: FingerprintStat; expectedSourceSha256: string; ffmpegPath: string; ffprobePath: string; outputParent: string;
}) {
  const s = state(session);
  if (s.borrowed) throw Error("SOURCE_CLOCK_INDEX_SESSION_BUSY");
  if (request.sourcePath !== s.sourcePath || request.expectedSourceSha256 !== s.sourceSha256 || request.ffmpegPath !== s.ffmpegPath || request.ffprobePath !== s.ffprobePath
    || canonicalJson(fingerprint(request.sourceIdentity)) !== canonicalJson(s.sourceIdentity)) throw Error("SOURCE_CLOCK_INDEX_BORROW_BINDING_CHANGED");
  s.borrowed = true; let released = false, building = false;
  const verify = async () => {
    assertRenderActive(); s.signal?.throwIfAborted();
    if (released || s.closed) throw Error("SOURCE_CLOCK_INDEX_BORROW_ENDED");
    if (canonicalJson(await timeRemapFingerprintV1(s.sourcePath)) !== canonicalJson(s.sourceIdentity)
      || canonicalJson(fingerprint(await s.source.stat({ bigint: true }))) !== canonicalJson(s.sourceIdentity)
      || canonicalJson(await timeRemapFingerprintV1(s.ffmpegPath)) !== s.ffmpegIdentity
      || canonicalJson(await timeRemapFingerprintV1(s.ffprobePath)) !== s.ffprobeIdentity) throw Error("SOURCE_CLOCK_INDEX_SOURCE_OR_TOOL_CHANGED");
    if (process.env.TEMP !== s.helperTemporaryRoot || process.env.TMP !== s.helperTemporaryRoot) throw Error("SOURCE_CLOCK_INDEX_HELPER_ENV_CHANGED");
    await assertTimeRemapLocalPathV1(request.outputParent); await assertTimeRemapLocalPathV1(s.projectRoot);
    const volume = await probeVolumeSpace(request.outputParent), project = await probeVolumeSpace(s.projectRoot);
    if (!volume || !project || volume.key !== s.projectVolume || project.key !== s.projectVolume) throw Error("SOURCE_CLOCK_INDEX_OUTPUT_PROJECT_VOLUME_REQUIRED");
    await s.indexed?.index.assertIdentity();
  };
  try { await verify(); s.receipt.borrows++; }
  catch (e) { s.borrowed = false; throw e; }
  return { verify,
    async getIndex(profile: { timeBase: { numerator: number; denominator: number }; h264FourByteNals: boolean; timeoutMs: number }) {
      if (building) throw Error("SOURCE_CLOCK_INDEX_BUILD_BUSY"); building = true;
      try {
      await verify(); const key = canonicalJson({ timeBase: profile.timeBase, h264FourByteNals: profile.h264FourByteNals });
      if (s.profile && s.profile !== key) throw Error("SOURCE_CLOCK_INDEX_PROFILE_CHANGED");
      const reusedIndex = !!s.indexed;
      if (!s.indexed) {
        try {
          s.profile = key;
          s.indexed = await buildDecodedPtsIndexV1({ ...profile, ffprobePath: s.ffprobePath, sourcePath: s.sourcePath, source: s.source,
            sourceBytes: Number(s.sourceIdentity.size), metadata: s.metadata, maximumMetadataBytes: s.maximumMetadataBytes });
          s.receipt.indexBuilds++; s.receipt.metadataBytes = s.indexed.index.metadataBytes; s.receipt.metadataSha256 = s.indexed.index.metadataSha256;
        } catch (e) { s.failure = e; throw e; }
      }
      await verify(); return { ...s.indexed, packetReceipts: reusedIndex ? [] : s.indexed.packetReceipts, frameReceipts: reusedIndex ? [] : s.indexed.frameReceipts, reusedIndex };
      } finally { building = false; }
    },
    release() { if (building) throw Error("SOURCE_CLOCK_INDEX_BUILD_BUSY"); if (released) return; released = true; s.borrowed = false; },
  };
}
