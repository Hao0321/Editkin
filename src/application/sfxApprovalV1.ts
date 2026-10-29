import * as z from "zod/v4";
import { canonicalJson } from "../shared/canonicalJson";
import { PROCEDURAL_SFX_CATALOGUE_V1 as catalogue, PROCEDURAL_SFX_KINDS_V1 } from "./proceduralSfxCatalogueV1";

// Forty bounded notes/reviewer names, including six-byte JSON escapes for each UTF-16 unit, fit without truncation.
export const SFX_LISTENING_DOCUMENT_MAX_BYTES_V1 = 256 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/), text = (maximum: number) => z.string().trim().min(1).max(maximum).regex(/^[^\u0000-\u001f]*$/);
const pinsSchema = z.array(z.strictObject({ path: z.enum(["src/application/proceduralSfxCatalogueV1.ts", "src/application/proceduralSfxSynthV1.ts"]),
  bytes: z.number().int().positive().max(1_000_000), sha256: digest })).length(2).refine(a => new Set(a.map(p => p.path)).size === 2);
const entrySchema = z.strictObject({ id: text(128), name: text(200), kind: z.enum(PROCEDURAL_SFX_KINDS_V1), sha256: digest,
  bytes: z.number().int().positive().max(96_044), durationSamples: z.number().int().positive().max(48_000), durationSeconds: z.number().finite().positive().max(1),
  sourceSha256: digest, source: z.literal("local-original-mathematical-synthesis"), rightsBasis: z.literal("owner-authorized-local-generation"),
  distributionScope: z.literal("private-owner-only"), certification: z.literal("AUDIO_PENDING_HAO_CLAUDE"), defaultEnabled: z.literal(false),
  redistributable: z.literal(false), contentVerified: z.literal(true) });
export const sfxListeningPreferenceSchemaV1 = z.strictObject({ id: text(128), preference: z.enum(["preferred", "needs_changes", "reject", "unreviewed"]),
  reviewer: text(80), recordedAt: z.iso.datetime().max(32), note: z.string().max(500).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/).default("") });
const decisionSchema = sfxListeningPreferenceSchemaV1.extend({ wavSha256: digest, sourceSha256: digest });
const documentSchema = z.strictObject({ schema: z.literal("editkin.sfx-listening-preferences/v1"), reviewSha256: digest,
  decisions: z.array(decisionSchema).max(40), assertion: z.literal("caller_declared_listening_preferences_not_authenticated_quality_approval"),
  certification: z.literal("AUDIO_PENDING_HAO_CLAUDE"), defaultEnabled: z.literal(false), redistributable: z.literal(false) });
export type SfxListeningPreferencesV1 = z.infer<typeof documentSchema>;
export type SfxApprovalReviewV1 = Awaited<ReturnType<typeof createSfxApprovalReviewV1>>;
const books = new WeakMap<SfxApprovalReviewV1, string>();
function live(book: SfxApprovalReviewV1) {
  if (!books.has(book) || canonicalJson(book) !== books.get(book)) throw Error("SFX_LIVE_UNCHANGED_REVIEW_REQUIRED");
}
/** Host supplies entries from its verified original library; no reviewer action is inferred here. */
export async function createSfxApprovalReviewV1(value: unknown, generatorPins: unknown) {
  const parsed = z.array(entrySchema).length(40).parse(value), pins = pinsSchema.parse(generatorPins).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(parsed.map(e => e.id)).size !== 40) throw Error("SFX_REVIEW_CATALOGUE_CLOSURE_REQUIRED");
  const entries = catalogue.map(recipe => {
    const entry = parsed.find(e => e.id === recipe.id);
    if (!entry || entry.kind !== recipe.kind || entry.durationSamples !== recipe.durationSamples || entry.bytes !== 44 + recipe.durationSamples * 2
      || entry.durationSeconds !== recipe.durationSamples / 48_000) throw Error("SFX_REVIEW_CATALOGUE_CLOSURE_REQUIRED");
    return Object.freeze(entry);
  });
  for (const pin of pins) Object.freeze(pin);
  const binding = { schema: "editkin.sfx-listening-review/v1" as const, entries: Object.freeze(entries), generatorPins: Object.freeze(pins) };
  const bytes = new TextEncoder().encode(canonicalJson(binding));
  const reviewSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer)), b => b.toString(16).padStart(2, "0")).join("");
  const book = Object.freeze({ ...binding, reviewSha256, certification: "AUDIO_PENDING_HAO_CLAUDE" as const, defaultEnabled: false as const,
    redistributable: false as const, qualityApprovalGranted: false as const });
  books.set(book, canonicalJson(book)); return book;
}
export function createEmptySfxListeningPreferencesV1(book: SfxApprovalReviewV1): SfxListeningPreferencesV1 {
  live(book); return { schema: "editkin.sfx-listening-preferences/v1", reviewSha256: book.reviewSha256, decisions: [],
    assertion: "caller_declared_listening_preferences_not_authenticated_quality_approval", certification: "AUDIO_PENDING_HAO_CLAUDE", defaultEnabled: false, redistributable: false };
}
/** Reopening is bound to this freshly verified book. A JSON name is not an authenticated human signature. */
export function restoreSfxListeningPreferencesV1(book: SfxApprovalReviewV1, value: unknown): SfxListeningPreferencesV1 {
  live(book); const document = documentSchema.parse(value);
  if (document.reviewSha256 !== book.reviewSha256 || new Set(document.decisions.map(d => d.id)).size !== document.decisions.length) throw Error("SFX_PREFERENCES_REVIEW_IDENTITY_MISMATCH");
  for (const decision of document.decisions) {
    const entry = book.entries.find(e => e.id === decision.id);
    if (!entry || entry.sha256 !== decision.wavSha256 || entry.sourceSha256 !== decision.sourceSha256) throw Error("SFX_PREFERENCES_SOURCE_MISMATCH");
  }
  document.decisions.sort((a, b) => book.entries.findIndex(e => e.id === a.id) - book.entries.findIndex(e => e.id === b.id)); return document;
}
export function recordSfxListeningPreferenceV1(book: SfxApprovalReviewV1, current: unknown, value: unknown): SfxListeningPreferencesV1 {
  const document = restoreSfxListeningPreferencesV1(book, current), input = sfxListeningPreferenceSchemaV1.parse(value), entry = book.entries.find(e => e.id === input.id);
  if (!entry) throw Error("SFX_PREFERENCES_SOURCE_MISMATCH");
  const decision = { ...input, wavSha256: entry.sha256, sourceSha256: entry.sourceSha256 }, previous = document.decisions.find(d => d.id === input.id);
  if (previous && (Date.parse(previous.recordedAt) > Date.parse(input.recordedAt)
    || Date.parse(previous.recordedAt) === Date.parse(input.recordedAt) && canonicalJson(previous) !== canonicalJson(decision))) throw Error("SFX_PREFERENCE_NONCHRONOLOGICAL_EDIT");
  return restoreSfxListeningPreferencesV1(book, { ...document, decisions: [...document.decisions.filter(d => d.id !== input.id), decision] });
}
export function decodeSfxListeningPreferencesV1(book: SfxApprovalReviewV1, bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.length > SFX_LISTENING_DOCUMENT_MAX_BYTES_V1) throw Error("SFX_PREFERENCES_DOCUMENT_BUDGET");
  return restoreSfxListeningPreferencesV1(book, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
export function encodeSfxListeningPreferencesV1(book: SfxApprovalReviewV1, value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(restoreSfxListeningPreferencesV1(book, value), null, 2));
  if (bytes.length > SFX_LISTENING_DOCUMENT_MAX_BYTES_V1) throw Error("SFX_PREFERENCES_DOCUMENT_BUDGET"); return bytes;
}
