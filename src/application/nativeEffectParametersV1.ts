import type { NativeEffectInstance, NativeEffectParameterValue } from "../domain/types";
import type { PluginRegistrySummary } from "../desktop/pluginTypes";
import { validatePluginParameters } from "../plugins/manifest";
import { createTransformMotionBlurInstance, isTransformMotionBlurInstance, transformMotionBlurParameters } from "../domain/transformMotionBlur";

type Parameter = PluginRegistrySummary["plugins"][number]["capabilities"][number]["parameters"][number];
export interface NativeEffectParameterRowV1 { id: string; name: string; value: NativeEffectParameterValue; definition?: Parameter }
export interface NativeEffectParameterViewV1 {
  matched: boolean; builtin: boolean; rows: NativeEffectParameterRowV1[]; defaults?: NativeEffectInstance["parameters"];
}
export function matchingNativeEffectCapabilityV1(instance: NativeEffectInstance, registry?: PluginRegistrySummary) {
  const plugin = registry?.plugins.find(plugin => plugin.id === instance.pluginId && plugin.version === instance.pluginVersion && plugin.manifestSha256 === instance.manifestSha256);
  return plugin?.capabilities.find(capability => capability.id === instance.capabilityId && capability.kind === "effect"
    && (capability.runtimeType === "gpu_effect_module" ? "gpu_effect_graph" : capability.runtimeType) === (instance.runtimeType ?? "native_effect"));
}
export function nativeEffectParameterViewV1(instance: NativeEffectInstance, registry?: PluginRegistrySummary): NativeEffectParameterViewV1 {
  const builtin = isTransformMotionBlurInstance(instance), seed = builtin ? createTransformMotionBlurInstance() : undefined;
  let definitions: Parameter[] | undefined;
  if (seed && seed.pluginVersion === instance.pluginVersion && seed.manifestSha256 === instance.manifestSha256 && seed.runtimeType === instance.runtimeType) {
    definitions = [
      { id: "shutter_angle", name: "快門角度", type: "number", default: seed.parameters.shutter_angle as number, min: 0, max: 360, step: 1 },
      { id: "samples", name: "取樣數", type: "number", default: seed.parameters.samples as number, min: 2, max: 8, step: 1 },
    ];
  } else if (!builtin) {
    const capability = matchingNativeEffectCapabilityV1(instance, registry);
    if (capability) definitions = capability.parameters;
  }
  let defaults: NativeEffectInstance["parameters"] | undefined;
  if (definitions && definitions.length <= 64 && new Set(definitions.map(definition => definition.id)).size === definitions.length) {
    try { defaults = validatePluginParameters({ parameters: definitions }, {}); } catch { definitions = undefined; }
  } else definitions = undefined;
  const rows: NativeEffectParameterRowV1[] = (definitions ?? []).map(definition => ({ id: definition.id, name: definition.name, definition,
    value: Object.hasOwn(instance.parameters, definition.id) ? instance.parameters[definition.id] : definition.default }));
  const known = new Set(rows.map(row => row.id));
  for (const [id, value] of Object.entries(instance.parameters)) if (!known.has(id)) rows.push({ id, name: id, value });
  return { matched: definitions !== undefined, builtin, rows, defaults };
}
/** Undefined refuses invalid input; the original object represents an accepted no-op. No default writes on read. */
export function nativeEffectParameterPatchV1(instance: NativeEffectInstance, row: NativeEffectParameterRowV1, value: unknown): NativeEffectInstance["parameters"] | undefined {
  return nativeEffectParameterValuesPatchV1(instance, [row], { [row.id]: value });
}
/** Validate all intended fields, then the combined builtin payload once. Untouched current fields survive. */
export function nativeEffectParameterValuesPatchV1(instance: NativeEffectInstance, rows: readonly NativeEffectParameterRowV1[], values: Readonly<Record<string, unknown>>): NativeEffectInstance["parameters"] | undefined {
  try {
    const byId = new Map(rows.map(row => [row.id, row]));
    let changed = false;
    for (const [id, value] of Object.entries(values)) {
      const row = byId.get(id);
      if (!row) return undefined;
      if (row.definition) validatePluginParameters({ parameters: [row.definition] }, { [id]: value });
      else if (!Object.hasOwn(instance.parameters, id) || typeof value !== typeof row.value
        || typeof value === "number" && !Number.isFinite(value) || typeof value === "string" && value.length > 500
        || !["number", "string", "boolean"].includes(typeof value)) return undefined;
      if (value !== row.value) changed = true;
    }
    if (!changed) return instance.parameters;
    const parameters = { ...instance.parameters, ...values } as NativeEffectInstance["parameters"];
    if (isTransformMotionBlurInstance(instance)) transformMotionBlurParameters({ ...instance, parameters });
    return parameters;
  } catch { return undefined; }
}
export function nativeEffectParameterResetV1(instance: NativeEffectInstance, view: NativeEffectParameterViewV1): NativeEffectInstance["parameters"] | undefined {
  if (!view.matched || !view.defaults) return undefined;
  return nativeEffectParameterValuesPatchV1(instance, view.rows, view.defaults);
}
