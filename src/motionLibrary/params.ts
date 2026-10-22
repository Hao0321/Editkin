import type { ZodError } from "zod";
import { resolveMotionPalette } from "./palettes";
import {
  MotionLibraryParamsError,
  backgroundMotionParamsInputSchema,
  backgroundMotionParamsSchema,
  textMotionParamsInputSchema,
  textMotionParamsSchema,
  transitionMotionParamsInputSchema,
  transitionMotionParamsSchema,
  type BackgroundMotionItem,
  type BackgroundMotionParams,
  type MotionLibraryItem,
  type MotionLibraryParams,
  type TextMotionItem,
  type TextMotionParams,
  type TransitionMotionItem,
  type TransitionMotionParams,
} from "./types";

function issues(error: ZodError): string[] {
  return error.issues.map(issue => `${issue.path.length ? issue.path.join(".") : "params"}: ${issue.message}`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Merge caller input over the item's defaults and validate. Input is partial:
 * `palette` may name a theme and/or override single roles; every other field
 * replaces the default. Unknown fields are rejected. The result is frozen.
 */
export function resolveMotionLibraryParams(item: TextMotionItem, input?: unknown): TextMotionParams;
export function resolveMotionLibraryParams(item: TransitionMotionItem, input?: unknown): TransitionMotionParams;
export function resolveMotionLibraryParams(item: BackgroundMotionItem, input?: unknown): BackgroundMotionParams;
export function resolveMotionLibraryParams(item: MotionLibraryItem, input?: unknown): MotionLibraryParams;
export function resolveMotionLibraryParams(item: MotionLibraryItem, input: unknown = {}): MotionLibraryParams {
  const inputSchema = item.kind === "text" ? textMotionParamsInputSchema
    : item.kind === "transition" ? transitionMotionParamsInputSchema : backgroundMotionParamsInputSchema;
  const parsedInput = inputSchema.safeParse(input ?? {});
  if (!parsedInput.success) throw new MotionLibraryParamsError(item.id, issues(parsedInput.error));
  const { palette: paletteInput, ...rest } = parsedInput.data as Record<string, unknown> & { palette?: Parameters<typeof resolveMotionPalette>[0] };
  let palette;
  try { palette = resolveMotionPalette(paletteInput, item.defaultParams.palette); } catch (error) {
    throw new MotionLibraryParamsError(item.id, [`palette: ${(error as Error).message}`]);
  }
  const merged: Record<string, unknown> = { ...item.defaultParams, ...stripUndefined(rest), palette };
  const schema = item.kind === "text" ? textMotionParamsSchema
    : item.kind === "transition" ? transitionMotionParamsSchema : backgroundMotionParamsSchema;
  const parsed = schema.safeParse(merged);
  if (!parsed.success) throw new MotionLibraryParamsError(item.id, issues(parsed.error));
  if (item.kind === "transition") {
    const direction = (parsed.data as TransitionMotionParams).direction;
    if (direction !== undefined && !(item.supportedDirections ?? []).includes(direction)) {
      throw new MotionLibraryParamsError(item.id, [`direction: ${item.id} does not support ${direction}`]);
    }
  }
  return deepFreeze(parsed.data as MotionLibraryParams);
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result[key] = entry;
  return result;
}

/** Canonical JSON: object keys sorted, arrays in order, numbers as JSON prints them. Used for cache keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson cannot encode non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson cannot encode ${typeof value}`);
}
