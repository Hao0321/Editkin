import { EXPORT_FEATURE_REFUSAL_CODE_V1, EXPORT_REFUSAL_MESSAGES_V1, type ExportRefusalParamsV1 } from "../../render/exportFeatureRefusalV1";
import { interfacePreferences, translateUi, translateUiStatus, type UiLocale } from "./interfacePreferences";

/**
 * Export refusals in the interface language (2026-10-23). A refusal (src/render/exportFeatureRefusalV1.ts) carries a
 * zh-TW template as its message key plus parameters; the templates and the interface-text parameter values are in
 * interfaceMessages.97.ts. `t(key, params)` fills the placeholders; the parameters that are interface text are
 * translated first: {feature}, each name in {fields} (joined with 、 in zh-TW) and {route}. Clip, mask and
 * composition names and numbers are the user's own content and pass through unchanged.
 */
type Translate = (source: string, values?: Readonly<Record<string, string | number>>) => string;

const LIST_SEPARATOR: Readonly<Record<UiLocale, string>> = { "zh-TW": "、", en: ", ", es: ", ", ja: "、", ko: ", " };
const currentLocale = (): UiLocale => interfacePreferences.getSnapshot().locale;

/** One parameter value in the interface language. */
export function localizeExportRefusalParamV1(name: string, value: string | number, translate: Translate = translateUi, locale: UiLocale = currentLocale()): string | number {
  if (typeof value !== "string") return value;
  if (name === "feature") return translate(value);
  if (name === "fields") return value.split("、").map(field => translate(field)).join(LIST_SEPARATOR[locale] ?? ", ");
  if (name === "route") {
    const aces = /^ACES 2 (.+)$/.exec(value);
    return aces ? translate("ACES 2 {transform}", { transform: aces[1] }) : translate(value);
  }
  return value;
}

/** A refusal error (or its key and parameters) as interface text. */
export function translateExportRefusalV1(refusal: { readonly messageKey: string; readonly params: ExportRefusalParamsV1 }, translate: Translate = translateUi,
  locale: UiLocale = currentLocale()): string {
  const params = Object.fromEntries(Object.entries(refusal.params).map(([name, value]) => [name, localizeExportRefusalParamV1(name, value, translate, locale)]));
  return translate(refusal.messageKey, params);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Each template as a pattern over the end of a text: group 1 is whatever precedes the refusal (a status or error
 * prefix), then the template's parameters; a repeated placeholder must repeat the same value.
 */
const TEMPLATE_PATTERNS = Object.values(EXPORT_REFUSAL_MESSAGES_V1).map(template => {
  const names: string[] = [];
  const source = template.split(/(\{[A-Za-z]+\})/g).map(part => {
    const placeholder = /^\{([A-Za-z]+)\}$/.exec(part);
    if (!placeholder) return escapeRegExp(part);
    const seen = names.indexOf(placeholder[1]);
    if (seen >= 0) return `\\${seen + 2}`;
    names.push(placeholder[1]);
    return "(.+?)";
  }).join("");
  return { template, names, expression: new RegExp(`^(.*?)${source}$`, "s") };
});
const REFUSAL_CODE = new RegExp(`（(${EXPORT_FEATURE_REFUSAL_CODE_V1}/[^）]*)）`);

/**
 * The export refusal inside `text` in the interface language, or undefined when the text carries none. `text` is
 * what reaches the interface after an export failed (an error message, a status line, a problem's raw reason): the
 * error's filled zh-TW template, possibly after a prefix, normally followed by its `（EXPORT_FEATURE_REFUSED/…）`
 * code. The prefix, the code and anything after the code are kept as they are.
 */
export function translateExportRefusalInTextV1(text: string, translate: Translate = translateUi, locale: UiLocale = currentLocale()): string | undefined {
  // Every refusal template says 尚未支援; anything else is not worth thirteen pattern tests.
  if (!text.includes("尚未支援")) return undefined;
  const code = REFUSAL_CODE.exec(text);
  const body = code ? text.slice(0, code.index) : text, rest = code ? text.slice(code.index + code[0].length) : "";
  for (const pattern of TEMPLATE_PATTERNS) {
    const match = pattern.expression.exec(body);
    if (!match) continue;
    const params = Object.fromEntries(pattern.names.map((name, index) => [name, match[index + 2]]));
    const translated = translateExportRefusalV1({ messageKey: pattern.template, params }, translate, locale);
    const tag = !code ? "" : locale === "zh-TW" || locale === "ja" ? `（${code[1]}）` : ` (${code[1]})`;
    return `${match[1]}${translated}${tag}${rest}`;
  }
  return undefined;
}

/** A status or error text for display: its export refusal translated; any other text through translateUiStatus. */
export function translateExportRefusalTextV1(text: string, translate: Translate = translateUi, locale: UiLocale = currentLocale()): string {
  return translateExportRefusalInTextV1(text, translate, locale) ?? translateUiStatus(text);
}

/** A raw reason for 「查看原因」: its export refusal translated; any other text exactly as it was. */
export function localizeExportRefusalReasonV1(text: string): string {
  return translateExportRefusalInTextV1(text) ?? text;
}
