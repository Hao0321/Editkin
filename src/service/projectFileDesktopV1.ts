import { retainedProjectForSaveErrorV1, requireProjectFileIdentityV1, readPrimaryProjectFileWithIdentityV1, readProjectFile, writeProjectFileAtomic, writeProjectFileAtomicWithIdentityV1 } from "../application/projectFiles";
import type { EditProject } from "../domain/types";

/** Adapter only. No serialization, hashing or second file-identity owner here. */
export async function readDesktopProjectV1(path: string, captureFileIdentity: boolean) {
  if (!captureFileIdentity) return readProjectFile(path);
  try { return await readPrimaryProjectFileWithIdentityV1(path); }
  catch {
    // Preserve the legacy recovery view, but never claim .previous bytes are
    // the acknowledged current primary watched at `path`.
    return { project: await readProjectFile(path), fileIdentity: null, recoveredPrevious: true };
  }
}

export async function writeDesktopProjectV1(path: string, project: EditProject, expectedRevision: number | null, captureFileIdentity: boolean, expectedFileIdentity?: unknown) {
  const hasExpected = expectedFileIdentity !== undefined && expectedFileIdentity !== null;
  const required = hasExpected || (captureFileIdentity && expectedRevision !== null)
    ? requireProjectFileIdentityV1(expectedFileIdentity) : undefined;
  const options = required ? { expectedFileIdentity: required } : {};
  return captureFileIdentity ? writeProjectFileAtomicWithIdentityV1(path, project, expectedRevision, options)
    : writeProjectFileAtomic(path, project, expectedRevision, options);
}

export async function inspectDesktopProjectV1(path: string) {
  try {
    const { project, fileIdentity } = await readPrimaryProjectFileWithIdentityV1(path);
    return { exists: true, readable: true, bytes: fileIdentity.bytes, revision: project.revision,
      projectId: project.id, updatedAt: project.updatedAt, fileIdentity };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { exists: false }
      : { exists: true, readable: false };
  }
}

/** Opt-in failure transport; never trusts caller paths or fields on an arbitrary Error. */
export async function writeDesktopProjectRecoverableV1(path: string, project: EditProject, expectedRevision: number | null, captureFileIdentity: boolean, expectedFileIdentity?: unknown) {
  try { return await writeDesktopProjectV1(path, project, expectedRevision, captureFileIdentity, expectedFileIdentity); }
  catch (error) {
    const retainedProject = retainedProjectForSaveErrorV1(error);
    if (!retainedProject) throw error;
    return { saveFailed: true as const, message: error instanceof Error ? error.message : String(error), retainedProject };
  }
}
