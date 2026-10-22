import { createDemoProject } from "../domain/demo";
export function trackSoloFixture(videoPath = "D:/editkin-owned-fixture/video.mp4", audioPath = "D:/editkin-owned-fixture/voice.wav") {
  const project = createDemoProject(); project.captions = []; project.motionGraphics = []; project.director.markers = [];
  project.width = 320; project.height = 180;
  const video = project.assets[0]; video.uri = videoPath; video.width = 320; video.height = 180;
  const clip = project.tracks[0].clips[0]; clip.duration = 3; clip.sourceStart = 1; clip.volume = .4;
  const soundTrack = project.tracks.find(track => track.kind === "audio")!;
  const audio = { ...video, id: "solo-tone", name: "Owned solo tone", kind: "audio" as const, role: "dialogue", uri: audioPath };
  project.assets.push(audio);
  soundTrack.clips = [{ ...structuredClone(clip), id: "solo-sound", assetId: audio.id, trackId: soundTrack.id }];
  return project;
}
