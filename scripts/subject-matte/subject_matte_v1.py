"""Editkin subject matte v1: a per-frame person matte for "text behind the subject" and cut-outs.

Run with ``python -I``. Reads one local source video and writes a lossless greyscale FFV1 matte
with exactly the source's decoded frame count, frame rate and display size, plus a JSON receipt.

Model: MediaPipe Selfie Segmentation (general, 256x256) and, optionally, the BlazePose
segmentation head. Both ship inside the installed ``mediapipe`` wheel (Apache-2.0); nothing is
downloaded. SAM, GPL models and anything not Apache-2.0 (or more permissive) are out of scope.

Quality stages per frame (analysis resolution unless noted):
  1. model probability (full frame, optional square tiles gated by the full-frame result);
  2. temporal stabilisation: optical-flow-warped EMA whose weight rises where the warp is
     unreliable (motion, occlusion) so fast moves follow the new frame instead of ghosting;
     a scene cut resets the state;
  3. small-island removal and small-hole filling on the thresholded matte;
  4. confidence threshold with a soft edge (smoothstep);
  5. edge refinement at full resolution: fast guided filter guided by the source luma.

The process runs at below-normal priority. A receipt records model, licence, hashes, frames and
timings. ``qualityState`` is always "diagnostic": a matte is not art or human approval.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
import platform
import subprocess
import sys
import queue
import tempfile
import threading
import time
from fractions import Fraction
from pathlib import Path

TOOL_VERSION = "1.0.0"
RECEIPT_SCHEMA = "editkin.subject-matte-receipt/v1"
PROGRESS_SCHEMA = "editkin.subject-matte-progress/v1"
BELOW_NORMAL = 0x00004000
HLG_TO_SDR = [  # Same curve as Editkin's preview recipe (src/color/displayTransfer.ts).
    "zscale=t=linear:npl=100:agamma=0", "format=gbrpf32le", "zscale=p=bt709",
    "tonemap=tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709:r=tv",
]
PQ_TO_SDR = [
    "zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709",
    "tonemap=tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709:r=tv",
]
FORMATS = {  # name -> (raw pipe pix_fmt, stored FFV1 pix_fmt, planes per frame, bits). FFV1 has no 8-bit gbrap; it stores bgra.
    "gray": ("gray", "gray", 1, 8), "gray16": ("gray16le", "gray16le", 1, 16),
    "alpha8": ("gbrap", "bgra", 4, 8), "alpha16": ("gbrap16le", "gbrap16le", 4, 16),
}
MODEL_FILES = {
    "selfie": ("modules/selfie_segmentation/selfie_segmentation.tflite", "mediapipe-selfie-segmentation-general-256x256"),
    "pose": ("modules/pose_landmark/pose_landmark_full.tflite", "mediapipe-blazepose-full-segmentation"),
}


class MatteError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def below_normal_priority() -> str:
    """Lower this process; FFmpeg children are started BELOW_NORMAL too. Returns the observed class."""
    if os.name != "nt":  # pragma: no cover - Windows is the product platform
        os.nice(5)
        return "nice+5"
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE  # the pseudo handle is -1; an int restype truncates it
    kernel32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.SetPriorityClass.restype = wintypes.BOOL
    kernel32.GetPriorityClass.argtypes = [wintypes.HANDLE]
    kernel32.GetPriorityClass.restype = wintypes.DWORD
    handle = kernel32.GetCurrentProcess()
    if not kernel32.SetPriorityClass(handle, BELOW_NORMAL):
        raise MatteError("PRIORITY_NOT_LOWERED", f"SetPriorityClass failed: {ctypes.get_last_error()}")
    observed = kernel32.GetPriorityClass(handle)
    if observed != BELOW_NORMAL:
        raise MatteError("PRIORITY_NOT_LOWERED", f"priority class {observed:#x}")
    return "below_normal"


def child_flags() -> dict:
    if os.name == "nt":
        return {"creationflags": BELOW_NORMAL | subprocess.CREATE_NO_WINDOW}
    return {}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def default_tool(name: str) -> str:
    here = Path(__file__).resolve()
    vendored = here.parents[2] / "vendor" / "ffmpeg" / "win32-x64" / f"{name}.exe"
    return str(vendored) if vendored.is_file() else name


def probe(ffprobe: str, source: Path) -> dict:
    args = [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_frames,color_transfer,color_primaries,color_space,color_range:stream_side_data=rotation:format=duration",
            "-of", "json", str(source)]
    out = subprocess.run(args, capture_output=True, check=False, **child_flags())
    if out.returncode != 0:
        raise MatteError("SOURCE_PROBE_FAILED", out.stderr.decode("utf-8", "replace")[-800:])
    data = json.loads(out.stdout.decode("utf-8"))
    streams = data.get("streams") or []
    if not streams:
        raise MatteError("SOURCE_HAS_NO_VIDEO", str(source))
    stream = streams[0]
    rotation = 0
    for item in stream.get("side_data_list") or []:
        if isinstance(item, dict) and "rotation" in item:
            rotation = int(round(float(item["rotation"])))
    width, height = int(stream["width"]), int(stream["height"])
    if rotation % 180:
        width, height = height, width
    rate = Fraction(stream.get("r_frame_rate") or "0/1")
    avg = Fraction(stream.get("avg_frame_rate") or "0/1") if (stream.get("avg_frame_rate") or "0/0") != "0/0" else Fraction(0)
    if rate <= 0:
        rate = avg
    if rate <= 0 or width < 16 or height < 16:
        raise MatteError("SOURCE_GEOMETRY_OR_RATE_INVALID", json.dumps(stream))
    return {
        "codec": stream.get("codec_name"), "pixelFormat": stream.get("pix_fmt"), "codedWidth": int(stream["width"]),
        "codedHeight": int(stream["height"]), "rotation": rotation, "width": width, "height": height,
        "rate": rate, "avgRate": avg, "declaredFrames": int(stream["nb_frames"]) if str(stream.get("nb_frames", "")).isdigit() else None,
        "transfer": stream.get("color_transfer"), "primaries": stream.get("color_primaries"), "matrix": stream.get("color_space"),
        "range": stream.get("color_range"), "duration": float((data.get("format") or {}).get("duration") or 0.0),
    }


def even(value: float) -> int:
    return max(2, int(round(value / 2.0)) * 2)


class Decoder:
    """One raw-video pipe. Frames are passed through exactly once (no CFR duplication/drop)."""

    def __init__(self, ffmpeg: str, source: Path, filters: list[str], pix_fmt: str, width: int, height: int, channels: int, log_dir: Path, name: str):
        self.frame_bytes = width * height * channels
        self.shape = (height, width, channels) if channels > 1 else (height, width)
        self.log = (log_dir / f"{name}.log").open("wb")
        chain = ",".join(filters + [f"format={pix_fmt}"])
        args = [ffmpeg, "-nostdin", "-v", "error", "-threads", "4", "-i", str(source), "-map", "0:v:0", "-an", "-sn", "-dn",
                "-fps_mode", "passthrough", "-vf", chain, "-f", "rawvideo", "-pix_fmt", pix_fmt, "-"]
        self.process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=self.log, bufsize=self.frame_bytes * 2, **child_flags())

    def read(self):
        import numpy as np
        buffer = self.process.stdout.read(self.frame_bytes)
        if not buffer:
            return None
        if len(buffer) != self.frame_bytes:
            raise MatteError("DECODE_TRUNCATED_FRAME", f"{len(buffer)} of {self.frame_bytes} bytes")
        return np.frombuffer(buffer, dtype=np.uint8).reshape(self.shape)

    def close(self) -> int:
        try:
            self.process.stdout.close()
        finally:
            code = self.process.wait()
            self.log.close()
        return code


class Prefetch:
    """Decode-ahead thread so FFmpeg pipe reads overlap the per-frame maths."""

    def __init__(self, decoder: Decoder, depth: int = 4):
        self.decoder, self.items, self.error = decoder, queue.Queue(maxsize=depth), None
        self.stop = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        try:
            while not self.stop:
                frame = self.decoder.read()
                self.items.put(frame)
                if frame is None:
                    return
        except BaseException as error:  # surfaced on the next read()
            self.error = error
            self.items.put(None)

    def read(self):
        frame = self.items.get()
        if self.error is not None:
            raise self.error
        return frame

    def cancel(self):
        self.stop = True
        while not self.items.empty():
            self.items.get_nowait()


class Writer:
    """Encoder feed thread; a write failure is raised on the next put() or on close()."""

    def __init__(self, stream, depth: int = 4):
        self.stream, self.items, self.error = stream, queue.Queue(maxsize=depth), None
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while True:
            payload = self.items.get()
            if payload is None:
                return
            if self.error is None:
                try:
                    self.stream.write(payload)
                except BaseException as error:
                    self.error = error

    def put(self, payload: bytes):
        if self.error is not None:
            raise MatteError("ENCODER_WRITE_FAILED", str(self.error))
        self.items.put(payload)

    def close(self):
        self.items.put(None)
        self.thread.join()
        if self.error is not None:
            raise MatteError("ENCODER_WRITE_FAILED", str(self.error))


def smoothstep(edge0: float, edge1: float, x):
    import numpy as np
    t = np.clip((x - edge0) / max(1e-6, edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def tile_offsets(long_edge: int, side: int):
    if long_edge < side * 1.3:
        return []
    count = int(math.ceil((long_edge - side) / (side * 0.7))) + 1
    return [round(index * (long_edge - side) / max(1, count - 1)) for index in range(count)]


def run_tiles(fn, rgb):
    """Max of ``fn`` over square tiles along the long edge (None when the frame is near-square)."""
    import numpy as np
    h, w = rgb.shape[:2]
    side = min(h, w)
    offsets = tile_offsets(max(h, w), side)
    if not offsets:
        return None
    tiled = np.zeros((h, w), np.float32)
    for offset in offsets:
        if h >= w:
            part = fn(np.ascontiguousarray(rgb[offset:offset + side]))
            tiled[offset:offset + side] = np.maximum(tiled[offset:offset + side], part)
        else:
            part = fn(np.ascontiguousarray(rgb[:, offset:offset + side]))
            tiled[:, offset:offset + side] = np.maximum(tiled[:, offset:offset + side], part)
    return tiled


def vendored_deeplab() -> Path:
    """The single fetched model. Its bytes must match vendor/models/subject-matte/SOURCE.json."""
    folder = Path(__file__).resolve().parents[2] / "vendor" / "models" / "subject-matte"
    source = json.loads((folder / "SOURCE.json").read_text("utf-8"))
    path = folder / source["file"]["path"]
    if source["licence"]["spdx"] != "Apache-2.0" or not path.is_file() or path.stat().st_size != source["file"]["bytes"] or sha256_file(path) != source["file"]["sha256"]:
        raise MatteError("DEEPLAB_MODEL_IDENTITY", str(path))
    return path


class SubjectModel:
    """Person probability in [0,1] at analysis resolution.

    selfie (default): MediaPipe Selfie Segmentation, general 256x256 (in scope: people within ~4 m).
    pose: BlazePose segmentation of one tracked person (single prominent full-body subject).
    selfie+deeplab: adds DeepLab-V3 person confidence (PASCAL VOC) on square tiles for far or crowded
      people that the selfie model's card puts out of scope. About 4x slower.
    """

    def __init__(self, kind: str, tiles: str):
        import mediapipe as mp
        self.kind = kind
        self.tiles = tiles
        self.selfie = mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=0) if kind in ("selfie", "selfie+pose", "selfie+deeplab") else None
        # A second instance keeps each graph at one input size (tiles are square, the full frame is not).
        self.selfie_tiles = mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=0) if self.selfie is not None and tiles != "off" else None
        self.pose = mp.solutions.pose.Pose(static_image_mode=False, model_complexity=1, enable_segmentation=True,
                                           smooth_segmentation=False, min_detection_confidence=0.5, min_tracking_confidence=0.5) if kind in ("pose", "selfie+pose") else None
        self.deeplab = None
        if kind == "selfie+deeplab":
            from mediapipe.tasks import python as mp_tasks
            from mediapipe.tasks.python import vision
            # Pass verified bytes: the tasks API resolves model paths against its package folder.
            options = vision.ImageSegmenterOptions(base_options=mp_tasks.BaseOptions(model_asset_buffer=vendored_deeplab().read_bytes()),
                                                   running_mode=vision.RunningMode.IMAGE, output_confidence_masks=True, output_category_mask=False)
            self.deeplab = vision.ImageSegmenter.create_from_options(options)
            self._mp_image = mp.Image
            self._srgb = mp.ImageFormat.SRGB

    def _selfie(self, rgb, graph=None):
        import numpy as np
        return np.asarray((graph or self.selfie).process(rgb).segmentation_mask, dtype=np.float32)

    def _deeplab(self, rgb):
        import numpy as np
        result = self.deeplab.segment(self._mp_image(image_format=self._srgb, data=np.ascontiguousarray(rgb)))
        return np.asarray(result.confidence_masks[15].numpy_view(), dtype=np.float32)  # 15 = person

    def __call__(self, rgb):
        import cv2
        import numpy as np
        result = None
        if self.selfie is not None:
            full = self._selfie(rgb)
            result = full
            far = None
            if self.deeplab is not None:
                deep = run_tiles(self._deeplab, rgb)
                deep = self._deeplab(rgb) if deep is None else deep
                # DeepLab confidence is blocky/striped at 257 px: soften, then keep only confident person.
                far = smoothstep(0.35, 0.75, cv2.GaussianBlur(deep, (0, 0), 2.0))
                result = np.maximum(result, far)
            if self.selfie_tiles is not None:
                tiled = run_tiles(lambda tile: self._selfie(tile, self.selfie_tiles), rgb)
                if tiled is not None:
                    # Tile evidence only counts near people another pass already sees; this keeps the
                    # higher-resolution tile edges and drops the tile model's sky/building false positives.
                    long_edge = max(rgb.shape[:2])
                    radius = max(3, int(round(0.03 * long_edge)))
                    seen = (full > 0.25) if far is None else ((full > 0.25) | (far > 0.5))
                    support = cv2.dilate(seen.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)))
                    support = cv2.GaussianBlur(support.astype(np.float32), (0, 0), radius / 2.0)
                    result = np.maximum(result, tiled * np.clip(support, 0.0, 1.0))
        if self.pose is not None:
            pose = self.pose.process(rgb)
            mask = pose.segmentation_mask
            pose_mask = np.asarray(mask, dtype=np.float32) if mask is not None else np.zeros(rgb.shape[:2], np.float32)
            result = pose_mask if result is None else np.maximum(result, pose_mask)
        return result

    def close(self):
        for item in (self.selfie, self.selfie_tiles, self.pose, self.deeplab):
            if item is not None:
                item.close()


class TemporalStabiliser:
    """Flow-warped EMA. weight(new) = beta_min + (1-beta_min) * unreliability, where unreliability
    comes from the photometric error after warping the previous frame onto the current one."""

    def __init__(self, beta_min: float, error_floor: float, error_span: float, cut_threshold: float):
        import cv2
        self.flow = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_ULTRAFAST)
        self.beta_min, self.error_floor, self.error_span, self.cut_threshold = beta_min, error_floor, error_span, cut_threshold
        self.prev_gray = None
        self.state = None
        self.grid = None
        self.cuts = 0
        self.last_motion = 0.0

    def __call__(self, gray, prob):
        import cv2
        import numpy as np
        h, w = prob.shape
        small_w, small_h = max(32, w // 2), max(32, h // 2)
        small = cv2.resize(gray, (small_w, small_h), interpolation=cv2.INTER_AREA)
        if self.prev_gray is None:
            self.prev_gray, self.state = small, prob.copy()
            self.last_motion = 0.0
            return self.state
        flow = self.flow.calc(small, self.prev_gray, None)  # current -> previous displacement
        if self.grid is None or self.grid[0].shape != (small_h, small_w):
            xs, ys = np.meshgrid(np.arange(small_w, dtype=np.float32), np.arange(small_h, dtype=np.float32))
            self.grid = (xs, ys)
        map_x, map_y = self.grid[0] + flow[..., 0], self.grid[1] + flow[..., 1]
        warped_gray = cv2.remap(self.prev_gray, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        error = cv2.GaussianBlur(cv2.absdiff(small, warped_gray).astype(np.float32), (0, 0), 1.5)
        raw_motion = float(cv2.absdiff(small, self.prev_gray).mean())
        self.last_motion = float(np.sqrt((flow ** 2).sum(axis=2)).mean()) * 2.0  # analysis pixels
        self.prev_gray = small
        if raw_motion > self.cut_threshold and float(error.mean()) > self.cut_threshold * 0.6:
            self.cuts += 1
            self.state = prob.copy()
            return self.state
        scale_x, scale_y = w / small_w, h / small_h
        full_map_x = cv2.resize(map_x * scale_x, (w, h), interpolation=cv2.INTER_LINEAR)
        full_map_y = cv2.resize(map_y * scale_y, (w, h), interpolation=cv2.INTER_LINEAR)
        warped = cv2.remap(self.state, full_map_x, full_map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        unreliable = np.clip((error - self.error_floor) / self.error_span, 0.0, 1.0)
        beta = self.beta_min + (1.0 - self.beta_min) * cv2.resize(unreliable, (w, h), interpolation=cv2.INTER_LINEAR)
        self.state = beta * prob + (1.0 - beta) * warped
        return self.state


def clean_matte(prob, threshold: float, island_fraction: float, hole_fraction: float):
    """Remove small foreground islands, fill small enclosed holes. Returns (matte, stats)."""
    import cv2
    import numpy as np
    h, w = prob.shape
    area = float(h * w)
    binary = (prob >= threshold).astype(np.uint8)
    out = prob.copy()
    removed = filled = 0
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if count > 1:
        small = np.zeros(count, dtype=bool)
        small[1:] = stats[1:, cv2.CC_STAT_AREA] < island_fraction * area
        if small.any():
            kill = small[labels].astype(np.uint8)
            kill = cv2.dilate(kill, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
            out = out * (1.0 - kill.astype(np.float32))
            removed = int(small.sum())
    inverse = (1 - binary).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(inverse, connectivity=4)
    if count > 1:
        x, y, cw, ch = stats[:, 0], stats[:, 1], stats[:, 2], stats[:, 3]
        touches = (x == 0) | (y == 0) | (x + cw >= w) | (y + ch >= h)
        hole = np.zeros(count, dtype=bool)
        hole[1:] = (~touches[1:]) & (stats[1:, cv2.CC_STAT_AREA] < hole_fraction * area)
        if hole.any():
            fill = cv2.GaussianBlur(hole[labels].astype(np.float32), (0, 0), 1.0)
            out = np.maximum(out, fill)
            filled = int(hole.sum())
    return out, {"islandsRemoved": removed, "holesFilled": filled}


class GuidedRefiner:
    """Fast guided filter (He & Sun 2015): coefficients at analysis resolution, applied to the
    full-resolution source luma, so the matte edge follows real image edges."""

    def __init__(self, radius: int, eps: float):
        self.radius, self.eps = radius, eps

    def __call__(self, guide_full_u8, matte_low):
        import cv2
        import numpy as np
        h, w = matte_low.shape
        H, W = guide_full_u8.shape
        guide = cv2.resize(guide_full_u8, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) * (1.0 / 255.0)
        k = (2 * self.radius + 1, 2 * self.radius + 1)
        mean_i = cv2.boxFilter(guide, -1, k)
        mean_p = cv2.boxFilter(matte_low, -1, k)
        cov_ip = cv2.boxFilter(guide * matte_low, -1, k) - mean_i * mean_p
        var_i = cv2.boxFilter(guide * guide, -1, k) - mean_i * mean_i
        a = cov_ip / (var_i + self.eps)
        b = mean_p - a * mean_i
        mean_a = cv2.resize(cv2.boxFilter(a, -1, k), (W, H), interpolation=cv2.INTER_LINEAR)
        mean_b = cv2.resize(cv2.boxFilter(b, -1, k), (W, H), interpolation=cv2.INTER_LINEAR)
        full = cv2.multiply(mean_a, guide_full_u8.astype(np.float32), scale=1.0 / 255.0)
        cv2.add(full, mean_b, dst=full)
        np.clip(full, 0.0, 1.0, out=full)
        return full


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Editkin subject matte v1 (Apache-2.0 MediaPipe person segmentation)")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path, help="matte video path (.mkv, FFV1)")
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--format", choices=tuple(FORMATS), default="gray",
                        help="gray/gray16: grey matte (luma track matte); alpha8/alpha16: RGB=A=matte (alpha track matte, renderer-consistent)")
    parser.add_argument("--model", choices=("selfie", "pose", "selfie+pose", "selfie+deeplab"), default="selfie")
    parser.add_argument("--tiles", choices=("auto", "off"), default="auto")
    parser.add_argument("--analysis-long-edge", type=int, default=960)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--softness", type=float, default=0.3, help="width of the smoothstep around the threshold")
    parser.add_argument("--temporal-min-weight", type=float, default=0.4, help="EMA weight of the new frame where the warp is reliable")
    parser.add_argument("--island-fraction", type=float, default=0.002)
    parser.add_argument("--hole-fraction", type=float, default=0.001)
    parser.add_argument("--guided-radius", type=int, default=4, help="analysis-resolution pixels")
    parser.add_argument("--guided-eps", type=float, default=2e-3)
    parser.add_argument("--max-frames", type=int, default=0, help="speed benchmarks only; the matte then covers a prefix")
    parser.add_argument("--ffmpeg", default=default_tool("ffmpeg"))
    parser.add_argument("--ffprobe", default=default_tool("ffprobe"))
    parser.add_argument("--progress", type=Path)
    parser.add_argument("--cancel", type=Path)
    parser.add_argument("--stats-out", type=Path, help="optional per-frame statistics (JSON lines)")
    args = parser.parse_args(argv)
    if not (0.05 <= args.threshold <= 0.95 and 0.0 <= args.softness <= 0.9 and 0.05 <= args.temporal_min_weight <= 1.0
            and 256 <= args.analysis_long_edge <= 2048 and 1 <= args.guided_radius <= 32 and 1e-6 <= args.guided_eps <= 0.5):
        parser.error("quality parameter outside its supported range")
    return args


def run(args) -> dict:
    import cv2
    import mediapipe
    import numpy as np

    priority = below_normal_priority()
    cv2.setNumThreads(4)
    source = args.source.resolve()
    output = args.output.resolve()
    receipt_path = (args.receipt or output.with_name(output.name + ".receipt.json")).resolve()
    if not source.is_file():
        raise MatteError("SOURCE_MISSING", str(source))
    if output.suffix.lower() != ".mkv":
        raise MatteError("OUTPUT_MUST_BE_MKV", str(output))
    if output == source or receipt_path == source:
        raise MatteError("OUTPUT_WOULD_OVERWRITE_SOURCE", str(source))
    if args.cancel and args.cancel.exists():
        raise MatteError("CANCELLED_BEFORE_START", str(args.cancel))
    started = time.perf_counter()
    cpu_started = os.times()
    source_sha = sha256_file(source)
    source_bytes = source.stat().st_size
    info = probe(args.ffprobe, source)
    width, height = info["width"], info["height"]
    scale = min(1.0, args.analysis_long_edge / max(width, height))
    aw, ah = even(width * scale), even(height * scale)
    transfer = (info["transfer"] or "").lower()
    tonemap = HLG_TO_SDR if transfer == "arib-std-b67" else PQ_TO_SDR if transfer == "smpte2084" else []
    decode_transform = "hlg-to-sdr-hable" if transfer == "arib-std-b67" else "pq-to-sdr-hable" if transfer == "smpte2084" else "none"

    package_root = Path(mediapipe.__file__).resolve().parent
    models = []
    for key in args.model.split("+"):
        if key == "deeplab":
            model_path = vendored_deeplab()
            models.append({"id": "mediapipe-image-segmenter-deeplab-v3-257", "file": model_path.name, "packagePath": "vendor/models/subject-matte/deeplab_v3.tflite",
                           "bytes": model_path.stat().st_size, "sha256": sha256_file(model_path), "licence": "Apache-2.0",
                           "provenance": "fetched once from storage.googleapis.com/mediapipe-models (see vendor/models/subject-matte/SOURCE.json)"})
            continue
        rel, model_id = MODEL_FILES[key]
        model_path = package_root / rel
        models.append({"id": model_id, "file": model_path.name, "packagePath": rel, "bytes": model_path.stat().st_size,
                       "sha256": sha256_file(model_path), "licence": "Apache-2.0",
                       "provenance": f"bundled in the installed mediapipe {mediapipe.__version__} wheel (PyPI); no download"})

    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(output.name + ".partial.mkv")
    if partial.exists():
        partial.unlink()
    logs = Path(tempfile.mkdtemp(prefix="subject-matte-", dir=os.environ.get("TEMP")))
    pix_in, pix_out, planes, bits = FORMATS[args.format]
    rate = info["rate"]
    guide = Decoder(args.ffmpeg, source, [], "gray", width, height, 1, logs, "guide")
    analysis = Decoder(args.ffmpeg, source, [f"scale={aw}:{ah}:flags=area"] + tonemap, "rgb24", aw, ah, 3, logs, "analysis")
    enc_log = (logs / "encode.log").open("wb")
    encoder = subprocess.Popen([args.ffmpeg, "-nostdin", "-v", "error", "-f", "rawvideo", "-pix_fmt", pix_in, "-s", f"{width}x{height}",
                                "-framerate", f"{rate.numerator}/{rate.denominator}", "-i", "-", "-c:v", "ffv1", "-level", "3", "-g", "1",
                                "-slices", "4", "-slicecrc", "1", "-pix_fmt", pix_out, "-color_range", "pc",
                                "-metadata", f"comment=editkin subject matte v1; source sha256 {source_sha}", "-y", str(partial)],
                               stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=enc_log, **child_flags())
    model = SubjectModel(args.model, args.tiles)
    guide_ahead, analysis_ahead, writer = Prefetch(guide), Prefetch(analysis), Writer(encoder.stdin)
    stabiliser = TemporalStabiliser(args.temporal_min_weight, error_floor=3.0, error_span=12.0, cut_threshold=40.0)
    refiner = GuidedRefiner(args.guided_radius, args.guided_eps)
    lo, hi = args.threshold - args.softness / 2.0, args.threshold + args.softness / 2.0
    timings = {"decode": 0.0, "model": 0.0, "temporal": 0.0, "cleanup": 0.0, "refine": 0.0, "encode": 0.0}
    frames = 0
    prev_raw = prev_out = None
    raw_change, out_change, coverage, motion = [], [], [], []
    islands = holes = empty = 0
    stats_file = args.stats_out.open("w", encoding="utf-8") if args.stats_out else None
    cancelled = False
    try:
        while True:
            if args.max_frames and frames >= args.max_frames:
                break
            t = time.perf_counter()
            rgb = analysis_ahead.read()
            gray_full = guide_ahead.read()
            timings["decode"] += time.perf_counter() - t
            if rgb is None or gray_full is None:
                if (rgb is None) != (gray_full is None):
                    raise MatteError("DECODER_FRAME_COUNT_MISMATCH", f"after {frames} frames")
                break
            t = time.perf_counter()
            prob = model(rgb)
            timings["model"] += time.perf_counter() - t
            t = time.perf_counter()
            gray_small = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
            stable = stabiliser(gray_small, prob)
            timings["temporal"] += time.perf_counter() - t
            t = time.perf_counter()
            cleaned, cleanup_stats = clean_matte(stable, args.threshold, args.island_fraction, args.hole_fraction)
            matte_low = smoothstep(lo, hi, cleaned).astype(np.float32)
            islands += cleanup_stats["islandsRemoved"]
            holes += cleanup_stats["holesFilled"]
            timings["cleanup"] += time.perf_counter() - t
            t = time.perf_counter()
            full = refiner(gray_full, matte_low)
            if bits == 16:
                plane = (full * 65535.0 + 0.5).astype("<u2")
                out_u8 = (plane >> 8).astype(np.uint8)
            else:
                plane = cv2.convertScaleAbs(full, alpha=255.0)  # input already clipped to [0,1]; saturating
                out_u8 = plane
            payload = plane.tobytes() * planes  # gbrap planar G,B,R,A all carry the matte
            timings["refine"] += time.perf_counter() - t
            t = time.perf_counter()
            writer.put(payload)
            timings["encode"] += time.perf_counter() - t
            out_low = cv2.resize(out_u8, (aw, ah), interpolation=cv2.INTER_AREA).astype(np.float32) * (1.0 / 255.0)
            if prev_raw is not None:
                raw_change.append(float(np.abs(prob - prev_raw).mean()))
                out_change.append(float(np.abs(out_low - prev_out).mean()))
            prev_raw, prev_out = prob, out_low
            cover = float(out_low.mean())
            coverage.append(cover)
            motion.append(stabiliser.last_motion)
            if cover < 0.002:
                empty += 1
            if stats_file:
                stats_file.write(json.dumps({"frame": frames, "coverage": round(cover, 5), "motionPx": round(stabiliser.last_motion, 3),
                                             "rawChange": round(raw_change[-1], 6) if frames else None,
                                             "outChange": round(out_change[-1], 6) if frames else None}) + "\n")
            frames += 1
            if args.progress and frames % 15 == 0:
                write_json_atomic(args.progress, {"schema": PROGRESS_SCHEMA, "stage": "matte", "framesDone": frames,
                                                  "framesExpected": info["declaredFrames"], "elapsedSeconds": round(time.perf_counter() - started, 2)})
            if args.cancel and frames % 15 == 0 and args.cancel.exists():
                cancelled = True
                break
    finally:
        if stats_file:
            stats_file.close()
        writer_error = None
        try:
            writer.close()
        except MatteError as error:
            writer_error = error
        try:
            encoder.stdin.close()
        except OSError:
            pass
        guide_ahead.cancel()
        analysis_ahead.cancel()
        encode_code = encoder.wait()
        enc_log.close()
        guide_code = guide.close()
        analysis_code = analysis.close()
        model.close()
    if writer_error is not None:
        partial.unlink(missing_ok=True)
        raise writer_error
    if cancelled:
        partial.unlink(missing_ok=True)
        raise MatteError("CANCELLED", f"after {frames} frames")
    errors = {name: (logs / f"{name}.log").read_text("utf-8", "replace")[-800:] for name in ("guide", "analysis", "encode")}
    full_run = not args.max_frames
    if encode_code != 0 or (full_run and (guide_code != 0 or analysis_code != 0)):
        partial.unlink(missing_ok=True)
        raise MatteError("FFMPEG_FAILED", json.dumps({"guide": guide_code, "analysis": analysis_code, "encode": encode_code, "logs": errors}))
    if frames == 0:
        partial.unlink(missing_ok=True)
        raise MatteError("NO_FRAMES_DECODED", str(source))
    check = probe(args.ffprobe, partial)
    counted = subprocess.run([args.ffprobe, "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets",
                              "-of", "csv=p=0", str(partial)], capture_output=True, check=False, **child_flags())
    out_frames = int(counted.stdout.decode().strip() or 0)
    if (check["width"], check["height"]) != (width, height) or check["rate"] != rate or out_frames != frames or check["pixelFormat"] != pix_out or check["codec"] != "ffv1":
        partial.unlink(missing_ok=True)
        raise MatteError("MATTE_OUTPUT_CONTRACT", json.dumps({"width": check["width"], "height": check["height"], "rate": str(check["rate"]), "frames": out_frames, "expected": frames, "pixelFormat": check["pixelFormat"], "codec": check["codec"]}))
    if sha256_file(source) != source_sha:
        partial.unlink(missing_ok=True)
        raise MatteError("SOURCE_CHANGED_DURING_MATTE", str(source))
    os.replace(partial, output)
    wall = time.perf_counter() - started
    cpu_now = os.times()
    cpu_seconds = (cpu_now.user - cpu_started.user) + (cpu_now.system - cpu_started.system)
    declared = info["declaredFrames"]
    vfr = bool(info["avgRate"] and abs(float(info["avgRate"]) - float(rate)) > 0.01)
    static = [c for c, m in zip(out_change, motion[1:]) if m < 1.0]
    static_raw = [c for c, m in zip(raw_change, motion[1:]) if m < 1.0]
    receipt = {
        "schema": RECEIPT_SCHEMA, "status": "GREEN", "qualityState": "diagnostic",
        "tool": {"name": "scripts/subject-matte/subject_matte_v1.py", "version": TOOL_VERSION, "sha256": sha256_file(Path(__file__).resolve())},
        "models": models,
        "licence": {"spdx": "Apache-2.0", "basis": "mediapipe wheel METADATA 'License: Apache 2.0'; MediaPipe model cards (selfie segmentation, BlazePose) Apache-2.0",
                     "excluded": ["SAM / SAM 2.x (Hao rejected 2026-10-15)", "GPL models such as Robust Video Matting"]},
        "runtime": {"python": platform.python_version(), "mediapipe": mediapipe.__version__, "opencv": cv2.__version__, "numpy": np.__version__,
                    "ffmpeg": args.ffmpeg, "priority": priority, "ffmpegChildPriority": "below_normal" if os.name == "nt" else "inherited"},
        "source": {"path": str(source), "sha256": source_sha, "bytes": source_bytes, "codec": info["codec"], "pixelFormat": info["pixelFormat"],
                   "codedWidth": info["codedWidth"], "codedHeight": info["codedHeight"], "rotation": info["rotation"], "width": width, "height": height,
                   "frameRate": {"numerator": rate.numerator, "denominator": rate.denominator}, "declaredFrames": declared, "decodedFrames": frames,
                   "variableFrameRateSuspected": vfr, "transfer": info["transfer"], "primaries": info["primaries"], "analysisDecodeTransform": decode_transform},
        "output": {"path": str(output), "sha256": sha256_file(output), "bytes": output.stat().st_size, "container": "matroska", "codec": "ffv1",
                   "pixelFormat": pix_out, "matteFormat": args.format, "trackMatteMode": "alpha" if planes == 4 else "luma", "range": "pc", "width": width, "height": height, "frameRate": {"numerator": rate.numerator, "denominator": rate.denominator},
                   "frames": frames, "coversWholeSource": full_run and (declared is None or declared == frames), "semantics": "255/65535 = subject (opaque), 0 = background"},
        "settings": {"model": args.model, "tiles": args.tiles, "analysisWidth": aw, "analysisHeight": ah, "threshold": args.threshold, "softness": args.softness,
                     "temporal": {"kind": "dis-flow-warped-ema", "minNewFrameWeight": args.temporal_min_weight, "errorFloor": 3.0, "errorSpan": 12.0, "sceneCutThreshold": 40.0},
                     "cleanup": {"islandFraction": args.island_fraction, "holeFraction": args.hole_fraction},
                     "refine": {"kind": "fast-guided-filter-luma", "radiusAnalysisPx": args.guided_radius, "eps": args.guided_eps}, "format": args.format, "bits": bits},
        "quality": {"meanRawModelChange": round(float(np.mean(raw_change)), 6) if raw_change else None,
                    "meanMatteChange": round(float(np.mean(out_change)), 6) if out_change else None,
                    "staticFrames": len(static), "meanRawModelChangeStatic": round(float(np.mean(static_raw)), 6) if static_raw else None,
                    "meanMatteChangeStatic": round(float(np.mean(static)), 6) if static else None,
                    "meanCoverage": round(float(np.mean(coverage)), 5), "framesWithoutSubject": empty, "sceneCuts": stabiliser.cuts,
                    "islandsRemoved": islands, "holesFilled": holes,
                    "note": "changes are mean |m_t - m_(t-1)| on a 0..1 scale at analysis resolution; static = mean optical-flow motion < 1 analysis px"},
        "timings": {"wallSeconds": round(wall, 3), "framesPerSecond": round(frames / wall, 3), "stageSeconds": {k: round(v, 3) for k, v in timings.items()},
                    "processCpuSeconds": round(cpu_seconds, 3), "processCpuSecondsPerFrame": round(cpu_seconds / frames, 4),
                    "note": "wall/stage seconds include waiting for CPU under the host's load (BELOW_NORMAL); process CPU excludes FFmpeg children"},
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    write_json_atomic(receipt_path, receipt)
    if args.progress:
        write_json_atomic(args.progress, {"schema": PROGRESS_SCHEMA, "stage": "done", "framesDone": frames, "framesExpected": declared,
                                          "elapsedSeconds": round(wall, 2)})
    for name in ("guide", "analysis", "encode"):
        (logs / f"{name}.log").unlink(missing_ok=True)
    logs.rmdir()
    return receipt


def main(argv=None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        receipt = run(args)
    except MatteError as error:
        print(json.dumps({"ok": False, "code": error.code, "error": str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps({"ok": True, "receipt": receipt["output"]["path"] + " (" + str(receipt["output"]["frames"]) + " frames)",
                      "fps": receipt["timings"]["framesPerSecond"], "receiptPath": str((args.receipt or args.output.with_name(args.output.name + ".receipt.json")).resolve())}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
