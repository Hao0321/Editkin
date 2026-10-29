import * as z from "zod/v4";
const kinds = ["whoosh", "pop", "ding", "riser", "impact", "tick", "cash", "glitch"] as const;

const assetId = z.string().regex(/^sfx:editkin-procedural-v1-(whoosh|pop|ding|riser|impact|tick|cash|glitch)-0[1-5]$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const proceduralSfxLibraryRequestV1Schema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list"), offset: z.number().int().min(0).max(40).default(0),
    limit: z.number().int().min(1).max(20).default(20), kind: z.enum(kinds).optional() }),
  z.strictObject({ operation: z.literal("resolve"), id: assetId, sha256: digest }),
]);
export interface ProceduralSfxLibraryEntryV1 {
  id: string; name: string; kind: typeof kinds[number]; sha256: string; bytes: number;
  durationSamples: number; durationSeconds: number; sourceSha256: string;
  source: "local-original-mathematical-synthesis"; rightsBasis: "owner-authorized-local-generation";
  distributionScope: "private-owner-only"; certification: "AUDIO_PENDING_HAO_CLAUDE";
  defaultEnabled: false; redistributable: false; contentVerified: boolean;
}
export interface ResolvedProceduralSfxV1 {
  entry: ProceduralSfxLibraryEntryV1; absolutePath: string; pcm: Int16Array;
}
export const proceduralSfxPlacementRequestV1Schema = z.strictObject({
  trackId: z.string().trim().min(1).max(160), idPrefix: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  newTrack: z.strictObject({ name: z.string().trim().min(1).max(120) }).optional(),
  hits: z.array(z.strictObject({ id: assetId, sha256: digest, frame: z.number().int().min(0).max(20_736_000),
    gain: z.number().finite().positive().max(1) })).min(1).max(32),
});
