export interface DesktopStageTarget {
  appRoot: string;
  targetRoot: string;
  envelopeRoot: string;
  candidateTarget: boolean;
}

export function resolveDesktopStageTarget(appRootInput: string, targetInput?: string): DesktopStageTarget;
export interface PairedDesktopStageTarget extends DesktopStageTarget {
  candidateId: string;
  relativeRuntime: string;
}
export function resolveDesktopCandidateForTauriArtifact(appRootInput: string, artifactRootInput: string, runtimeInput?: string): PairedDesktopStageTarget;
export function assertDesktopStageReplacementTarget(envelopeRootInput: string, targetInput: string): void;
export function assertIsolatedDesktopCandidateAvailable(stageTarget: DesktopStageTarget): Promise<void>;
export function createIsolatedDesktopCandidateEnvelope(stageTarget: DesktopStageTarget): Promise<void>;
