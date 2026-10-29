import S1 from "./S1_explainer_ui.json";
import S2 from "./S2_story_illustrated.json";
import S3 from "./S3_lifestyle_promo.json";
import { findFilmLookV2 } from "../../creative/filmLooksV2";
import { PROCEDURAL_SFX_CATALOGUE_V1 } from "../../application/proceduralSfxCatalogueV1";
import { styleTemplateSchemaV1, type StyleTemplateV1 } from "../types";

/**
 * The style template catalogue (data). Each JSON file is validated against
 * editkin.style-template/v1 once, and its look ids must exist in Hao Film Looks v2.
 */
const SOURCES: readonly unknown[] = [S1, S2, S3];

export function parseStyleTemplateV1(input: unknown): StyleTemplateV1 {
  const template = styleTemplateSchemaV1.parse(input);
  const looks = [template.components.look, ...Object.values(template.components.look.byGenre ?? {})];
  for (const look of looks) if (!findFilmLookV2(look.filmLookId)) throw new Error(`Style template ${template.id}: unknown film look ${look.filmLookId}`);
  // C9 cues pick from the existing procedural SFX library only (no new audio files).
  for (const [event, id] of Object.entries(template.components.sound?.cues ?? {})) {
    if (!PROCEDURAL_SFX_CATALOGUE_V1.some((recipe) => recipe.id === id)) throw new Error(`Style template ${template.id}: sound cue ${event} uses unknown SFX ${id}`);
  }
  return Object.freeze(template);
}

let catalogue: ReadonlyMap<string, StyleTemplateV1> | undefined;

export function styleTemplateCatalogV1(): ReadonlyMap<string, StyleTemplateV1> {
  if (!catalogue) {
    const map = new Map<string, StyleTemplateV1>();
    for (const source of SOURCES) {
      const template = parseStyleTemplateV1(source);
      if (map.has(template.id)) throw new Error(`Duplicate style template id ${template.id}`);
      map.set(template.id, template);
    }
    catalogue = map;
  }
  return catalogue;
}

export function getStyleTemplateV1(id: string): StyleTemplateV1 {
  const template = styleTemplateCatalogV1().get(id);
  if (!template) throw new Error(`Unknown style template ${id}`);
  return template;
}
