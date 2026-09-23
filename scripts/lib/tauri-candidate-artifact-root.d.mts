export interface TauriCandidateArtifactRoot {
  appRoot: string;
  candidateParent: string;
  candidateId: string;
  cargoTargetDir: string;
  artifactRoot: string;
  canonicalReleaseRoot: string;
  relativeArtifactRoot: string;
}

export interface TauriArtifactSnapshotEntry {
  exists: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  isReparsePoint: boolean;
  realPath?: string;
}

export interface TauriCandidateArtifactTarget {
  schema: "editkin.tauri-candidate-artifact-target/v1";
  root: string;
  candidateId: string;
  executable: { path: string; bytes: number; sha256: string };
  installer: { path: string; bytes: number; sha256: string };
}

export function resolveTauriCandidateArtifactRoot(appRootInput: string, artifactRootInput: string): TauriCandidateArtifactRoot;
export function validateTauriCandidateArtifactSnapshot(layout: TauriCandidateArtifactRoot, snapshot: Map<string, TauriArtifactSnapshotEntry>, mode: "build" | "prepared" | "inspect"): TauriCandidateArtifactRoot;
export function assertTauriCandidateArtifactRoot(layout: TauriCandidateArtifactRoot, mode: "build" | "prepared" | "inspect"): Promise<TauriCandidateArtifactRoot>;
export function prepareTauriCandidateCargoTarget(layout: TauriCandidateArtifactRoot): Promise<TauriCandidateArtifactRoot>;
export function inspectWindowsTauriCandidatePrimaryArtifacts(layout: TauriCandidateArtifactRoot, version: string): Promise<TauriCandidateArtifactTarget>;
export function assertTauriArtifactTargetBinding(layout: TauriCandidateArtifactRoot, expected: unknown, observed: TauriCandidateArtifactTarget): true;
