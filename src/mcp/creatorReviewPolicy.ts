import { lstat, realpath } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { readBoundedFile } from "../shared/boundedFile";
import { normalizeReviewPolicy } from "../domain/reviewPolicy";
import { sha256Canonical } from "../application/autopilotInvocationIdentity";
import { workspaceRoot } from "./storage";
import type { AestheticReviewPolicy, EditProject } from "../domain/types";

export interface CreatorReviewPolicyIdentity { policy: AestheticReviewPolicy; policySha256: string }
function identity(input?: unknown): CreatorReviewPolicyIdentity {
  const policy = normalizeReviewPolicy(input);
  return { policy, policySha256: sha256Canonical(policy) };
}

async function directoryAncestry(root: string) {
  const paths: string[] = [];
  for (let current = resolve(root); ; current = dirname(current)) {
    paths.unshift(current);
    if (dirname(current) === current) break;
  }
  const identities = [];
  for (const path of paths) {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Creator policy workspace ancestry must use real directories without links or junctions");
    identities.push({ path, dev: entry.dev, ino: entry.ino });
  }
  return identities;
}

// The authority is the actual workspace configuration, never recipe text or plan input.
export async function readCreatorReviewPolicy(root = workspaceRoot()): Promise<CreatorReviewPolicyIdentity> {
  const ancestry = await directoryAncestry(root);
  const canonicalRoot = await realpath(root);
  const directory = resolve(canonicalRoot, ".autopilot");
  let before;
  try { before = await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (sha256Canonical(await directoryAncestry(root)) !== sha256Canonical(ancestry)) throw new Error("Creator policy workspace ancestry changed during read");
    return identity();
  }
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Creator policy directory must be a real workspace directory");
  const canonicalDirectory = await realpath(directory);
  if (relative(canonicalRoot, canonicalDirectory).toLowerCase() !== ".autopilot") throw new Error("Creator policy directory escaped its authority");
  let content: Buffer | undefined;
  try { content = await readBoundedFile(resolve(directory, "creator-review-policy.json"), 8192); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const after = await lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || await realpath(directory) !== canonicalDirectory) {
    throw new Error("Creator policy directory changed during read");
  }
  if (sha256Canonical(await directoryAncestry(root)) !== sha256Canonical(ancestry)) throw new Error("Creator policy workspace ancestry changed during read");
  return content === undefined ? identity() : identity(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content)));
}

export async function assertCreatorReviewPolicyCurrent(expected: CreatorReviewPolicyIdentity, root = workspaceRoot()) {
  const current = await readCreatorReviewPolicy(root);
  if (current.policySha256 !== expected.policySha256) throw new Error("Creator review authorization changed; read the current design and audit again");
}

export function assertProjectReviewPolicy(project: EditProject, expected: CreatorReviewPolicyIdentity) {
  const system = project.aestheticSystem;
  if (!system || sha256Canonical(normalizeReviewPolicy(system.reviewPolicy)) !== expected.policySha256 ||
      system.scoreContract.humanReviewRequired !== (expected.policy.mode === "human")) {
    throw new Error("Applied project aesthetic review policy differs from creator authority");
  }
}
