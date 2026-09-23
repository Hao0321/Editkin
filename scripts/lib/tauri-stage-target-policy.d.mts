export interface TauriStageTarget {
  appRoot: string;
  targetRoot: string;
  envelopeRoot: string;
  candidateTarget: boolean;
}

export function resolveTauriStageTarget(appRootInput: string, targetInput?: string): TauriStageTarget;
export function assertTauriStageReplacementTarget(envelopeRootInput: string, targetInput: string): void;
