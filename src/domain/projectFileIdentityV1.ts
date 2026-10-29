/** Identity of actual project-file bytes, owned by the canonical file writer/reader. */
export interface ProjectFileIdentityV1 {
  schema: "editkin.project-file-identity/v1";
  projectId: string;
  revision: number;
  updatedAt: string;
  projectSha256: string;
  bytes: number;
}

export function isProjectFileIdentityV1(value: unknown): value is ProjectFileIdentityV1 {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProjectFileIdentityV1>;
  return item.schema === "editkin.project-file-identity/v1"
    && typeof item.projectId === "string" && item.projectId.length > 0
    && Number.isSafeInteger(item.revision) && item.revision! >= 0
    && typeof item.updatedAt === "string" && item.updatedAt.length > 0
    && typeof item.projectSha256 === "string" && /^[a-f0-9]{64}$/.test(item.projectSha256)
    && Number.isSafeInteger(item.bytes) && item.bytes! > 0;
}

/** No graph serialization, metadata-only fallback, hashing or I/O lives in the watch consumer. */
export function sameProjectFileIdentityV1(left: unknown, right: unknown): boolean {
  return isProjectFileIdentityV1(left) && isProjectFileIdentityV1(right)
    && left.projectSha256 === right.projectSha256 && left.bytes === right.bytes
    && left.projectId === right.projectId && left.revision === right.revision && left.updatedAt === right.updatedAt;
}

/** A stateless bridge decision; the existing watcher remains the sole owner of observer/dismissal state. */
export function projectFileWatchDecisionV1(observed: unknown, acknowledged: unknown, dismissed?: unknown): "self" | "dismissed" | "changed" | "needs_identity" {
  if (!isProjectFileIdentityV1(observed)) return "needs_identity";
  if (sameProjectFileIdentityV1(observed, acknowledged)) return "self";
  if (sameProjectFileIdentityV1(observed, dismissed)) return "dismissed";
  return "changed";
}
