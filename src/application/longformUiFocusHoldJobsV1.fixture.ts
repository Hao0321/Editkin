import { uiFocusHoldFixtureV1 } from "./longformUiFocusHoldV1.fixture";
import { uiFocusFileFixtureV1 } from "./longformUiFocusFileV1.fixture";
import { sealLongformUiFocusArtifactV1 } from "./longformUiFocusArtifactV1";
import { assembleLongformUiFocusHoldEvidenceV1 } from "./longformUiFocusHoldV1";
import { locateLongformUiFocusPixelsV1 } from "./longformUiFocusLocalPixelsV1";
import { colorDigest } from "./materialColorSamplingRuntime";
import type { LongformUiFocusHoldResultV1 } from "./longformUiFocusHoldJobsV1";
/** Synthetic protocol evidence only. Actual native/decode/OCR evidence is separate. */
export async function uiFocusHoldJobFixtureV1() {
  const hold = uiFocusHoldFixtureV1(), file = uiFocusFileFixtureV1("D:/owned", "D:/owned/source.mp4");
  const { artifactId: _id, ...fileBody } = file.artifact;
  const artifact = sealLongformUiFocusArtifactV1({ ...fileBody, draft: hold.draft });
  const request = { artifactId: artifact.artifactId, candidateId: hold.candidate.candidateId, duration: .8 };
  const localObservations = await locateLongformUiFocusPixelsV1(hold.draft, hold.request, hold.sequence, hold.pixels);
  const { receiptSha256: _receipt, ...evidence } = assembleLongformUiFocusHoldEvidenceV1(hold.draft, hold.request, hold.sequence, hold.pixels, hold.plan, localObservations);
  const body = { ...evidence, localObservations, provider: { nativeCoreSha256: "b".repeat(64), decodeRuntimeIdentitySha256: "a".repeat(64),
    implementationSha256: "c".repeat(64), engine: hold.plan.engine, cutHeuristic: "same-decode-ffmpeg-scdet-threshold10", temporalResampling: false }, limitations: ["Synthetic protocol only"] };
  const result: LongformUiFocusHoldResultV1 = { ...body, receiptSha256: colorDigest(body) };
  return { ...hold, file, artifact, request, result };
}
