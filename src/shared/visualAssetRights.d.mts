export interface OwnerVisualAsset {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly role: string;
  readonly domains: readonly string[];
  readonly mediaKind: 'video';
  readonly sourcePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly provenance: string;
  readonly originalProvenance: string;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly colorMetadata: { readonly primaries: string | null; readonly transfer: string | null; readonly matrix: string | null; readonly range: string | null };
}
export interface OwnerVisualAlias { readonly legacyId: string; readonly assetId: string; readonly bytes: number; readonly sha256: string }
export interface OwnerVisualGrant {
  readonly schema: 'editkin.owner-visual-grant/v1';
  readonly id: string;
  readonly license: string;
  readonly rightsOwner: string;
  readonly attestedAt: string;
  readonly attestation: string;
  readonly distributionScope: 'bundled-redistributable';
  readonly redistributable: true;
  readonly independentLegalReview: false;
  readonly permissions: { readonly bundledRedistribution: true; readonly personalAudiovisualUse: true; readonly commercialAudiovisualUse: true; readonly standaloneAssetResale: false; readonly ownershipTransfer: false };
  readonly document: { readonly path: string; readonly bytes: number; readonly sha256: string };
  readonly assetCount: number;
  readonly assetBytes: number;
  readonly assets: readonly OwnerVisualAsset[];
  readonly legacyAliases: readonly OwnerVisualAlias[];
}
export const OWNER_VISUAL_LICENSE: 'LicenseRef-Editkin-Owner-Visual-Bundle-Grant-1.0';
export const OWNER_VISUAL_GRANT_ID: 'owner-visual-attestation-2026-09-01';
export const OWNER_VISUAL_GRANT: OwnerVisualGrant;
export function validatePublicAssetRights(asset: unknown, manifestGrant?: unknown): { kind: 'standard' } | { kind: 'owner-visual'; grantId: string };
export function validatePublicGrant(manifest: unknown, options?: { documentSha256?: string }): { grant: OwnerVisualGrant; assets: readonly OwnerVisualAsset[]; legacyAliases: readonly OwnerVisualAlias[] } | undefined;
