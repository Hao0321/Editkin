import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_ARTIFACT_PATHS,
  EXPECTED_EVALUATOR_SOURCE_PATHS,
  EXPECTED_REGISTRY_SOURCE_PATHS,
  EXPECTED_RENDERER_SOURCE_PATHS,
  EXPECTED_RUNTIME_PATHS,
  EXPECTED_SOURCE_PATH,
  REQUIRED_LOOK_IDS,
  REQUIRED_TRANSITION_IDS,
  decodedSampleSignature,
  evaluateCinematicDecodedMatrix,
  hashCanonical,
  type ArtifactIdentity,
  type CinematicDecodedMatrixInput,
  type DecodedMatrixObservation,
  type DecodedMatrixSample,
  type FileIdentity,
  type MatrixKind,
  type MatrixRegistryEntry,
} from "./lib/cinematic-decoded-matrix-gate";
import {
  collectCinematicDecodedMatrixEvidence,
  defaultEvidenceRoot,
  fileIdentity,
  resetEvidenceRoot,
} from "./lib/cinematic-decoded-matrix-runtime";

interface CinematicDecodedMatrixSelfTestFixture {
  input: CinematicDecodedMatrixInput;
  authorityRoot: string;
  cleanupRoot: string;
}

function writeFixtureIdentity(root: string, path: string, bytes: Buffer): FileIdentity {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
  return {
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function fixtureBytes(seed: string): Buffer {
  return Buffer.from(`editkin-cinematic-decoded-matrix-self-test:${seed}\n`, "utf8");
}

function fakeArtifact(identity: FileIdentity): ArtifactIdentity {
  return {
    ...identity,
    codecName: "h264",
    width: 320,
    height: 180,
    fps: 60,
    frameCount: 120,
    duration: 2,
    hasAudio: true,
  };
}

function fakeRegistry(kind: MatrixKind, ids: readonly string[]): MatrixRegistryEntry[] {
  return ids.map((id, index) => {
    const contract = { primitive: kind, index, strength: index + 1 };
    return { id, renderer: `${kind}-fixture`, contract, contractFingerprint: hashCanonical(contract) };
  });
}

function fakeSamples(kind: MatrixKind, seed: string): DecodedMatrixSample[] {
  const phases = kind === "look" ? ["steady", "steady", "steady"] as const : ["in", "in", "in", "out", "out", "out"] as const;
  return phases.map((phase, index) => ({
    phase,
    localFrame: index + 1,
    baselineSha256: hashCanonical(`baseline:${phase}:${index}`),
    candidateSha256: hashCanonical(`candidate:${seed}:${phase}:${index}`),
    meanAbsoluteError: 2 + index / 10,
    changedPixelRatio: 0.5,
    deltaFeatures: Array.from({ length: 48 }, (_, feature) => Number((Number(seed) + index + feature / 100).toFixed(4))),
  }));
}

function fakeObservation(
  kind: MatrixKind,
  entry: MatrixRegistryEntry,
  index: number,
  source: FileIdentity,
  baseline: ArtifactIdentity,
  candidate: ArtifactIdentity,
): DecodedMatrixObservation {
  const compiler = { renderer: entry.renderer, index, active: true };
  const samples = fakeSamples(kind, String(kind === "look" ? index + 1 : index + 101));
  return {
    kind,
    id: entry.id,
    registryFingerprint: entry.contractFingerprint,
    expectedCompiler: compiler,
    actualCompiler: structuredClone(compiler),
    expectedCompilerFingerprint: hashCanonical(compiler),
    actualCompilerFingerprint: hashCanonical(compiler),
    sourcePath: source.path,
    sourceBytes: source.bytes,
    sourceSha256: source.sha256,
    baselineArtifact: { path: baseline.path, sha256: baseline.sha256 },
    candidateArtifact: { path: candidate.path, sha256: candidate.sha256 },
    samples,
    decodedSignature: decodedSampleSignature(samples),
  };
}

export function buildCinematicDecodedMatrixSelfTestFixture(): CinematicDecodedMatrixSelfTestFixture {
  const cleanupRoot = mkdtempSync(resolve(tmpdir(), "editkin-cinematic-decoded-matrix-"));
  const authorityRoot = resolve(cleanupRoot, "workspace/apps/hao-editor");
  const source = writeFixtureIdentity(authorityRoot, EXPECTED_SOURCE_PATH, fixtureBytes("source"));
  const registrySources = EXPECTED_REGISTRY_SOURCE_PATHS.map((path) => writeFixtureIdentity(authorityRoot, path, fixtureBytes(`registry:${path}`)));
  const rendererSources = EXPECTED_RENDERER_SOURCE_PATHS.map((path) => writeFixtureIdentity(authorityRoot, path, fixtureBytes(`renderer:${path}`)));
  const evaluatorSources = EXPECTED_EVALUATOR_SOURCE_PATHS.map((path) => writeFixtureIdentity(authorityRoot, path, fixtureBytes(`evaluator:${path}`)));
  const runtimes = EXPECTED_RUNTIME_PATHS.map((path) => writeFixtureIdentity(authorityRoot, path, fixtureBytes(`runtime:${path}`)));
  const firstBaselinePath = ".rd/benchmarks/editkin-cinematic-decoded-matrix/look-shard-01/baseline.mp4";
  const repeatPath = ".rd/benchmarks/editkin-cinematic-decoded-matrix/look-shard-01/baseline-repeat.mp4";
  const firstBaselineBytes = fixtureBytes(`artifact:${firstBaselinePath}`);
  const artifacts = EXPECTED_ARTIFACT_PATHS.map((path) => fakeArtifact(writeFixtureIdentity(
    authorityRoot,
    path,
    path === repeatPath ? firstBaselineBytes : fixtureBytes(`artifact:${path}`),
  )));
  const artifactByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const looks = fakeRegistry("look", REQUIRED_LOOK_IDS);
  const transitions = fakeRegistry("transition", REQUIRED_TRANSITION_IDS);
  const artifactsFor = (kind: MatrixKind, index: number): [ArtifactIdentity, ArtifactIdentity] => {
    const shard = `${kind}-shard-${String(Math.floor(index / 8) + 1).padStart(2, "0")}`;
    const baseline = artifactByPath.get(`.rd/benchmarks/editkin-cinematic-decoded-matrix/${shard}/baseline.mp4`);
    const candidate = artifactByPath.get(`.rd/benchmarks/editkin-cinematic-decoded-matrix/${shard}/candidate.mp4`);
    if (!baseline || !candidate) throw new Error(`self-test artifact fixture missing for ${kind}:${index}`);
    return [baseline, candidate];
  };
  const observations = [
    ...looks.map((entry, index) => fakeObservation("look", entry, index, source, ...artifactsFor("look", index))),
    ...transitions.map((entry, index) => fakeObservation("transition", entry, index, source, ...artifactsFor("transition", index))),
  ];
  const baseline = artifactByPath.get(firstBaselinePath)!;
  const repeat = artifactByPath.get(repeatPath)!;
  return {
    authorityRoot,
    cleanupRoot,
    input: {
      schema: "editkin.cinematic-decoded-matrix-evidence/v1",
      source,
      registrySources,
      rendererSources,
      evaluatorSources,
      runtimes,
      artifacts,
      registry: { looks, transitions },
      observations,
      determinism: {
        baselinePath: baseline.path,
        repeatPath: repeat.path,
        baselineSha256: baseline.sha256,
        repeatSha256: repeat.sha256,
        decodedSignaturesEqual: true,
      },
    },
  };
}

function mutated(input: CinematicDecodedMatrixInput, mutation: (candidate: CinematicDecodedMatrixInput) => void): CinematicDecodedMatrixInput {
  const candidate = structuredClone(input);
  mutation(candidate);
  return candidate;
}

function requireRejected(
  input: CinematicDecodedMatrixInput,
  name: string,
  expectedFailure: string,
  mutation: (candidate: CinematicDecodedMatrixInput) => void,
  authorityRoot: string,
): string {
  const result = evaluateCinematicDecodedMatrix(mutated(input, mutation), { root: authorityRoot });
  if (result.status !== "BLOCK" || !result.failures.some((failure) => failure.startsWith(expectedFailure))) {
    throw new Error(`evaluator accepted or misclassified ${name}: ${JSON.stringify(result)}`);
  }
  return name;
}

export function runCinematicDecodedMatrixSelfTest() {
  const fixture = buildCinematicDecodedMatrixSelfTestFixture();
  const reject = (
    name: string,
    expectedFailure: string,
    mutation: (candidate: CinematicDecodedMatrixInput) => void,
  ) => requireRejected(fixture.input, name, expectedFailure, mutation, fixture.authorityRoot);
  try {
    const positive = evaluateCinematicDecodedMatrix(fixture.input, { root: fixture.authorityRoot });
    if (positive.status !== "GREEN") throw new Error(`positive fixture failed: ${positive.failures.join(" | ")}`);
    const rejectedNegativeControls = [
    reject("wrong-schema", "schema:exact", (candidate) => {
      (candidate as { schema: string }).schema = "editkin.cinematic-decoded-matrix-evidence/v0";
    }),
    reject("fabricated-source-with-rewritten-observations", "identity:source:closed-world", (candidate) => {
      const source = { path: "public/nonexistent-fabricated-source.mp4", bytes: 777, sha256: hashCanonical("fabricated-source") };
      candidate.source = source;
      candidate.observations.forEach((observation) => {
        observation.sourcePath = source.path;
        observation.sourceBytes = source.bytes;
        observation.sourceSha256 = source.sha256;
      });
    }),
    reject("rewritten-live-source-identity", "identity:source:bytes", (candidate) => {
      candidate.source.bytes += 1;
      candidate.source.sha256 = hashCanonical("rewritten-live-source");
      candidate.observations.forEach((observation) => {
        observation.sourceBytes = candidate.source.bytes;
        observation.sourceSha256 = candidate.source.sha256;
      });
    }),
    reject("unexpected-24th-artifact", "artifact:closed-world", (candidate) => {
      candidate.artifacts.push({ ...candidate.artifacts[0], path: ".rd/benchmarks/editkin-cinematic-decoded-matrix/unexpected-24.mp4" });
    }),
    reject("missing-artifact", "artifact:closed-world", (candidate) => {
      candidate.artifacts.pop();
    }),
    reject("unexpected-runtime", "identity:runtime:closed-world", (candidate) => {
      candidate.runtimes.push({ path: "vendor/ffmpeg/win32-x64/unexpected-runtime.exe", bytes: 12, sha256: hashCanonical("unexpected-runtime") });
    }),
    reject("fake-evaluator-source", "identity:evaluator-source:closed-world", (candidate) => {
      candidate.evaluatorSources[0] = { path: "scripts/fake-evaluator.ts", bytes: 12, sha256: hashCanonical("fake-evaluator") };
    }),
    reject("missing-look-registry", "registry:look:closed-world", (candidate) => {
      candidate.registry.looks.pop();
    }),
    reject("missing-transition-observation", "observation:transition:closed-world", (candidate) => {
      candidate.observations = candidate.observations.filter((item) => item.id !== REQUIRED_TRANSITION_IDS[0]);
    }),
    reject("silent-registry-alias", "registry:transition:silent-alias", (candidate) => {
      candidate.registry.transitions[1].contract = structuredClone(candidate.registry.transitions[0].contract);
      candidate.registry.transitions[1].contractFingerprint = candidate.registry.transitions[0].contractFingerprint;
    }),
    reject("registry-fingerprint-drift", "registry:look:fingerprint", (candidate) => {
      candidate.registry.looks[0].contractFingerprint = hashCanonical("wrong-registry-fingerprint");
    }),
    reject("compiler-fallback", "compiler:mismatch:transition", (candidate) => {
      const observation = candidate.observations.find((item) => item.kind === "transition")!;
      observation.actualCompiler = { ...observation.actualCompiler, renderer: "fallback-renderer" };
      observation.actualCompilerFingerprint = hashCanonical(observation.actualCompiler);
    }),
    reject("source-drift", "observation:source-drift:look", (candidate) => {
      candidate.observations.find((item) => item.kind === "look")!.sourceSha256 = hashCanonical("other-source");
    }),
    reject("source-path-drift", "observation:source-drift:look", (candidate) => {
      candidate.observations.find((item) => item.kind === "look")!.sourcePath = "public/other-source.mp4";
    }),
    reject("artifact-binding-drift", "observation:baseline-artifact:look", (candidate) => {
      candidate.observations.find((item) => item.kind === "look")!.baselineArtifact.sha256 = hashCanonical("other-artifact");
    }),
    reject("artifact-path-drift", "observation:baseline-path:look", (candidate) => {
      const observation = candidate.observations.find((item) => item.kind === "look")!;
      const other = candidate.artifacts.find((artifact) => artifact.path.includes("look-shard-02/baseline.mp4"))!;
      observation.baselineArtifact = { path: other.path, sha256: other.sha256 };
    }),
    reject("decoded-stream-contract", "artifact:decoded-contract", (candidate) => {
      candidate.artifacts[0].width = 1920;
    }),
    reject("decoded-no-op", "sample:no-op:look", (candidate) => {
      const observation = candidate.observations.find((item) => item.kind === "look")!;
      observation.samples[0].candidateSha256 = observation.samples[0].baselineSha256;
      observation.samples[0].meanAbsoluteError = 0;
      observation.samples[0].changedPixelRatio = 0;
      observation.decodedSignature = decodedSampleSignature(observation.samples);
    }),
    reject("missing-exit-coverage", "sample:coverage:transition", (candidate) => {
      const observation = candidate.observations.find((item) => item.kind === "transition")!;
      observation.samples = observation.samples.filter((sample) => sample.phase !== "out");
      observation.decodedSignature = decodedSampleSignature(observation.samples);
    }),
    reject("decoded-signature-drift", "sample:signature:look", (candidate) => {
      candidate.observations.find((item) => item.kind === "look")!.decodedSignature = hashCanonical("wrong-decoded-signature");
    }),
    reject("silent-decoded-identity", "decoded:look:silent-identity", (candidate) => {
      const looks = candidate.observations.filter((item) => item.kind === "look");
      looks[1].samples = structuredClone(looks[0].samples);
      looks[1].decodedSignature = decodedSampleSignature(looks[1].samples);
    }),
    reject("nondeterministic-baseline", "determinism:baseline-repeat", (candidate) => {
      candidate.determinism.repeatSha256 = hashCanonical("nondeterministic-repeat");
    }),
    reject("missing-source-bytes", "identity:source", (candidate) => {
      candidate.source.bytes = 0;
    }),
    ];
    return {
      schema: "editkin.cinematic-decoded-matrix-self-test/v1",
      status: "GREEN" as const,
      rejectedNegativeControls,
    };
  } finally {
    rmSync(fixture.cleanupRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify(runCinematicDecodedMatrixSelfTest())}\n`);
    return;
  }
  await resetEvidenceRoot();
  const input = await collectCinematicDecodedMatrixEvidence();
  const evidencePath = resolve(defaultEvidenceRoot, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  const evidence = await fileIdentity(evidencePath);
  const result = evaluateCinematicDecodedMatrix(input);
  const reportPath = resolve(defaultEvidenceRoot, "report.json");
  const report = { ...result, evidence };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const reportIdentity = await fileIdentity(reportPath);
  process.stdout.write(`${JSON.stringify({ ...result, evidence, report: reportIdentity })}\n`);
  if (result.status !== "GREEN") process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (fileURLToPath(import.meta.url).toLowerCase() === invokedPath) {
  main().catch(async (error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    try {
      await writeFile(resolve(defaultEvidenceRoot, "runner-error.txt"), `${message}\n`, "utf8");
    } catch {
      // The console remains the only authority when the evidence root itself cannot be created.
    }
    console.error(message);
    process.exitCode = 1;
  });
}

export async function readRetainedCinematicDecodedMatrixEvidence(): Promise<CinematicDecodedMatrixInput> {
  return JSON.parse(await readFile(resolve(defaultEvidenceRoot, "evidence.json"), "utf8")) as CinematicDecodedMatrixInput;
}
