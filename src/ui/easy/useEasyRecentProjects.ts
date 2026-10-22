import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PROBLEM_WHAT } from "../../application/plainProblems";
import type { RecentProject } from "../../desktop/recentProjects";
import { EASY_RECENT_LIMIT, easyRecentItems, type EasyRecentProjects, type EasyRecentRowState, type EasyRecentView } from "./easyRecentProjects";

const NO_PROJECTS: readonly RecentProject[] = [];
const noProjects = () => NO_PROJECTS;
const noSubscription = () => () => undefined;

const without = <T,>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  const next = { ...record };
  delete next[key];
  return next;
};
const withPath = (set: ReadonlySet<string>, path: string, present: boolean): ReadonlySet<string> => {
  if (set.has(path) === present) return set;
  const next = new Set(set);
  if (present) next.add(path); else next.delete(path);
  return next;
};

/**
 * The start screen's recent list: the stored projects, which files are gone (checked when the screen shows and when
 * the window comes back to the front) and opening one project at a time. Undefined when there is nothing to show.
 */
export function useEasyRecentProjects(recent: EasyRecentProjects | undefined, active: boolean): EasyRecentView | undefined {
  const list = useSyncExternalStore(recent?.subscribe ?? noSubscription, recent?.list ?? noProjects, recent?.list ?? noProjects);
  const [rows, setRows] = useState<Readonly<Record<string, EasyRecentRowState>>>({});
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const [announced, setAnnounced] = useState<ReadonlySet<string>>(() => new Set());
  const opening = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const paths = useMemo(() => list.slice(0, EASY_RECENT_LIMIT).map(item => item.path), [list]);
  useEffect(() => {
    const exists = recent?.exists;
    if (!exists || !active || !paths.length) return;
    let current = true;
    const check = () => {
      void exists(paths).then(found => {
        if (current) setMissing(new Set(paths.filter((_, index) => found[index] === false)));
      }, () => undefined);
    };
    check();
    window.addEventListener("focus", check);
    return () => { current = false; window.removeEventListener("focus", check); };
  }, [recent, active, paths]);

  const now = useMemo(() => Date.now(), [list, active]);
  const items = useMemo(() => easyRecentItems(list, { rows, missing, announced }), [list, rows, missing, announced]);
  if (!recent || !items.length) return undefined;

  const fail = (path: string, what: string, detail?: string) => {
    setRows(current => ({ ...current, [path]: { state: "failed", problem: { what, ...(detail ? { detail } : {}) } } }));
    setAnnounced(current => withPath(current, path, true));
  };
  const onOpen = (path: string) => {
    if (opening.current) return;
    opening.current = path;
    setRows(current => ({ ...current, [path]: { state: "opening" } }));
    void recent.open(path).then(outcome => {
      if (!mounted.current) return;
      if (outcome.kind === "failed") { fail(path, outcome.what, outcome.detail); return; }
      setRows(current => without(current, path));
      if (outcome.kind === "missing") {
        setMissing(current => withPath(current, path, true));
        setAnnounced(current => withPath(current, path, true));
      }
    }, (error: unknown) => {
      if (mounted.current) fail(path, PROBLEM_WHAT.unknown, error instanceof Error ? error.message : String(error));
    }).finally(() => { if (opening.current === path) opening.current = undefined; });
  };
  const onForget = (path: string) => {
    recent.forget(path);
    setRows(current => without(current, path));
    setMissing(current => withPath(current, path, false));
    setAnnounced(current => withPath(current, path, false));
  };
  return { items, busy: items.some(item => item.state === "opening"), now, onOpen, onForget };
}
