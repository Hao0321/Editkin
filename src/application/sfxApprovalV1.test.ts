import { describe, expect, it } from "vitest";
import { PROCEDURAL_SFX_CATALOGUE_V1 as catalogue } from "./proceduralSfxCatalogueV1";
import { createSfxApprovalReviewV1 as create, createEmptySfxListeningPreferencesV1 as empty, recordSfxListeningPreferenceV1 as record,
  restoreSfxListeningPreferencesV1 as restore, encodeSfxListeningPreferencesV1 as encode, decodeSfxListeningPreferencesV1 as decode, SFX_LISTENING_DOCUMENT_MAX_BYTES_V1 } from "./sfxApprovalV1";
const pins = () => ["Catalogue", "Synth"].map(k => ({ path: `src/application/proceduralSfx${k}V1.ts`, bytes: 20, sha256: "d".repeat(64) }));
const entries = () => catalogue.map(r => ({ id: r.id, name: `Original ${r.kind} ${r.variant}`, kind: r.kind, sha256: "a".repeat(64), bytes: 44 + r.durationSamples * 2,
  durationSamples: r.durationSamples, durationSeconds: r.durationSamples / 48_000, sourceSha256: "b".repeat(64), source: r.source, rightsBasis: r.rightsBasis,
  distributionScope: r.distributionScope, certification: r.certification, defaultEnabled: false as const, redistributable: false as const, contentVerified: true as const }));
const choice = (index = 0) => ({ id: catalogue[index].id, preference: "preferred", reviewer: "AUTOMATED_UNIT_FIXTURE_NOT_HUMAN_APPROVAL", recordedAt: "2026-10-17T00:00:00.000Z", note: "synthetic fixture" });
describe("source-bound original SFX listening preferences", () => {
  it("canonicalizes all40 entries and two generator pins without granting approval", async () => {
    const a = await create(entries(), pins()), b = await create(entries().reverse(), pins().reverse());
    expect(a.reviewSha256).toBe(b.reviewSha256); expect(a.entries).toHaveLength(40); expect(a.qualityApprovalGranted).toBe(false);
    expect(a.defaultEnabled).toBe(false); expect(a.certification).toBe("AUDIO_PENDING_HAO_CLAUDE"); expect(empty(a).decisions).toEqual([]);
  });
  it.each(["missing", "duplicate", "unknown", "duration", "bytes", "unverified", "default", "public", "extra"])("refuses %s review catalogue input", async mode => {
    const values: any[] = entries();
    if (mode === "missing") values.pop(); if (mode === "duplicate") values[1] = values[0]; if (mode === "unknown") values[0].id = "not-catalogued";
    if (mode === "duration") values[0].durationSamples++; if (mode === "bytes") values[0].bytes++;
    if (mode === "unverified") values[0].contentVerified = false; if (mode === "default") values[0].defaultEnabled = true;
    if (mode === "public") values[0].redistributable = true; if (mode === "extra") values[0].humanApproved = true;
    await expect(create(values, pins())).rejects.toThrow();
  });
  it("refuses duplicate generator pins and snapshots caller metadata across await", async () => {
    const p = pins(); await expect(create(entries(), [p[0], p[0]])).rejects.toThrow();
    const values = entries(), task = create(values, p); values[0].name = "late mutation"; p[0].sha256 = "f".repeat(64);
    const book = await task; expect(book.entries[0].name).not.toBe("late mutation"); expect(book.generatorPins[0].sha256).toBe("d".repeat(64));
    expect(Object.isFrozen(book.entries[0])).toBe(true);
  });
  it("records/replaces/clears preferences and round-trips a file without source/default changes", async () => {
    const book = await create(entries(), pins()), first = record(book, empty(book), choice());
    const next = record(book, first, { ...choice(), preference: "needs_changes", recordedAt: "2026-10-17T00:00:01.000Z" });
    const cleared = record(book, next, { ...choice(), preference: "unreviewed", recordedAt: "2026-10-17T00:00:02.000Z" });
    expect(first.decisions[0].preference).toBe("preferred"); expect(next.decisions).toHaveLength(1); expect(cleared.decisions[0].preference).toBe("unreviewed");
    expect(decode(book, encode(book, next))).toEqual(next); expect(next.certification).toBe("AUDIO_PENDING_HAO_CLAUDE"); expect(next.defaultEnabled).toBe(false);
  });
  it("rejects changed WAV, SOURCE and generator identities at reopen", async () => {
    const a = await create(entries(), pins()), document = record(a, empty(a), choice());
    for (const mode of ["wav", "source", "generator"]) {
      const values = entries(), p = pins(); if (mode === "wav") values[0].sha256 = "e".repeat(64);
      if (mode === "source") values[0].sourceSha256 = "e".repeat(64); if (mode === "generator") p[0].sha256 = "e".repeat(64);
      const b = await create(values, p); expect(() => restore(b, document)).toThrow("REVIEW_IDENTITY_MISMATCH");
    }
  });
  it.each(["id", "wav", "source", "duplicate", "quality", "default", "actor", "note", "status"])("refuses %s preference document substitution", async mode => {
    const b = await create(entries(), pins()), d: any = record(b, empty(b), choice());
    if (mode === "id") d.decisions[0].id = "unknown"; if (mode === "wav") d.decisions[0].wavSha256 = "f".repeat(64);
    if (mode === "source") d.decisions[0].sourceSha256 = "f".repeat(64); if (mode === "duplicate") d.decisions.push(d.decisions[0]);
    if (mode === "quality") d.qualityApproved = true; if (mode === "default") d.defaultEnabled = true;
    if (mode === "actor") d.decisions[0].reviewer = " "; if (mode === "note") d.decisions[0].note = "x".repeat(501);
    if (mode === "status") d.decisions[0].preference = "certified"; expect(() => restore(b, d)).toThrow();
  });
  it("refuses serialized book authority and stale/equal-instant edits including ISO spelling aliases", async () => {
    const b = await create(entries(), pins()), d = record(b, empty(b), choice());
    expect(() => empty(JSON.parse(JSON.stringify(b)))).toThrow("LIVE_UNCHANGED_REVIEW");
    expect(record(b, d, choice())).toEqual(d);
    for (const recordedAt of ["2026-10-16T23:59:59.000Z", "2026-10-17T00:00:00.000Z", "2026-10-17T00:00:00Z"])
      expect(() => record(b, d, { ...choice(), preference: "reject", recordedAt })).toThrow("NONCHRONOLOGICAL");
  });
  it("sorts40 choices by catalogue, rejects overbudget/invalid UTF8 and keeps imported assertions untrusted", async () => {
    const b = await create(entries(), pins()); let d = empty(b);
    for (let i = 39; i >= 0; i--) d = record(b, d, choice(i));
    expect(d.decisions.map(x => x.id)).toEqual(catalogue.map(x => x.id)); expect(decode(b, encode(b, d))).toEqual(d);
    expect(() => decode(b, new Uint8Array(SFX_LISTENING_DOCUMENT_MAX_BYTES_V1 + 1))).toThrow("DOCUMENT_BUDGET"); expect(() => decode(b, Uint8Array.of(255))).toThrow();
    expect(d.assertion).toContain("not_authenticated_quality_approval");
  });
  it("saves and reopens all40 allowed maximum Unicode notes and reviewer names", async () => {
    const b = await create(entries(), pins()); let d = empty(b);
    for (let i = 0; i < 40; i++) d = record(b, d, { ...choice(i), reviewer: "AUTOMATED_" + "測".repeat(70), note: "測".repeat(500) });
    const bytes = encode(b, d); expect(bytes.length).toBeGreaterThan(65_536); expect(bytes.length).toBeLessThanOrEqual(SFX_LISTENING_DOCUMENT_MAX_BYTES_V1);
    expect(decode(b, bytes)).toEqual(d); expect(d.defaultEnabled).toBe(false);
  });
  it("bounds timestamp precision as well as document/field size", async () => {
    const b = await create(entries(), pins()); expect(() => record(b, empty(b), { ...choice(), recordedAt: "2026-10-17T00:00:00." + "1".repeat(40) + "Z" })).toThrow();
  });
  it("preserves permitted escaped UTF16 field content across a complete40choice document", async () => {
    const b = await create(entries(), pins()); let d = empty(b);
    for (let i = 0; i < 40; i++) d = record(b, d, { ...choice(i), reviewer: "AUTOMATED_" + "\ud800".repeat(70), note: "\ud800".repeat(500) });
    const bytes = encode(b, d); expect(bytes.length).toBeGreaterThan(128 * 1024); expect(decode(b, bytes)).toEqual(d);
  });
});
