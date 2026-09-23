export type ProjectFormatId = "landscape" | "vertical" | "square" | "portrait" | "classic";

export interface ProjectFormat {
  id: ProjectFormatId;
  label: string;
  ratio: string;
  width: number;
  height: number;
  use: string;
}

export const PROJECT_FORMATS: readonly ProjectFormat[] = [
  { id: "landscape", label: "YouTube 橫式", ratio: "16:9", width: 1920, height: 1080, use: "YouTube 長片、電腦螢幕" },
  { id: "vertical", label: "Shorts／Reels", ratio: "9:16", width: 1080, height: 1920, use: "手機直式短影音" },
  { id: "square", label: "正方形", ratio: "1:1", width: 1080, height: 1080, use: "社群貼文、方形廣告" },
  { id: "portrait", label: "直式貼文", ratio: "4:5", width: 1080, height: 1350, use: "Instagram 動態牆" },
  { id: "classic", label: "經典橫式", ratio: "4:3", width: 1440, height: 1080, use: "簡報、復古影像" },
] as const;

export function projectFormatLabel(width: number, height: number): string {
  const known = PROJECT_FORMATS.find((format) => format.width === width && format.height === height);
  return known ? `${known.ratio} · ${known.label}` : `${width}:${height} · 自訂`;
}
