import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Mesh3dGeometryCache, parseMesh3dFont } from "./mesh3dGeometry";
import { renderMesh3dFrame, type Mesh3dFrame, type Mesh3dTexture } from "./mesh3dRasterizer";
import { renderMesh3dProjectFrameV1 } from "./mesh3dProjectFrameV1";
import type { Mesh3dObject, Mesh3dScene, Mesh3dSegment } from "./mesh3dScene";
import { mesh3dTemplateSegment, MESH_3D_TEMPLATES } from "../application/mesh3dTemplates";

/**
 * Byte-identity corpus for scenes written before the mesh3d engine extension
 * (2026-10-23). The hashes were captured from the unmodified engine at HEAD
 * 89142e9; every legacy scene must keep rendering exactly these bytes.
 */
const FONT_ROOT = join(import.meta.dirname, "../../public/fonts/render");
const font = (weight: 700 | 900) => { const bytes = readFileSync(join(FONT_ROOT, `EditkinFace-noto-sans-tc-${weight}.ttf`)); return parseMesh3dFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); };
const pose = (position: [number, number, number], rotationDegrees: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]) => ({ position, rotationDegrees, scale });
const camera = (position: [number, number, number], target: [number, number, number] = [0, 0, 0], verticalFovDegrees = 50) => ({ position, target, verticalFovDegrees, near: .1, far: 40 });

function texture(width: number, height: number): Mesh3dTexture {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4; rgba[p] = (x * 37) & 255; rgba[p + 1] = (y * 53) & 255; rgba[p + 2] = ((x ^ y) * 29) & 255; rgba[p + 3] = 255;
  }
  return { width, height, rgba };
}
function primitives(): Mesh3dObject[] {
  return [
    { id: "box", name: "box", geometry: { kind: "box", width: 1, height: .8, depth: .6 }, pose: pose([-1.2, .4, 0], [20, 30, 5]), material: { color: "#2E90FA", unlit: false },
      keyframes: [{ time: .5, pose: pose([-1, .2, .3], [40, 80, 0]), easing: "smooth" }, { time: 1, pose: pose([-.8, .3, 0], [40, 120, 10], [1.2, 1, 1]), easing: "linear" }, { time: 1.5, pose: pose([-.8, .3, 0]), easing: "hold" }] },
    { id: "sphere", name: "sphere", geometry: { kind: "sphere", radius: .55, segments: 24 }, pose: pose([1.1, .3, -.4]), material: { color: "#F04438", unlit: false }, keyframes: [] },
    { id: "torus", name: "torus", geometry: { kind: "torus", radius: .7, tube: .12, segments: 40 }, pose: pose([0, -.6, .2], [70, 0, 0]), material: { color: "#12B76A", unlit: false, doubleSided: true }, keyframes: [] },
    { id: "floor", name: "floor", geometry: { kind: "box", width: 6, height: .05, depth: 6 }, pose: pose([0, -1.4, 0]), material: { color: "#F8FAFF", unlit: true, grid: true }, keyframes: [] },
    { id: "screen", name: "screen", geometry: { kind: "curved_video", radius: 3, width: 2, height: 1.2, segments: 24 }, pose: pose([0, .9, -1.2], [0, 10, 0]), material: { color: "#FFFFFF", unlit: true, clipId: "clip" }, keyframes: [] },
    { id: "near", name: "near", geometry: { kind: "box", width: 2, height: .3, depth: 6 }, pose: pose([.6, -1, 2.5], [0, 15, 0]), material: { color: "#7A5AF8", unlit: false }, keyframes: [] },
  ];
}
function segment(id: string, start: number, objects: Mesh3dObject[]): Mesh3dSegment {
  return { id, name: id, timelineStart: start, duration: 2, camera: camera([.4, .6, 5.2]), objects,
    cameraKeyframes: [{ time: 1, camera: camera([1.4, 1, 4.6], [0, .1, 0], 56), easing: "smooth" }, { time: 2, camera: camera([1.4, 1, 4.6], [0, .1, 0], 56), easing: "hold" }] };
}
function scenes(): Record<string, Mesh3dScene> {
  const base = (grid: boolean, segments: Mesh3dSegment[]): Mesh3dScene => ({ schema: "editkin.mesh-scene/v1", enabled: true,
    background: { color: "#0B1220", gridColor: "#22324F", spacing: 64, grid }, light: { direction: [-.4, .7, 1], ambient: .45, intensity: .8 }, segments });
  const text: Mesh3dObject = { id: "title", name: "title", geometry: { kind: "text", text: "實體字A", fontFamily: "Noto Sans TC", fontWeight: 900, height: .5, depth: .12, bevel: .01 },
    pose: pose([0, 1.4, .4], [8, -12, 0]), material: { color: "#175CD3", unlit: false }, keyframes: [] };
  const light: Mesh3dObject = { ...text, id: "light", geometry: { kind: "text", text: "細", fontFamily: "Noto Sans TC", fontWeight: 700, height: .4, depth: .05, bevel: 0 }, pose: pose([1.5, 1.4, 0]) };
  return {
    primitives: base(true, [segment("a", 0, primitives())]),
    primitivesNoGrid: base(false, [segment("a", 0, [...primitives(), text, light])]),
    ...Object.fromEntries(MESH_3D_TEMPLATES.map(t => [t.id, { schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#FFFFFF", gridColor: "#E0EAF8", spacing: 72, grid: true },
      light: { direction: [-.4, .7, 1], ambient: .68, intensity: .36 }, segments: [mesh3dTemplateSegment(t.id, "clip", 0, 4, "真實素材")] } satisfies Mesh3dScene])),
  };
}
const sha = (bytes: ArrayBufferView) => createHash("sha256").update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex").slice(0, 24);
const digest = (frame: Mesh3dFrame) => [sha(frame.rgba), sha(frame.depth), frame.depthPrecise ? sha(frame.depthPrecise) : "-", frame.triangleCount, frame.rasterizedTriangles].join(":");

export function legacyCorpusDigests(): Record<string, string> {
  const cache = new Mesh3dGeometryCache(new Map([[700, font(700)], [900, font(900)]])), textures = new Map([["clip", texture(64, 36)]]);
  const out: Record<string, string> = {};
  for (const [name, scene] of Object.entries(scenes())) {
    for (const [width, height] of [[96, 54], [270, 480], [405, 720]]) for (const time of [0, .37, 1.25, 3.9]) {
      out[`${name}@${width}x${height}@${time}`] = digest(renderMesh3dFrame(scene, time, width, height, cache, textures));
    }
    out[`${name}@precise`] = digest(renderMesh3dFrame(scene, .8, 180, 320, cache, textures, { depthPrecision: "float64" }));
  }
  const overlay = scenes().primitives;
  overlay.overlaysV1 = { schema: "editkin.mesh-overlays/v1", anchors: [{ id: "anchor", segmentId: "a", objectId: "sphere", localPoint: [0, 0, .55] }],
    layers: [{ id: "label", anchorId: "anchor", clipId: "clip", size: [.2, .1], offset: [0, -.05], pivot: [.5, 1], opacity: .9, occlusion: "depth_test" }] };
  out.overlay = digest(renderMesh3dProjectFrameV1(overlay, { timelineFrame: 21, fps: 30 }, 270, 480, cache, textures));
  return out;
}

const GOLDEN: Record<string, string> = {
  "primitives@96x54@0": "5187d5b3acac8c8d67c99a51:60541e7ddcedc34069302cae:-:1588:869",
  "primitives@96x54@0.37": "ea1becf3e1bb04005b8437bf:d357a977cdd2b16d5b3bdc35:-:1588:850",
  "primitives@96x54@1.25": "be1e6cec85a8f969a6fe2638:40edd14b9df56e144ea40e81:-:1588:805",
  "primitives@96x54@3.9": "75b6b26c2d02427eca1fcb31:b65081345116e88bd72c6460:-:1588:804",
  "primitives@270x480@0": "c81e090cac37934595314efa:4b51bd91758ac3581e142930:-:1588:1243",
  "primitives@270x480@0.37": "a9d6a98ba0cb8cd8abe6c7ef:4a07311b2154cddf1dc1c7b9:-:1588:1245",
  "primitives@270x480@1.25": "e2273e8980fcc11f52fe7fa8:bbe838437d47333a36f9107d:-:1588:1246",
  "primitives@270x480@3.9": "8c4ec385ccf49a53f60b7c32:2516ccb19495fdd24238eab8:-:1588:1246",
  "primitives@405x720@0": "fa762143c0feecc627eff82b:df6a86193d4fbae629dadad7:-:1588:1245",
  "primitives@405x720@0.37": "68bbf6255791e6d9bc2ed587:cc6a8a5643dfd17b35250525:-:1588:1247",
  "primitives@405x720@1.25": "dc309e879238dd45c0fe4ed5:5f4457e4b3334feb02b2afaa:-:1588:1247",
  "primitives@405x720@3.9": "15f0ae1cc543de0af6ad6faa:06c31294515e29ee457f062c:-:1588:1247",
  "primitives@precise": "0c41bb59939561aa80c0d8be:835871f3ca9496482dddd94f:21eaface8e205b96cc66d129:1588:1249",
  "primitivesNoGrid@96x54@0": "9cc24e21861d360c88798ff1:0c5c2880e0d29543355410e6:-:5552:1152",
  "primitivesNoGrid@96x54@0.37": "53919b8f0afa53f1809cc746:45ea5e130bf5a9d0855c71ba:-:5552:1119",
  "primitivesNoGrid@96x54@1.25": "b8efe253bb04ede76708af51:ac3d209339a17a32b58f7d1e:-:5552:1131",
  "primitivesNoGrid@96x54@3.9": "71ecaab0abec7305d188ab52:b1c67b82eed01e60c0018248:-:5552:1130",
  "primitivesNoGrid@270x480@0": "518fbe32d985badb80e475ae:5ea0907d948c259ce8b74471:-:5552:2584",
  "primitivesNoGrid@270x480@0.37": "89724255399922b5b7cc245e:ca57e70519d08998741d077c:-:5552:2597",
  "primitivesNoGrid@270x480@1.25": "ae8d764a884551601ebb26b7:4dc3453b44e89d16a43a438a:-:5552:2683",
  "primitivesNoGrid@270x480@3.9": "30863d2ec39d3f19b99d48f4:56f59661d5615fa5d0c42de7:-:5552:2683",
  "primitivesNoGrid@405x720@0": "c80ba9c1b9c75ee4d8241b3e:ad8324c1606bd0158407238e:-:5552:2727",
  "primitivesNoGrid@405x720@0.37": "495e2b48fca9a73b40c9fe77:5b1384e947b61ef1a56143df:-:5552:2724",
  "primitivesNoGrid@405x720@1.25": "ce1aa163c8e23d8a68b3424b:f99e9355a01aa4499a4efa9a:-:5552:2759",
  "primitivesNoGrid@405x720@3.9": "286581f6cc850ae9fc62fd1a:373cb92828c5be717b37b8ab:-:5552:2759",
  "primitivesNoGrid@precise": "cc2ed14fec81fdc8e93c7295:0f21dbc0cdd3c39f98c58fcd:1f1a5ecbf278bad8104b1ec1:5552:2421",
  "curved_video_orbit@96x54@0": "fafb75d386524e090abaff38:9a61329cda014bd975fed01f:-:6000:769",
  "curved_video_orbit@96x54@0.37": "07b00fb7791f7b4207f564ae:366909ced83615e39bd5c31b:-:6000:761",
  "curved_video_orbit@96x54@1.25": "21aab83954885f9938d2a51c:cfc5812eaeca947be04583d5:-:6000:752",
  "curved_video_orbit@96x54@3.9": "6ed0fd94628de458330ac48c:f3d8ac49c7fe337a9940e095:-:6000:754",
  "curved_video_orbit@270x480@0": "32a87539faa437c939775d0a:dc5417cfca4e1029b3c2af42:-:6000:2504",
  "curved_video_orbit@270x480@0.37": "6e604c624906a5c9fbb2fb7c:88b9285cf0f41fff4f058bd2:-:6000:2501",
  "curved_video_orbit@270x480@1.25": "74e5ee112088a871ecb3f5af:058f3d2089bf0aa8b088b3d8:-:6000:2502",
  "curved_video_orbit@270x480@3.9": "4d7b0854f3fc107e6b35a0af:0c63e7a83a2cb4fc57f7c0ba:-:6000:2529",
  "curved_video_orbit@405x720@0": "086d37d7718b52a256aea3ea:6842adfb5f701bb29b1a0424:-:6000:2837",
  "curved_video_orbit@405x720@0.37": "1b595c99c8afa94a38f93c9c:17905b86e1b143b7c164d958:-:6000:2868",
  "curved_video_orbit@405x720@1.25": "7f4cbb61327b60b91d1c7244:9fa364634beb72da389bb79f:-:6000:2828",
  "curved_video_orbit@405x720@3.9": "cf2eee6f4b3b58c9cb4d72e4:f8438d998806819f301e823c:-:6000:2921",
  "curved_video_orbit@precise": "c7f65453e865e10c57faeab4:9173635db86e908567a218fb:801ca43c628b19678157cd20:6000:2073",
  "extruded_typography@96x54@0": "a761f7b6024ed3f6347cc1a1:7ceab1416ec157de9acf8a4f:-:6928:988",
  "extruded_typography@96x54@0.37": "8fc57dbb80bf0309a91fa797:9b2089334c07dbd184652fbb:-:6928:970",
  "extruded_typography@96x54@1.25": "1c2d43908d1af5cc59748d1f:11c2ca6db67e0416c2e41e18:-:6928:1001",
  "extruded_typography@96x54@3.9": "aa8f42547a83d24ef410cd54:a6e25116a2b461f00f7ca0dc:-:6928:993",
  "extruded_typography@270x480@0": "ad5a18285698253fb4b23fbc:5aaf09729d44bc8ad07b5f7c:-:6928:2643",
  "extruded_typography@270x480@0.37": "bf09ced40bd3c181427b6c63:9efdf7c6915e842c3cc4264a:-:6928:2648",
  "extruded_typography@270x480@1.25": "8f55088585752eeda03eebb8:79ca7fb7a7eb05280ff2e622:-:6928:2806",
  "extruded_typography@270x480@3.9": "be6fb03a0004e9fac3d76dc3:6f3766977b89f3c08700f1a7:-:6928:2846",
  "extruded_typography@405x720@0": "fb44be0c9e0d2ea4909ebe1c:98187a5d7592ef70eae55b68:-:6928:2934",
  "extruded_typography@405x720@0.37": "16198152395c7c42f845a824:d4b47634b1b95d1378f1a307:-:6928:2883",
  "extruded_typography@405x720@1.25": "ad1858e9b95d3e909d58de36:acb709e3e655953181c1dca1:-:6928:3075",
  "extruded_typography@405x720@3.9": "c1470e4ac2216b9cbe24f48c:98e4301b044454db55366937:-:6928:3072",
  "extruded_typography@precise": "8ce64f7e8b709e7c26ee50ae:31993dc33b120cc0f83cc772:b28805e09b30f49e60f66058:6928:2302",
  "depth_studio@96x54@0": "68741511eee550bdc5ee87bc:81e4d2609ecac31d2e7ad3c5:-:5024:343",
  "depth_studio@96x54@0.37": "bdc6de0202162e8950c4faa4:aaff937a69aef8a694e86d85:-:5024:359",
  "depth_studio@96x54@1.25": "0ff69657c9c263547556839d:cb5a421a3ff7be9c3586533f:-:5024:409",
  "depth_studio@96x54@3.9": "c10963f182b0152ff9d7f960:4031583a96ab9791ae65833a:-:5024:453",
  "depth_studio@270x480@0": "13101e3c3fb5e4cdaaa1f20a:eff1f5f75403240467f5b3fb:-:5024:1709",
  "depth_studio@270x480@0.37": "21357f12b3a87579b26c20e5:bb49341b36714e054d320e1b:-:5024:1668",
  "depth_studio@270x480@1.25": "a42531d80aae665e412500a5:1730841053c0a3f8f183e228:-:5024:1750",
  "depth_studio@270x480@3.9": "89d014d0a58767481dcf0688:8025c63ad3bf4bb090cbbb41:-:5024:1836",
  "depth_studio@405x720@0": "5722cfccbc78a926ce1a49e0:942ba032665e203428167e68:-:5024:2037",
  "depth_studio@405x720@0.37": "5d1a4461c28b015318ac35c2:aa8154b26618440f80091452:-:5024:2093",
  "depth_studio@405x720@1.25": "80132cc7a702255fabd8dd97:f952cbff7d43b6e3a2041aa0:-:5024:2090",
  "depth_studio@405x720@3.9": "905353cdd5bdcc4eeeabda3f:d48ce6ee45046e0132fb176b:-:5024:2158",
  "depth_studio@precise": "698c2f6587a872132743c0c9:97d1ff075c12593cd231ee38:73b5da5ec3caf5b27dd7591a:5024:1296",
  "overlay": "7ce627683dbba9cb69635b4e:97cdc515f87ecbb6c8b2df67:bcf1665b3cddef03bd75cf37:1588:1249",
};

describe("legacy mesh3d scenes keep rendering byte-identically", () => {
  it("matches the corpus captured from the engine before the extension", () => {
    const actual = legacyCorpusDigests();
    if (process.env.MESH3D_CAPTURE_GOLDEN) { console.log(JSON.stringify(actual, null, 2)); return; }
    expect(Object.keys(GOLDEN).length).toBeGreaterThan(40);
    expect(actual).toEqual(GOLDEN);
  }, 120_000);
});
