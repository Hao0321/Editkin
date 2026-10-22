import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPLATE_FOLLOW_HINT_DELAY_MS, trackTemplateFollow } from "../application/templateFollowProgress";

// The production component called with a hook double that keeps refs between renders (no mounted DOM here); the store,
// the plain-status words and the translations are the real ones.
const hooks = vi.hoisted(() => ({ refs: [] as { current: unknown }[], index: 0 }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    // Each useRef call takes the next slot, in the component's own order, and keeps it between renders.
    useRef: (value: unknown) => { const index = hooks.index++; return hooks.refs[index] ?? (hooks.refs[index] = { current: value }); },
    useMemo: (make: () => unknown) => make(),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  };
});
import { OperationStatus } from "./OperationStatus";

type Props = Record<string, unknown> & { children?: ReactNode };
function find(node: ReactNode, predicate: (props: Props) => boolean): Props | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } return undefined; }
  if (!isValidElement<Props>(node)) return undefined;
  if (predicate(node.props)) return node.props;
  return node.props.children ? find(node.props.children, predicate) : undefined;
}
/** The status line's words for one render with `status`. */
function shown(status: string): string {
  hooks.index = 0;
  const tree = OperationStatus({ status, runtimeInfo: "本機編輯" }) as ReactNode;
  const message = find(tree, props => props["data-testid"] === "operation-status-message");
  return String(message?.children);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => { vi.useFakeTimers(); hooks.refs = []; });
afterEach(() => { vi.useRealTimers(); });

describe("the status line while a title template follows a clip edit", () => {
  it("says 「標題跟著調整中…」 only after a moment, and the result replaces it", async () => {
    const before = "已選取片段。";
    expect(shown(before)).toBe(before);
    const work = deferred<boolean>(), tracked = trackTemplateFollow(work.promise);
    expect(shown(before)).toBe(before);
    vi.advanceTimersByTime(TEMPLATE_FOLLOW_HINT_DELAY_MS - 1);
    expect(shown(before)).toBe(before);
    vi.advanceTimersByTime(1);
    expect(shown(before)).toBe("標題跟著調整中…");
    work.resolve(true);
    await tracked;
    const done = "已在 5.00 秒切開片段，標題模板留在前一段，照新的長度重新排好；一次復原即可還原。";
    expect(shown(done)).toBe(done);
  });

  it("goes away at once when a newer message arrives (an Undo), even while the follow is still finishing", async () => {
    const work = deferred<boolean>(), tracked = trackTemplateFollow(work.promise);
    expect(shown("已選取片段。")).toBe("已選取片段。");
    vi.advanceTimersByTime(TEMPLATE_FOLLOW_HINT_DELAY_MS);
    expect(shown("已選取片段。")).toBe("標題跟著調整中…");
    expect(shown("已復原上一步。")).toBe("已復原上一步。");
    work.resolve(false);
    await tracked;
    expect(shown("專案剛剛有變更，這次切開沒有套用；請再試一次。")).toBe("專案剛剛有變更，這次切開沒有套用；請再試一次。");
  });

  it("never flashes for a fast edit", async () => {
    const work = deferred<boolean>(), tracked = trackTemplateFollow(work.promise);
    expect(shown("已選取片段。")).toBe("已選取片段。");
    vi.advanceTimersByTime(100);
    work.resolve(true);
    await tracked;
    vi.advanceTimersByTime(TEMPLATE_FOLLOW_HINT_DELAY_MS);
    expect(shown("已選取片段。")).toBe("已選取片段。");
  });
});
