import S1 from "../templates/S1_explainer_ui.json";
import S2 from "../templates/S2_story_illustrated.json";
import S3 from "../templates/S3_lifestyle_promo.json";
import S4 from "../templates/S4_motion_promo_3d.slots.json";
import S5 from "../templates/S5_vox_collage.slots.json";
import S7 from "../templates/S7_kinetic_lyric_3d.slots.json";
import { styleTemplateSchemaV1 } from "../types";
import { styleTemplateStubSchemaV1, type StyleSlots, type StyleTemplateClip } from "./slotSchema";
import type { StyleComponentRendererV1 } from "../../domain/styleJobFieldsV1";

/**
 * The slot-enabled templates: every editkin.style-template/v1 document that declares `slots` + `clip`, plus the slot-only
 * templates whose art is a clip component built from style frames (S4, S5, S7; built 2026-10-23, certified 2026-10-29). Light and browser-safe (zod + JSON): the domain commands read it to
 * check slot values, the module lists it for VA, the inspector reads labels from it. It does not load film looks, the
 * SFX catalogue or any renderer; `implemented` comes from the small table below (pinned to the component registry by test).
 */

/**
 * Clip components that can render today (slots/components.ts registers their code), and the parts each of them draws
 * (a slot may bind to a part: S4's extruded title, S7's lyric band). Pinned equal to the registry by test.
 */
export const STYLE_CLIP_COMPONENTS_IMPLEMENTED_V1: Readonly<Record<string, { readonly renderer: StyleComponentRendererV1; readonly revision: number }>> = Object.freeze({
  uiCardScene: Object.freeze({ renderer: "svg" as const, revision: 1 }),
  mesh3dDeviceScreen: Object.freeze({ renderer: "mesh3d" as const, revision: 1 }),
  collageExplainer: Object.freeze({ renderer: "svg" as const, revision: 1 }),
  mesh3dKineticLyric: Object.freeze({ renderer: "mesh3d" as const, revision: 1 }),
});
export const STYLE_CLIP_PARTS_IMPLEMENTED_V1: Readonly<Record<string, { readonly root: string; readonly renderer: StyleComponentRendererV1; readonly revision: number }>> = Object.freeze({
  mesh3dExtrudedTitle: Object.freeze({ root: "mesh3dDeviceScreen", renderer: "mesh3d" as const, revision: 1 }),
  mesh3dLyricBand: Object.freeze({ root: "mesh3dKineticLyric", renderer: "mesh3d" as const, revision: 1 }),
});

export interface StyleSlotTemplateV1 {
  readonly id: string;
  readonly revision: number;
  readonly names: { readonly zh: string; readonly en: string };
  readonly reference: string;
  readonly videoTypes: readonly string[];
  readonly artStatus: "certified" | "pending";
  /** Slots declared ahead of the art (no renderer yet); false once the template's components are built. */
  readonly stub: boolean;
  /** Template palette (stubs: the measured roles only). */
  readonly palette: Readonly<Partial<Record<string, string>>>;
  readonly slots: StyleSlots;
  readonly clip: StyleTemplateClip;
  /** Every component of the clip renders today. */
  readonly implemented: boolean;
  readonly art?: { readonly styleframes: string; readonly engine: string };
}

const FULL_SOURCES: readonly unknown[] = [S1, S2, S3];
const SLOT_ONLY_SOURCES: readonly unknown[] = [S4, S5, S7];

function implemented(clip: StyleTemplateClip): boolean {
  const root = STYLE_CLIP_COMPONENTS_IMPLEMENTED_V1[clip.component.id];
  if (!root || root.renderer !== clip.component.renderer || root.revision !== clip.component.revision) return false;
  return (clip.parts ?? []).every(part => {
    const entry = STYLE_CLIP_PARTS_IMPLEMENTED_V1[part.id];
    return entry !== undefined && entry.root === clip.component.id && entry.renderer === part.renderer && entry.revision === part.revision;
  });
}

let catalogue: ReadonlyMap<string, StyleSlotTemplateV1> | undefined;

export function styleSlotTemplatesV1(): ReadonlyMap<string, StyleSlotTemplateV1> {
  if (catalogue) return catalogue;
  const map = new Map<string, StyleSlotTemplateV1>();
  const add = (entry: StyleSlotTemplateV1) => {
    if (map.has(entry.id)) throw new Error(`Duplicate slot template ${entry.id}`);
    map.set(entry.id, Object.freeze(entry));
  };
  for (const source of FULL_SOURCES) {
    const template = styleTemplateSchemaV1.parse(source);
    if (!template.slots || !template.clip) continue;
    add({ id: template.id, revision: template.revision, names: template.names, reference: template.reference, videoTypes: template.videoTypes,
      artStatus: template.artStatus, stub: false, palette: { ...template.palette }, slots: template.slots, clip: template.clip, implemented: implemented(template.clip) });
  }
  for (const source of SLOT_ONLY_SOURCES) {
    const doc = styleTemplateStubSchemaV1.parse(source);
    const palette = Object.fromEntries(Object.entries(doc.palette).filter(([, value]) => value !== undefined)) as Record<string, string>;
    const built = !doc.stub && implemented(doc.clip);
    if (!doc.stub && !built) throw new Error(`Slot template ${doc.id} declares built art but ${doc.clip.component.id} is not registered`);
    add({ id: doc.id, revision: doc.revision, names: doc.names, reference: doc.reference, videoTypes: doc.videoTypes, artStatus: doc.artStatus,
      stub: doc.stub, palette, slots: doc.slots, clip: doc.clip, implemented: built, art: doc.art });
  }
  catalogue = map;
  return catalogue;
}

export function findStyleSlotTemplateV1(id: string): StyleSlotTemplateV1 | undefined {
  return styleSlotTemplatesV1().get(id);
}
