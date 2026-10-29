/**
 * Test helper: every physical key of a US keyboard with every Ctrl / Alt / Shift combination, as the KeyboardEvent the
 * browser sends (Shift turns "=" into "+" and "b" into "B") and as the combination printed on the keys ("Shift+=").
 * Used to pin the editor's whole key map, so no shortcut can change or disappear silently.
 */
const SYMBOLS: ReadonlyArray<readonly [string, string]> = [["`", "~"], ["-", "_"], ["=", "+"], ["[", "{"], ["]", "}"], ["\\", "|"], [";", ":"],
  ["'", "\""], [",", "<"], [".", ">"], ["/", "?"], ["1", "!"], ["2", "@"], ["3", "#"], ["4", "$"], ["5", "%"], ["6", "^"], ["7", "&"], ["8", "*"],
  ["9", "("], ["0", ")"]];
const NAMED: ReadonlyArray<readonly [string, string]> = [[" ", "Space"], ["Escape", "Esc"], ["Delete", "Delete"], ["Backspace", "Backspace"],
  ["Enter", "Enter"], ["Tab", "Tab"], ["Home", "Home"], ["End", "End"], ["PageUp", "PageUp"], ["PageDown", "PageDown"], ["Insert", "Insert"],
  ["ArrowLeft", "←"], ["ArrowRight", "→"], ["ArrowUp", "↑"], ["ArrowDown", "↓"],
  ...Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, `F${index + 1}`] as const)];

export interface UsKeyPress {
  printed: string;
  event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };
}

/** Every key × every modifier combination; `command` "meta" presses Cmd where the printed combination says Ctrl. */
export function usKeyPresses(command: "ctrl" | "meta" = "ctrl"): UsKeyPress[] {
  const keys = [
    ..."abcdefghijklmnopqrstuvwxyz".split("").map(letter => ({ printed: letter.toUpperCase(), plain: letter, shifted: letter.toUpperCase() })),
    ...SYMBOLS.map(([plain, shifted]) => ({ printed: plain, plain, shifted })),
    ...NAMED.map(([key, printed]) => ({ printed, plain: key, shifted: key })),
  ];
  const presses: UsKeyPress[] = [];
  for (const key of keys) for (const ctrl of [false, true]) for (const alt of [false, true]) for (const shift of [false, true]) {
    const printed = [...(ctrl ? ["Ctrl"] : []), ...(alt ? ["Alt"] : []), ...(shift ? ["Shift"] : []), key.printed].join("+");
    presses.push({ printed, event: { key: shift ? key.shifted : key.plain, ctrlKey: ctrl && command === "ctrl", metaKey: ctrl && command === "meta", shiftKey: shift, altKey: alt } });
  }
  return presses;
}

/** A printed combination ("Ctrl+Shift+Z", "Shift+=") as the event the browser sends for it on a US keyboard. */
export function usKeyEvent(printed: string): UsKeyPress["event"] {
  const found = usKeyPresses().find(press => press.printed === printed);
  if (!found) throw new Error(`Not a US keyboard combination: ${printed}`);
  return found.event;
}

/** The printed form of a table combination (["Alt", "Shift", "←"]) in usKeyPresses' modifier order (Ctrl, Alt, Shift). */
export function printedCombo(combo: readonly string[]): string {
  const order = ["Ctrl", "Alt", "Shift"];
  return [...combo].sort((a, b) => (order.includes(a) ? order.indexOf(a) : 9) - (order.includes(b) ? order.indexOf(b) : 9)).join("+");
}
