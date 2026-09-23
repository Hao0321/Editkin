export const EDITKIN_RELEASE_RUNTIME_FILES: readonly string[];
export const EDITKIN_DESKTOP_RELEASE_RUNTIME_FILES: readonly string[];

export function assertExactReleaseRuntimeFileSet(
  actualNames: readonly string[],
  expectedNames: readonly string[],
  label?: string,
): string[];
