import type { ReactNode } from "react";

/** Line icons for the Motion Library GUI, drawn in the easy flow's 24-unit, 2-px stroke style. Decorative: always beside words. */
const ICONS = {
  motion: <><path d="M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7z" /><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></>,
  text: <><path d="M5 6.5V5h14v1.5" /><path d="M12 5v14" /><path d="M9 19h6" /></>,
  transition: <><rect x="3" y="6" width="10" height="12" rx="2" /><path d="M13 9h6a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-6" strokeDasharray="2 2.2" /><path d="M9 12h8M14.5 9.5 17 12l-2.5 2.5" /></>,
  background: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 10h18M3 15h18M9 4v16M15 4v16" strokeOpacity=".55" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  shuffle: <><path d="M4 7h3.5c2 0 3 1 4.2 3l1.6 3c1.1 2 2.2 3 4.2 3H20" /><path d="M4 16h3.5c1.4 0 2.3-.5 3.1-1.4M13.4 8.4C14.2 7.5 15.1 7 16.5 7H20" /><path d="M17.5 4.5 20 7l-2.5 2.5M17.5 13.5 20 16l-2.5 2.5" /></>,
  dissolve: <><circle cx="9" cy="12" r="5.5" /><circle cx="15" cy="12" r="5.5" strokeOpacity=".55" /></>,
  dip: <><rect x="3" y="6" width="7" height="12" rx="1.5" /><rect x="14" y="6" width="7" height="12" rx="1.5" /><path d="M10 12h4" strokeWidth="3" /></>,
  trash: <><path d="M4 7h16" /><path d="M9.5 7V4.5h5V7" /><path d="M6 7l1 13h10l1-13" /></>,
  play: <path d="M8 5.5v13l10-6.5z" />,
  pause: <><path d="M8.5 5.5v13M15.5 5.5v13" /></>,
  diamond: <path d="M12 4l8 8-8 8-8-8z" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  target: <><circle cx="12" cy="12" r="7.5" /><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" /></>,
} satisfies Record<string, ReactNode>;

export type MotionLibraryIconNameV1 = keyof typeof ICONS;

export function MotionLibraryIcon({ name, size = 16, className }: { name: MotionLibraryIconNameV1; size?: number; className?: string }) {
  return <svg className={className ? `ml-icon ${className}` : "ml-icon"} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{ICONS[name]}</svg>;
}
