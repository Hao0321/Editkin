import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import type { ReferenceMotionTemplateInput, ReferenceMotionDesignSystem } from "../motion/referenceMotionTemplates";
import { parseProject } from "./projectCodec";
type Family = ReferenceMotionTemplateInput["templateId"];
// Original seventeen-family synthetic metadata/copy, duplicated only for new-version coverage; real fonts supplied by tests.
export const POSTER_FAMILIES_V3: Record<Family, { frames: number; extra: number; input: Partial<ReferenceMotionTemplateInput> }> = {
  strike_reframe: { frames: 330, extra: 0, input: { previousText: "來看蝙蝠", title: "其實是來看水簾", accentText: "水簾", subtitle: "名字叫蝙蝠洞，但現在已經沒有蝙蝠", tag: "沒有蝙蝠" } },
  comparison_pair: { frames: 150, extra: 1, input: { title: "同樣的皮 兩種做法", accentText: "兩種做法", primaryLabel: "紅油抄手 皮薄透餡", verdicts: ["good", "bad"] } },
  context_stack: { frames: 360, extra: 0, input: { title: "大溪老街 蔡記", accentText: "蔡記",
    items: [{ label: "現場手工做", detail: "鋪粉、壓條全程看得到" }, { label: "麥芽花生 一盒150" }, { label: "全台僅此一家", detail: "申明板寫別無分店" }] } },
  brand_recap: { frames: 420, extra: 0, input: { title: "龍騰斷橋", accentText: "斷橋",
    items: [{ label: "1907", detail: "紅磚拱橋完工" }, { label: "1935", detail: "關刀山大地震震斷" }, { label: "1999", detail: "九二一又斷一次" }, { label: "2003", detail: "列為縣定古蹟" }] } },
  level_bridge: { frames: 180, extra: 0, input: { title: "烏嘎彥竹林", accentText: "竹林", subtitle: "兩邊竹梢往中間彎，太陽從竹縫透進來" } },
  evidence_takeover: { frames: 300, extra: 0, input: { title: "現做麥芽花生糖", accentText: "麥芽花生糖", subtitle: "鋪粉、壓條全程看得到" } },
  focus_wall: { frames: 150, extra: 2, input: { title: "號稱平價版鼎泰豐", accentText: "鼎泰豐", primaryLabel: "紅油抄手" } },
  kinetic_network: { frames: 300, extra: 0, input: { title: "一句話剪成一支片", items: [{ label: "看懂素材" }, { label: "自動剪輯" }, { label: "動態模板" }],
    network: { seed: 32021, points: 32, labels: ["素材", "剪輯", "模板"], hubLabel: "一句話" } } },
  stat_reveal: { frames: 300, extra: 0, input: { title: "一週剪完三支片", accentText: "三支片",
    items: [{ label: "69%", detail: "時間花在挑素材" }, { label: "3 支", detail: "一週完成" }, { label: "NT$0", detail: "不另付費" }] } },
  statement_cut: { frames: 300, extra: 0, input: { title: "用一句話開始剪輯", items: [{ label: "看懂" }, { label: "剪好", detail: "一句話完成" }, { label: "上線" }] } },
  word_build: { frames: 240, extra: 0, input: { title: "你的下一支 影片", accentText: "影片", subtitle: "只要 一句話" } },
  stat_cycle: { frames: 330, extra: 0, input: { title: "一週的成果", items: [{ label: "3 支", detail: "長片完成" }, { label: "69%", detail: "時間花在挑素材" }, { label: "NT$0", detail: "不另付費" }] } },
  word_cycle: { frames: 240, extra: 0, input: { title: "在咖啡涼掉之前", items: [{ label: "剪好" }, { label: "配樂" }, { label: "上線" }] } },
  logo_end: { frames: 180, extra: 0, input: { title: "一句話開始剪輯", subtitle: "AI 剪輯工作室", kicker: "Editkin · Autopilot" } },
  ranked_list: { frames: 300, extra: 0, input: { title: "最常用的三個模板", accentText: "三個", primaryLabel: "使用次數",
    items: [{ label: "數據揭示", detail: "42" }, { label: "宣言快切", detail: "31" }, { label: "逐字標題", detail: "18" }] } },
  ui_demo: { frames: 300, extra: 0, input: { title: "輸出設定", kicker: "Editkin · 匯出", primaryLabel: "開始輸出", subtitle: "影片已輸出",
    items: [{ label: "動態模糊" }, { label: "畫面比例", detail: "9:16" }, { label: "影格率", detail: "30 fps" }] } },
  mark_open: { frames: 270, extra: 0, input: { title: "Hao0321 Studio", kicker: "AI 剪輯 · 2026", subtitle: "每一格都有理由" } },
};
const LABELS = ["再炸一盤 起泡翹邊", "蔥鹽雞", "炸餛飩"], WALL_LABELS = ["蔥鹽雞", "炸餛飩"];
export function graphicPosterFixtureV3(theme: ReferenceMotionDesignSystem, family: Family, options: { aspect?: number; style?: ReferenceMotionTemplateInput["style"]; landscape?: boolean } = {}) {
  const spec = POSTER_FAMILIES_V3[family], aspect = options.aspect ?? 9 / 16;
  const project = createEmptyProject("Synthetic design theme control", { id: `theme-${theme}-${family}`, width: options.landscape ? 1920 : 1080,
    height: options.landscape ? 1080 : 1920, fps: 30 });
  project.assets = Array.from({ length: spec.extra + 1 }, (_, index) => ({ id: `media-${index}`, name: `Synthetic source ${index}`, kind: "video" as const,
    uri: `D:/synthetic/theme-${index}.mov`, duration: 30, width: aspect < 1 ? 1080 : 1920, height: aspect < 1 ? 1920 : 1080, displayAspectRatio: aspect,
    color: { interpretation: "rec709" as const }, provenance: "Synthetic graph only; not a file, rights or footage-content verification" }));
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "media-0", timelineStart: 0, sourceStart: 1,
    duration: spec.frames / 30, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const input = { templateId: family, clipId: "primary", startFrame: 0, durationFrames: spec.frames, graphicCadence: "kinetic", intent: "shortform",
    designSystem: theme, kicker: "桃園復興｜三民蝙蝠洞", brandMark: "Hao0321 Studio", ...(options.style ? { style: options.style } : {}),
    sources: Array.from({ length: spec.extra }, (_, index) => ({ assetId: `media-${index + 1}`, sourceStart: 2, label: (family === "focus_wall" ? WALL_LABELS : LABELS)[index] })),
    evidenceRefs: ["synthetic:design-theme"], purpose: "Synthetic design theme control; no rendered art or ownership assertion", ...spec.input } as ReferenceMotionTemplateInput;
  return { project: parseProject(project), input };
}