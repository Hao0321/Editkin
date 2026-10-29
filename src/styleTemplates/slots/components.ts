import { contrastRatio, mostContrasting } from "../../motionLibrary/svg/color";
import type { StyleComponentRendererV1, StyleSlotValuesV1 } from "../../domain/styleJobFieldsV1";
import type { CardChromeParams, UiBackdropParams } from "../uiCard/components";
import type { StyleCompositeHooksV1 } from "./compositeComponent";
import { COLLAGE_EXPLAINER_REVISION, COLLAGE_IMAGE_SLOTS, collageExplainerCompositeV1, collageImageWindowV1, collageParams, type CollageParamsV1 } from "./collageExplainer";
import { DEVICE_SCREEN_IMAGE_SLOTS, DEVICE_SCREEN_REVISION, EXTRUDED_TITLE_REVISION, deviceScreenCompositeV1, deviceScreenImageWindowV1, deviceScreenParams, type DeviceScreenParams } from "./mesh3dDeviceScreen";
import { KINETIC_LYRIC_REVISION, LYRIC_BAND_REVISION, kineticLyricCompositeV1, kineticLyricParams, type KineticLyricParamsV1 } from "./mesh3dKineticLyric";
import { STYLE_CLIP_COMPONENTS_IMPLEMENTED_V1, STYLE_CLIP_PARTS_IMPLEMENTED_V1, type StyleSlotTemplateV1 } from "./slotCatalog";
import type { SlotImageParams } from "./svgImage";
import {
  UI_CARD_SCENE_REVISION, uiCardSceneBackdrop, uiCardSceneFrame, uiCardSceneShadowStill, uiCardSceneTiming, uiCardSceneWindow, type UiCardSceneParams,
} from "./uiCardScene";

/**
 * Clip components that consume template slots, keyed by id. Renderer-agnostic: a component says which renderer draws it
 * and turns slot values into its own params. `svg` components either draw one SVG document per frame (uiCardScene, the
 * Motion Library engine path) or are composited (collageExplainer: SVG art rasterized once, posed per frame); `mesh3d`
 * components render engine passes on Mesh3dWorkerPoolV1 and composite them with SVG type (compositeRender.ts). Only
 * implemented components are registered; slotCatalog's tables (roots and parts) are pinned to this registry by test.
 */

export interface StyleClipBuildInputV1 {
  readonly template: StyleSlotTemplateV1;
  readonly slots: StyleSlotValuesV1;
  readonly frame: { readonly width: number; readonly height: number };
  /** Exact clip length (frameCount / fps). */
  readonly durationSeconds: number;
  /** Normalized picture per filled image slot. */
  readonly images: Readonly<Record<string, SlotImageParams>>;
}

export interface StyleClipFrameResourcesV1 {
  /** data: URIs of the pictures, by image slot id. */
  readonly images: Readonly<Record<string, string>>;
  /** data: URIs of the component's pre-rendered stills (StyleClipComponentV1.stills), by name. */
  readonly stills?: Readonly<Record<string, string>>;
  /** Previews and contact sheets draw the underlay inside the frame. */
  readonly includeUnderlay?: boolean;
}

export interface StyleClipComponentV1 {
  readonly id: string;
  readonly renderer: StyleComponentRendererV1;
  readonly revision: number;
  /** The strongest zoom a picture sees (derivatives are sized for it). */
  readonly maxImagePunch: number;
  /** Pixel window an image slot fills at this output size. */
  imageWindow(slotId: string, frame: { readonly width: number; readonly height: number }): { readonly w: number; readonly h: number } | undefined;
  build(input: StyleClipBuildInputV1): Record<string, unknown>;
  /** svg components: one frame (pure in params, t and the picture bytes). */
  svgFrame?(params: Record<string, unknown>, t: number, resources: StyleClipFrameResourcesV1): string;
  /** A still drawn under every frame, rendered once (the S1 backdrop). */
  underlay?(params: Record<string, unknown>): UiBackdropParams | undefined;
  /** Expensive static layers rendered once as stills and placed (posed) inside every frame. */
  stills?(params: Record<string, unknown>): Readonly<Record<string, CardChromeParams>>;
  /** Which image slot a picture param belongs to (for the renderer's data URIs). */
  readonly imageSlots: readonly string[];
  /** Named parts this component draws (slots may bind to them). */
  readonly parts?: ReadonlyArray<{ readonly id: string; readonly renderer: StyleComponentRendererV1; readonly revision: number }>;
  /**
   * Composited components (every mesh3d component, and SVG art posed per frame such as S5's collage) render through the
   * template compositor instead of one SVG document per frame (compositeComponent.ts / compositeRender.ts).
   */
  readonly composite?: StyleCompositeHooksV1;
}

const uiCardScene: StyleClipComponentV1 = {
  id: "uiCardScene", renderer: "svg", revision: UI_CARD_SCENE_REVISION, maxImagePunch: 1.15, imageSlots: ["card"],
  imageWindow: (slotId, frame) => {
    if (slotId !== "card") return undefined;
    const win = uiCardSceneWindow(frame.width, frame.height);
    return { w: win.w, h: win.h };
  },
  build: ({ template, slots, frame, durationSeconds, images }) => {
    const palette = template.palette as Record<string, string>;
    const accent = slots.color.accent ?? palette.accent, ink = slots.color.ink ?? palette.ink;
    // Derived colours follow the roles: the tag text is the ink when it reads on the accent, else the best contrast.
    const onAccent = contrastRatio(ink, accent) >= 4.5 ? ink : mostContrasting(accent, [ink, palette.paper ?? "#FFFFFF", "#FFFFFF", "#121214"]);
    const text = Object.fromEntries(["chapterNumber", "chapterLabel", "lead", "keyword", "tag"].flatMap(id => slots.text[id] ? [[id, slots.text[id]]] : [])) as UiCardSceneParams["text"];
    const card = template.slots.image.find(slot => slot.id === "card")!;
    const params: UiCardSceneParams = {
      component: "uiCardScene", revision: UI_CARD_SCENE_REVISION, width: frame.width, height: frame.height, duration: durationSeconds,
      accent, ink, onAccent, text, ...(images.card ? { image: images.card } : {}),
      placeholder: card.placeholder === "ui_panel" ? "ui_panel" : "none", backdropSeed: 7, timing: uiCardSceneTiming(durationSeconds),
    };
    return params as unknown as Record<string, unknown>;
  },
  svgFrame: (params, t, resources) => uiCardSceneFrame(params as unknown as UiCardSceneParams, t,
    { image: resources.images.card, cardShadow: resources.stills?.cardShadow, includeBackdrop: resources.includeUnderlay }),
  underlay: params => uiCardSceneBackdrop(params as unknown as UiCardSceneParams),
  stills: params => ({ cardShadow: uiCardSceneShadowStill(params as unknown as UiCardSceneParams).params }),
};

/** Colour roles: the slot override, else the template's palette. */
function roles(template: StyleSlotTemplateV1, slots: StyleSlotValuesV1, names: readonly string[]): Record<string, string> {
  const palette = template.palette as Record<string, string | undefined>, out: Record<string, string> = {};
  for (const name of names) {
    const value = (slots.color as Record<string, string | undefined>)[name] ?? palette[name];
    if (!value) throw new Error(`${template.id} has no colour for ${name}`);
    out[name] = value;
  }
  return out;
}

const pick = <K extends string>(slots: StyleSlotValuesV1, ids: readonly K[]) =>
  Object.fromEntries(ids.flatMap(id => slots.text[id] ? [[id, slots.text[id]]] : [])) as Partial<Record<K, string>>;

/** S4 motion_promo_3d: the device, its screen and pop-out cards, with the extruded chrome title as a part. */
const mesh3dDeviceScreen: StyleClipComponentV1 = {
  id: "mesh3dDeviceScreen", renderer: "mesh3d", revision: DEVICE_SCREEN_REVISION, maxImagePunch: 1, imageSlots: [...DEVICE_SCREEN_IMAGE_SLOTS],
  parts: [{ id: "mesh3dExtrudedTitle", renderer: "mesh3d", revision: EXTRUDED_TITLE_REVISION }],
  imageWindow: slotId => deviceScreenImageWindowV1(slotId),
  build: ({ template, slots, frame, durationSeconds, images }) => {
    const text = pick(slots, ["title", "kicker"] as const);
    const params: DeviceScreenParams = deviceScreenParams({ width: frame.width, height: frame.height, duration: durationSeconds,
      roles: roles(template, slots, ["bg", "accent", "accent2", "highlight"]) as { bg: string; accent: string; accent2: string; highlight: string },
      text: { title: text.title ?? "", ...(text.kicker ? { kicker: text.kicker } : {}) }, images: { ...images } });
    return params as unknown as Record<string, unknown>;
  },
  composite: deviceScreenCompositeV1,
};

/** S5 vox_collage: the collage explainer (composited SVG art). */
const collageExplainer: StyleClipComponentV1 = {
  id: "collageExplainer", renderer: "svg", revision: COLLAGE_EXPLAINER_REVISION, maxImagePunch: 1, imageSlots: [...COLLAGE_IMAGE_SLOTS],
  imageWindow: (slotId, frame) => collageImageWindowV1(frame, slotId),
  build: ({ template, slots, frame, durationSeconds, images }) => {
    const text = pick(slots, ["wordmark", "kicker", "caption", "gloss", "step1", "step2", "step3", "stepCaption", "stepGloss"] as const);
    const params: CollageParamsV1 = collageParams({ width: frame.width, height: frame.height, duration: durationSeconds,
      palette: roles(template, slots, ["paper", "bg", "accent"]) as { paper: string; bg: string; accent: string },
      text: { ...text, wordmark: text.wordmark ?? "" }, images: { ...images } });
    return params as unknown as Record<string, unknown>;
  },
  composite: collageExplainerCompositeV1,
};

/** S7 kinetic_lyric_3d: the hero word, ring, tunnel and lock-up, with the lyric band as a part. */
const mesh3dKineticLyric: StyleClipComponentV1 = {
  id: "mesh3dKineticLyric", renderer: "mesh3d", revision: KINETIC_LYRIC_REVISION, maxImagePunch: 1, imageSlots: [],
  parts: [{ id: "mesh3dLyricBand", renderer: "mesh3d", revision: LYRIC_BAND_REVISION }],
  imageWindow: () => undefined,
  build: ({ template, slots, frame, durationSeconds }) => {
    const text = pick(slots, ["word", "band", "label", "labelSub", "display", "script", "kicker"] as const);
    const params: KineticLyricParamsV1 = kineticLyricParams({ width: frame.width, height: frame.height, duration: durationSeconds,
      palette: roles(template, slots, ["paper", "ink", "bg", "accent"]) as { paper: string; ink: string; bg: string; accent: string },
      text: { ...text, word: text.word ?? "" } });
    return params as unknown as Record<string, unknown>;
  },
  composite: kineticLyricCompositeV1,
};

const REGISTRY: ReadonlyMap<string, StyleClipComponentV1> = new Map([uiCardScene, mesh3dDeviceScreen, collageExplainer, mesh3dKineticLyric].map(component => [component.id, component]));

export function styleClipComponentV1(id: string): StyleClipComponentV1 | undefined {
  return REGISTRY.get(id);
}

export function registeredStyleClipComponentsV1(): readonly StyleClipComponentV1[] {
  return [...REGISTRY.values()];
}

/** For tests: the light tables slotCatalog uses (roots and parts) equal this registry. */
export function implementedComponentTableV1() {
  return { registry: Object.fromEntries([...REGISTRY.values()].map(component => [component.id, { renderer: component.renderer, revision: component.revision }])),
    table: Object.fromEntries(Object.entries(STYLE_CLIP_COMPONENTS_IMPLEMENTED_V1).map(([id, entry]) => [id, { renderer: entry.renderer, revision: entry.revision }])),
    registryParts: Object.fromEntries([...REGISTRY.values()].flatMap(component => (component.parts ?? []).map(part => [part.id, { root: component.id, renderer: part.renderer, revision: part.revision }]))),
    tableParts: Object.fromEntries(Object.entries(STYLE_CLIP_PARTS_IMPLEMENTED_V1).map(([id, entry]) => [id, { root: entry.root, renderer: entry.renderer, revision: entry.revision }])) };
}
