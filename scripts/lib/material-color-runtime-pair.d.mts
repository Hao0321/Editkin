import type { Buffer } from "node:buffer";

export const MATERIAL_COLOR_SIDECAR: "mcp.mjs.material-color-identity.json";

export interface MaterialColorRuntimePairIdentity {
  bundleSha256: string;
  sidecarSha256: string;
}

export function readMaterialColorBoundedFile(
  path: string,
  maximumBytes: number,
  options?: { allowEmpty?: boolean },
): Promise<Buffer>;
export function readMaterialColorImplementationRegistry(root?: string): Promise<readonly string[]>;
export function verifyMaterialColorRuntimePair(bundlePath: string): Promise<MaterialColorRuntimePairIdentity>;
export function stageMaterialColorRuntimePair(sourceBundle: string, targetBundle: string): Promise<MaterialColorRuntimePairIdentity>;
