import type { ReactNode } from "react";

/** Original line icons for the easy flow. Decorative: every icon sits beside visible words. */
const ICONS = {
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /><path d="M10.5 8.5v5l4-2.5z" /></>,
  screen: <><rect x="2.5" y="4.5" width="19" height="12.5" rx="2" /><path d="M8.5 20.5h7" /><path d="M10.5 8.25v5l4-2.5z" /></>,
  "folder-plus": <><path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 11v5M9.5 13.5h5" /></>,
  suitcase: <><rect x="3.5" y="7.5" width="17" height="12" rx="2" /><path d="M9 7.5v-2A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5v2" /><path d="M3.5 12.5h17" /></>,
  bowl: <><path d="M3 11h18a9 7.5 0 0 1-18 0z" /><path d="M9 8c0-1.5 1.2-1.5 1.2-3M13.5 8c0-1.5 1.2-1.5 1.2-3" /></>,
  book: <><path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5z" /><path d="M12 6.5v13" /></>,
  box: <><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></>,
  gamepad: <><path d="M7 7.5h10a4.5 4.5 0 0 1 4.4 5.5l-1 4.2a2.4 2.4 0 0 1-4.1 1.1L14 16.5h-4l-2.3 1.8a2.4 2.4 0 0 1-4.1-1.1l-1-4.2A4.5 4.5 0 0 1 7 7.5z" /><path d="M8 10.5v3.5M6.25 12.25h3.5" /><path d="M15.5 11.25h.01M17.5 13.25h.01" /></>,
  cup: <><path d="M4.5 9.5h12v5a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5z" /><path d="M16.5 11h1.5a2.5 2.5 0 0 1 0 5h-1.6" /><path d="M8.5 3.5c0 1.5-1 1.5-1 3M12.5 3.5c0 1.5-1 1.5-1 3" /></>,
  sparkles: <><path d="M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7z" /><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></>,
  "arrow-left": <path d="M19 12H5M11 6l-6 6 6 6" />,
  "arrow-right": <path d="M5 12h14M13 6l6 6-6 6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  pencil: <><path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z" /><path d="M14 7.5l3 3" /></>,
  palette: <><path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-1 1.6-2.2-.5-1.4.4-2.3 1.8-2.3H18a2.5 2.5 0 0 0 2.5-2.5A8.5 8.5 0 0 0 12 3.5z" /><path d="M7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01" /></>,
  save: <><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" /><path d="M4 15.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.5" /></>,
  "folder-open": <><path d="M3.5 18V7a2 2 0 0 1 2-2H9l2 2.5h6a2 2 0 0 1 2 2V11" /><path d="M3.5 18l2.6-6.2A1.5 1.5 0 0 1 7.5 11h13a1 1 0 0 1 .9 1.4L19 18.6a1.5 1.5 0 0 1-1.4.9H5a1.5 1.5 0 0 1-1.5-1.5z" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  scissors: <><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="6.5" cy="17.5" r="2.5" /><path d="M8.6 8 20 18M8.6 16 20 6" /></>,
  split: <><rect x="2.5" y="8" width="6.5" height="8" rx="1.5" /><rect x="15" y="8" width="6.5" height="8" rx="1.5" /><path d="M12 7v14" /><path d="M9.5 3.5h5L12 7z" /></>,
  pointer: <path d="M6 3v16l4-4 3 6.2 2.6-1.2-3-6.1 5.9-.5z" />,
  trash: <><path d="M4 7h16" /><path d="M9.5 7V4.5h5V7" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v5.5M14 11v5.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5h.01" /></>,
  alert: <><path d="M12 3.5 2.5 20h19z" /><path d="M12 10v4.5M12 17.5h.01" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4.5h-4.5" /></>,
  sliders: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  play: <path d="M8 5.5v13l10-6.5z" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  captions: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M7 11h10M7 15h4M13 15h4" /></>,
  music: <><path d="M9 17.5V6l10-2.5v11.5" /><circle cx="6.5" cy="17.5" r="2.5" /><circle cx="16.5" cy="15" r="2.5" /></>,
  link: <><path d="m10 13 4-4" /><path d="M8.5 15.5 7 17a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0M15.5 8.5 17 7a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" /></>,
  circle: <circle cx="12" cy="12" r="7" />,
} satisfies Record<string, ReactNode>;

export type EasyIconName = keyof typeof ICONS;

export function EasyIcon({ name, className, size }: { name: EasyIconName; className?: string; size?: number }) {
  return <svg className={className ? `easy-icon ${className}` : "easy-icon"} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    style={size === undefined ? undefined : { width: size, height: size, display: "inline", verticalAlign: "-.125em", marginRight: 4 }}
    fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{ICONS[name]}</svg>;
}
