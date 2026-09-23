export interface BuildFileIdentity { path: string; bytes: number; sha256: string }
export interface AggregateBuildIdentity { files: number; bytes: number; sha256: string }
export interface ProductReleaseScope {
  id: "editkin.formal-product-build-scope/v1";
  productMode: "native-only-auto-roto";
  inputBoundary: string;
  researchBoundary: "repository-retained-artifact-excluded";
  policySha256: string;
}
export const PRODUCT_RELEASE_SCOPE: Readonly<ProductReleaseScope>;
export const PRODUCT_REQUIRED_INPUT_PATHS: readonly string[];
export const PRODUCT_REQUIRED_OUTPUT_PATHS: readonly string[];
export function productInputExclusionReason(path: string): string | undefined;
export function aggregateBuildFiles(files: BuildFileIdentity[]): AggregateBuildIdentity;
export function productReleaseManifestFindings(manifest: unknown): Array<{ code: string; [key: string]: unknown }>;
export function computeBuildInputIdentity(root: string): Promise<AggregateBuildIdentity>;
export function computeBuildOutputIdentity(root: string): Promise<AggregateBuildIdentity>;
export function computeBuildReceipt(root: string): Promise<{
  scope: ProductReleaseScope;
  inputs: BuildFileIdentity[];
  outputs: BuildFileIdentity[];
  inputIdentity: AggregateBuildIdentity;
  outputIdentity: AggregateBuildIdentity;
}>;
export function buildManifestIdentityMatches(actual: unknown, expected: unknown): boolean;
