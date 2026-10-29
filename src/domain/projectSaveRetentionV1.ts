import { isProjectFileIdentityV1, type ProjectFileIdentityV1 } from "./projectFileIdentityV1";
/** Informational unsaved-file receipt, never authority for an automatic path open. */
export interface RetainedProjectV1 { schema: "editkin.retained-project/v1"; path: string; fileIdentity: ProjectFileIdentityV1; }
export function isRetainedProjectV1(value: unknown): value is RetainedProjectV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<RetainedProjectV1>;
  return item.schema === "editkin.retained-project/v1" && typeof item.path === "string" && item.path.length > 0
    && item.path.length <= 32768 && item.path.toLowerCase().endsWith(".json") && isProjectFileIdentityV1(item.fileIdentity);
}
