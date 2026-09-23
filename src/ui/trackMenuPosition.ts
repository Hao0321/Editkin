export function trackMenuPosition(anchor: { left: number; top: number; bottom: number }, width: number, height: number) {
  const margin = 8;
  const menuWidth = Math.min(196, Math.max(0, width - margin * 2));
  const menuHeight = 146;
  const top = anchor.bottom + menuHeight + margin <= height ? anchor.bottom + 4 : anchor.top - menuHeight - 4;
  return {
    left: Math.max(margin, Math.min(anchor.left, width - menuWidth - margin)),
    top: Math.max(margin, Math.min(top, height - menuHeight - margin)),
    width: menuWidth,
    maxHeight: Math.max(0, height - margin * 2),
  };
}
