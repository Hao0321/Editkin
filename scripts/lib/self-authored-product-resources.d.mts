export const EXTERNAL_AUTO_ROTO_RESOURCE_PATTERN: RegExp;
export function externalAutoRotoResourceFindings(paths: unknown[]): string[];
export function assertSelfAuthoredProductResources(paths: unknown[], label?: string): {
  status: "GREEN_SELF_AUTHORED_RESOURCES";
  paths: number;
  findings: string[];
};
export function inventoryProductResourceRoots(roots: string[], base?: string): Promise<string[]>;
export function assertSelfAuthoredProductResourceRoots(roots: string[], label?: string, base?: string): Promise<{
  status: "GREEN_SELF_AUTHORED_RESOURCES";
  paths: number;
  findings: string[];
  inventory: string[];
}>;
export function tauriResourcePaths(config: unknown): string[];
