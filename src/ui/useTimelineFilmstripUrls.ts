import { useEffect, useMemo, useRef, useState } from "react";
import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import { generateTimelineThumbnail } from "./timelineThumbnailQueue";
import { createTimelineThumbnailLeases, type PreparedTimelineThumbnails } from "./timelineThumbnailLeases";
import { selectTimelineFilmstripSources } from "./timelineFilmstripSources";

/** Native derivatives win. Only current visible fallback sources hold transient URLs. */
export function useTimelineFilmstripUrls({ project, runtimeUrls, visibleClips, pixelsPerSecond, assetMap }: {
  project: EditProject;
  runtimeUrls: Record<string, string>;
  visibleClips: Map<string, TimelineClip[]>;
  pixelsPerSecond: number;
  assetMap?: ReadonlyMap<string, MediaAsset>;
}) {
  const assets = useMemo(() => assetMap ?? new Map(project.assets.map(asset => [asset.id, asset])), [assetMap, project.assets]);
  const sources = selectTimelineFilmstripSources(assets, runtimeUrls, visibleClips, pixelsPerSecond);
  const key = JSON.stringify([...sources].sort(([a], [b]) => a.localeCompare(b)));
  const [prepared, setPrepared] = useState<PreparedTimelineThumbnails>({});
  const leasesRef = useRef<ReturnType<typeof createTimelineThumbnailLeases> | undefined>(undefined);

  useEffect(() => {
    const leases = createTimelineThumbnailLeases({
      generate: generateTimelineThumbnail,
      revoke: url => URL.revokeObjectURL(url),
      publish: setPrepared,
    });
    leasesRef.current = leases;
    return () => {
      if (leasesRef.current === leases) leasesRef.current = undefined;
      leases.dispose();
    };
  }, []);

  useEffect(() => {
    const entries: Array<[string, string]> = JSON.parse(key);
    void leasesRef.current?.update(entries.map(([id, uri]) => ({ id, uri })));
  }, [key]);

  return Object.fromEntries([...sources].flatMap(([id, source]) =>
    prepared[id]?.source === source ? [[id, prepared[id].url]] : []));
}

