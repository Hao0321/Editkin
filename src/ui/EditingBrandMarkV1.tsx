import type { EditorTheme } from "./theme";
import skyBrand from "../../public/brand/editkin-symbol-v3-sky.webp?url";
import candyBrand from "../../public/brand/editkin-symbol-v3-candy.webp?url";
import voltBrand from "../../public/brand/editkin-symbol-v3-volt.webp?url";

/** Reuse the authored artwork in every editor layout; no glyph or CSS pseudo-element substitutes. */
export function EditingBrandMarkV1({ theme }: { theme: EditorTheme }) {
  const source = theme === "candy" ? candyBrand : theme === "volt" ? voltBrand : skyBrand;
  return <img className="brand-mark editing-brand-image" src={source}
    width="44" height="44" alt="Editkin" draggable={false} decoding="sync" />;
}
