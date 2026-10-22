import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ColorGradeClipboardPanelV1 } from "./ColorGradeClipboardPanelV1";
import { colorGradeClipboardActionsV1 } from "./colorGradeClipboardActionsV1";
type Element = ReactElement<Record<string, any>>;
function all(node: ReactNode): Element[] { if (Array.isArray(node)) return node.flatMap(all); if (!isValidElement(node)) return []; const e = node as Element; return [e, ...all(e.props.children)]; }
describe("explicit current-frame clipboard controls", () => {
  it("keeps copy read-only, disables unavailable paste and explains replacing color keyframes", () => {
    const copy = vi.fn(), paste = vi.fn(), element = ColorGradeClipboardPanelV1({ state: { hasCopy: false }, canPaste: false, onCopy: copy, onPaste: paste }), items = all(element);
    items.find(e => e.props['data-testid'] === 'grade-copy-current')!.props.onClick(); expect(copy).toHaveBeenCalledTimes(1); expect(paste).not.toHaveBeenCalled();
    expect(items.find(e => e.props['data-testid'] === 'grade-paste-current')!.props.disabled).toBe(true); expect(renderToStaticMarkup(element)).toContain("色彩關鍵幀");
  });
  it("preserves the user's source filename and sampled clip time", () => {
    const html = renderToStaticMarkup(<ColorGradeClipboardPanelV1 state={{ hasCopy: true, sourceName: "作者原文片名", localTime: 1.25 }} canPaste onCopy={() => {}} onPaste={() => {}} />);
    expect(html).toContain("作者原文片名"); expect(html).toContain("1.25");
  });
  it("does not run a command for copying and uses the atomic paste plan", () => {
    const command = { type: 'paste_clip_grade_v1', clipId: 'target' }, clipboard = { copy: vi.fn(), planPaste: vi.fn(() => command) }, run = vi.fn(), status = vi.fn();
    const actions = colorGradeClipboardActionsV1(clipboard as any, 'target', 1.5, run, status); actions.onCopy(); expect(clipboard.copy).toHaveBeenCalledWith('target', 1.5); expect(run).not.toHaveBeenCalled();
    actions.onPaste(); expect(run).toHaveBeenCalledExactlyOnceWith(command, "已貼上調色，可一次復原。");
  });
});
