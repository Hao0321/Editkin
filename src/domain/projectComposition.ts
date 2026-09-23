import type { EditComposition, EditProject, MediaAsset } from "./types";

export function projectFromComposition(
  root: EditProject,
  composition: EditComposition,
  assets: MediaAsset[] = root.assets,
  compositions: EditComposition[] = root.compositions,
): EditProject {
  return {
    schemaVersion: 8,
    revision: root.revision,
    id: `${root.id}:composition:${composition.id}`,
    name: composition.name,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    editorialProfile: root.editorialProfile,
    aestheticSystem: root.aestheticSystem,
    colorManagement: composition.colorManagement ?? root.colorManagement,
    scene25d: composition.scene25d,
    particleSimulation: composition.particleSimulation,
    assets: structuredClone(assets),
    compositions: structuredClone(compositions),
    tracks: structuredClone(composition.tracks),
    captions: structuredClone(composition.captions),
    captionStyle: structuredClone(composition.captionStyle),
    motionTracks: structuredClone(composition.motionTracks),
    motionGraphics: structuredClone(composition.motionGraphics),
    director: structuredClone(composition.director),
    updatedAt: composition.updatedAt,
  };
}
