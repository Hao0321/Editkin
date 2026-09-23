interface ActivationKey {
  key: string; repeat: boolean;
  preventDefault(): void; stopPropagation(): void;
}
/** Consume activation, including repeats, so neither native defaults nor an
 * editor shortcut can activate the same action twice. */
export function activateTrackMenuItem(event: ActivationKey, item?: { disabled: boolean; click(): void } | null): boolean {
  if (event.key !== "Enter" && event.key !== " ") return false;
  event.preventDefault(); event.stopPropagation();
  if (item && !item.disabled && !event.repeat) item.click();
  return true;
}
