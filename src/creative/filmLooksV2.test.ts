import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { colorGradeV2Schema } from "../domain/colorGradeV2Schema";
import { FILM_LOOK_GENRES, FILM_LOOKS_V2, colorGradeV2ContractSummary, findFilmLookV2 } from "./filmLooksV2";

/**
 * Parameters a look was certified with (a contact-sheet review on the listed evidence). Changing a certified
 * look's parameters re-opens certification: re-render the gates and sheets, look at them, then update this
 * table — or ship a new id. W1 (2026-10-10) certified 14 looks; pro-w1-1 re-tuned all of them for stronger
 * signatures, and Claude (art owner) certified all 14 on 2026-10-11 after viewing every pro-w1-1 sheet
 * (.rd/benchmarks/usable-v1-20261009/work/pro-w1-1/sheets/SHEET_<id>.jpg, GATES.json, METRICS.json).
 */
const CERTIFIED_PARAMETERS_SHA256: Record<string, string> = {
  hfl2_travel_clear_air: "b9168dde5dbd8a947d7d466a9ac3006dc2c3629cb69499793334e18a2ef44a73",
  hfl2_travel_golden_hour: "3160e91764463c2c77f27d5e6dfb11ed64673285b89d26633a8e824deba4f252",
  hfl2_travel_forest_calm: "1727141e2d9b847349512a4dd6cae36849a09f91ec9e34c4c5107b1c4bf04113",
  hfl2_food_warm_appetite: "3429cd38249d11c70382770e7e256cc8f0de82ccac031d3226bb8bbaa17602e3",
  hfl2_food_clean_bright: "b3b306d52c11d1c6dff33f76f60208cb0d949009f69a45bf4f3cd0416496b030",
  hfl2_night_neon_clean: "5bd171ef5920873f32078bf8dd32d542f2d329384b8a522271544098bf96e055",
  hfl2_night_city_teal: "2caab35796d95011a999604111b9f84dacfd009500d8c4fdf3a9506ed1103ce7",
  hfl2_tech_cool_precision: "ca5323c0fe5fe896b93809e42971a095dd123acbfddff406ef62b17ef5794c69",
  hfl2_tech_product_clean: "7ded8e78251d8dd141395de22a1b7d0a90c909fd0bccb8776a6dbdb063d62f0c",
  hfl2_gaming_arena_punch: "d688b9a25773d928457c32dff788098c0c27935c8fb895f58d25ac4a66f24b98",
  hfl2_vlog_soft_film: "08dfea0916cf77a839fdfe638785b88b3aad39d7ac454ae9fe1470138d27cae8",
  hfl2_vlog_natural_daylight: "26a296e2fa2069379a700a5cf71a0be1fe15187b0dd192d0418b39b66c38e005",
  hfl2_teaching_clear_neutral: "e8175121df93d7225e0a208ffa4e53157194325d0638cf4effb9a55a8455727f",
  hfl2_hype_vivid: "a3fa82e6b2ce6a8d6affac90533727077f5c387688aedf2b9906d98eb2112bb8",
};

/**
 * Parameters rendered on review sheets that are not yet certified. Pin a re-tuned look here with its sheet
 * evidence; certify it by moving the entry to CERTIFIED_PARAMETERS_SHA256 and listing it in filmLooksV2.ts.
 */
const PENDING_REVIEW_PARAMETERS_SHA256: Record<string, string> = {};

const parameterHash = (id: string) => {
  const look = findFilmLookV2(id)!;
  return createHash("sha256").update(JSON.stringify({ rec709: look.grade("rec709_display"), aces: look.grade("acescct") })).digest("hex");
};

describe("Hao Film Looks v2 catalogue", () => {
  it("covers every genre with original, MIT-licensed, valid looks in both working spaces", () => {
    expect(new Set(FILM_LOOKS_V2.map(look => look.genre))).toEqual(new Set(FILM_LOOK_GENRES));
    expect(FILM_LOOKS_V2.length).toBeGreaterThanOrEqual(12);
    expect(FILM_LOOKS_V2.length).toBeLessThanOrEqual(16);
    expect(new Set(FILM_LOOKS_V2.map(look => look.id)).size).toBe(FILM_LOOKS_V2.length);
    for (const look of FILM_LOOKS_V2) {
      expect(look.license).toBe("MIT");
      expect(look.provenance).toContain("original");
      for (const space of ["rec709_display", "acescct"] as const) {
        const grade = look.grade(space);
        expect(colorGradeV2Schema.safeParse({ schema: "editkin.color-grade/v2", nodes: grade.nodes, ...(grade.finishing ? { finishing: grade.finishing } : {}) }).success).toBe(true);
        // Every creative node limits gamut and protects skin/food and sky.
        for (const node of grade.nodes) expect(node.gamutLimit).toBe(true);
      }
    }
  });

  it("only certifies looks whose parameters are exactly the reviewed ones", () => {
    for (const look of FILM_LOOKS_V2) {
      if (look.certification.status !== "certified") continue;
      expect(CERTIFIED_PARAMETERS_SHA256[look.id], `${look.id} is certified without a reviewed parameter record`).toBeDefined();
      expect(parameterHash(look.id), `${look.id} changed after certification: re-run the gates and sheets`).toBe(CERTIFIED_PARAMETERS_SHA256[look.id]);
      expect(look.certification.evidence).toMatch(/pro-w1(-1)?\/(looks\/)?sheets\/GATES\.json$/);
    }
    expect(colorGradeV2ContractSummary().looks.filter(look => look.certification === "certified").map(look => look.id).sort())
      .toEqual(Object.keys(CERTIFIED_PARAMETERS_SHA256).sort());
  });

  it("keeps every pending look identical to the parameters rendered on the pro-w1-1 review sheets", () => {
    for (const look of FILM_LOOKS_V2) {
      if (look.certification.status !== "pending") continue;
      expect(PENDING_REVIEW_PARAMETERS_SHA256[look.id], `${look.id} has no rendered review sheet`).toBeDefined();
      expect(parameterHash(look.id), `${look.id} changed after the pro-w1-1 sheets were rendered: re-render them`).toBe(PENDING_REVIEW_PARAMETERS_SHA256[look.id]);
      expect(look.certification.evidence).toBe(".rd/benchmarks/usable-v1-20261009/work/pro-w1-1/sheets/GATES.json");
    }
  });
});
