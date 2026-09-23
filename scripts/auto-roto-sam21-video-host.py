from __future__ import annotations

import hashlib
import json
import math
import os
import struct
import sys
import time
import zlib
from pathlib import Path


def fail(message: str) -> None:
    raise RuntimeError(message)


def bounded_number(value: object, name: str, low: float, high: float) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)) or not low <= float(value) <= high:
        fail(f"{name} out of range")
    return float(value)


def absolute_file(value: object, name: str) -> Path:
    path = Path(str(value))
    if not path.is_absolute() or not path.is_file():
        fail(f"{name} must be an existing absolute file")
    return path.resolve()


def absolute_directory(value: object, name: str) -> Path:
    path = Path(str(value))
    if not path.is_absolute() or not path.is_dir():
        fail(f"{name} must be an existing absolute directory")
    return path.resolve()


def write_gray_png(path: Path, width: int, height: int, pixels: bytes) -> bytes:
    if len(pixels) != width * height:
        fail("PNG alpha payload length mismatch")
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    rows = b"".join(b"\x00" + pixels[y * width:(y + 1) * width] for y in range(height))
    encoded = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows, 6))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(encoded)
    return encoded


def expand_stroke_points(stroke: dict[str, object], width: int, height: int) -> list[list[float]]:
    radius = bounded_number(stroke.get("radius"), "correction radius", 0.001, 0.25)
    source = stroke.get("points")
    if not isinstance(source, list) or not 1 <= len(source) <= 4096:
        fail("correction points invalid")
    expanded: list[list[float]] = []
    offsets = ((0.0, 0.0), (radius * 0.7, 0.0), (-radius * 0.7, 0.0), (0.0, radius * 0.7), (0.0, -radius * 0.7))
    stride = max(1, math.ceil(len(source) * len(offsets) / 512))
    for point in source[::stride]:
        if not isinstance(point, dict):
            fail("correction point invalid")
        x = bounded_number(point.get("x"), "correction x", 0.0, 1.0)
        y = bounded_number(point.get("y"), "correction y", 0.0, 1.0)
        for dx, dy in offsets:
            expanded.append([min(1.0, max(0.0, x + dx)) * (width - 1), min(1.0, max(0.0, y + dy)) * (height - 1)])
    return expanded


def boundary_band(mask):
    import numpy as np
    edge = np.zeros_like(mask, dtype=bool)
    edge[1:, :] |= mask[1:, :] != mask[:-1, :]
    edge[:-1, :] |= mask[:-1, :] != mask[1:, :]
    edge[:, 1:] |= mask[:, 1:] != mask[:, :-1]
    edge[:, :-1] |= mask[:, :-1] != mask[:, 1:]
    return edge


def prepare_job(request_path: Path) -> dict[str, object]:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if request.get("schema") != "editkin.auto-roto-video-request/v1":
        fail("unsupported request schema")
    frame_directory = absolute_directory(request.get("frameDirectory"), "frameDirectory")
    output_directory = Path(str(request.get("outputDirectory")))
    if not output_directory.is_absolute():
        fail("outputDirectory must be absolute")
    output_directory.mkdir(parents=True, exist_ok=True)
    preview_directory = output_directory / "frames"
    preview_directory.mkdir(parents=True, exist_ok=True)
    source_root = absolute_directory(request.get("sourceRoot"), "sourceRoot")
    config_path = absolute_file(request.get("configPath"), "configPath")
    checkpoint_path = absolute_file(request.get("checkpointPath"), "checkpointPath")
    try:
        config_path.relative_to(source_root)
        checkpoint_path.relative_to(source_root)
    except ValueError:
        fail("SAM 2 model inputs escaped source root")

    width = int(bounded_number(request.get("width"), "width", 16, 8192))
    height = int(bounded_number(request.get("height"), "height", 16, 8192))
    frame_count = int(bounded_number(request.get("frameCount"), "frameCount", 1, 50000))
    analysis_fps = bounded_number(request.get("analysisFps"), "analysisFps", 0.1, 240)
    initial_frame = int(bounded_number(request.get("initialFrame"), "initialFrame", 0, frame_count - 1))
    frames = sorted(frame_directory.glob("*.jpg"), key=lambda path: int(path.stem))
    if len(frames) != frame_count or [int(path.stem) for path in frames] != list(range(frame_count)):
        fail("sampled JPEG sequence is incomplete or non-contiguous")
    rect = request.get("initialRect")
    if not isinstance(rect, dict):
        fail("initialRect missing")
    rx = bounded_number(rect.get("x"), "rect x", 0.0, 1.0)
    ry = bounded_number(rect.get("y"), "rect y", 0.0, 1.0)
    rw = bounded_number(rect.get("width"), "rect width", 0.02, 1.0)
    rh = bounded_number(rect.get("height"), "rect height", 0.02, 1.0)
    if rx + rw > 1.000001 or ry + rh > 1.000001:
        fail("initialRect exceeds frame")
    temporal = bounded_number(request.get("temporalStability"), "temporalStability", 0.0, 0.9)
    feather = bounded_number(request.get("feather"), "feather", 0.0, 0.25)
    edge_shift = bounded_number(request.get("edgeShift"), "edgeShift", -0.25, 0.25)
    contrast = bounded_number(request.get("contrast"), "contrast", 0.0, 4.0)
    corrections = request.get("corrections")
    if not isinstance(corrections, list):
        fail("corrections must be an array")
    return {
        "request": request,
        "frame_directory": frame_directory,
        "output_directory": output_directory,
        "preview_directory": preview_directory,
        "source_root": source_root,
        "checkpoint_path": checkpoint_path,
        "width": width,
        "height": height,
        "frame_count": frame_count,
        "analysis_fps": analysis_fps,
        "initial_frame": initial_frame,
        "rect": (rx, ry, rw, rh),
        "temporal": temporal,
        "feather": feather,
        "edge_shift": edge_shift,
        "contrast": contrast,
        "corrections": corrections,
    }


def add_correction_prompts(predictor, state, job: dict[str, object], np) -> set[int]:
    width = int(job["width"])
    height = int(job["height"])
    frame_count = int(job["frame_count"])
    grouped: dict[int, list[tuple[list[list[float]], int]]] = {}
    correction_frames: set[int] = set()
    for stroke in job["corrections"]:
        if not isinstance(stroke, dict) or stroke.get("mode") not in {"foreground", "background"}:
            fail("correction stroke invalid")
        frame = int(bounded_number(stroke.get("frame"), "correction frame", 0, frame_count - 1))
        grouped.setdefault(frame, []).append((expand_stroke_points(stroke, width, height), 1 if stroke["mode"] == "foreground" else 0))
        correction_frames.add(frame)
    for frame, groups in grouped.items():
        points = np.asarray([point for group, _ in groups for point in group], dtype=np.float32)
        labels = np.asarray([label for group, label in groups for _ in group], dtype=np.int32)
        predictor.add_new_points_or_box(state, frame, 1, points=points, labels=labels, clear_old_points=True)
    return correction_frames


def collect_masks(iterator, job: dict[str, object], masks: dict, inference_ms: list[float], torch, device, np) -> None:
    width = int(job["width"])
    height = int(job["height"])
    feather = float(job["feather"])
    edge_shift = float(job["edge_shift"])
    contrast = float(job["contrast"])
    while True:
        torch.cuda.synchronize(device)
        frame_started = time.perf_counter()
        try:
            frame_index, _, logits = next(iterator)
        except StopIteration:
            break
        adjusted = (logits[0].float() - edge_shift * 4.0) * max(0.05, contrast)
        alpha = torch.sigmoid(adjusted).squeeze()
        if feather > 0:
            radius = min(31, max(1, round(feather * min(width, height))))
            kernel = radius * 2 + 1
            alpha = torch.nn.functional.avg_pool2d(alpha[None, None], kernel, stride=1, padding=radius).squeeze()
        masks[int(frame_index)] = alpha.detach().cpu().numpy().astype(np.float32)
        torch.cuda.synchronize(device)
        inference_ms.append((time.perf_counter() - frame_started) * 1000.0)


def run_sam(job: dict[str, object]) -> dict[str, object]:
    source_root = Path(job["source_root"])
    request = job["request"]
    sys.path.insert(0, str(source_root))

    import numpy as np
    import torch
    from sam2.build_sam import build_sam2_video_predictor

    if not torch.cuda.is_available():
        fail("CUDA unavailable for the measured SAM 2.1 runtime cell")
    device = torch.device("cuda")
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats(device)
    started = time.perf_counter()
    predictor = build_sam2_video_predictor(
        str(request.get("configName")),
        str(job["checkpoint_path"]),
        device=device,
        apply_postprocessing=False,
        vos_optimized=False,
    )
    model_load_ms = (time.perf_counter() - started) * 1000.0
    masks: dict[int, np.ndarray] = {}
    inference_ms: list[float] = []
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.float16):
        state_started = time.perf_counter()
        state = predictor.init_state(str(job["frame_directory"]), offload_video_to_cpu=True, offload_state_to_cpu=False, async_loading_frames=False)
        if int(state["video_width"]) != job["width"] or int(state["video_height"]) != job["height"] or int(state["num_frames"]) != job["frame_count"]:
            fail("SAM 2 decoded frame geometry mismatch")
        state_init_ms = (time.perf_counter() - state_started) * 1000.0
        width = int(job["width"])
        height = int(job["height"])
        initial_frame = int(job["initial_frame"])
        frame_count = int(job["frame_count"])
        rx, ry, rw, rh = job["rect"]
        box = np.asarray([rx * width, ry * height, (rx + rw) * width - 1, (ry + rh) * height - 1], dtype=np.float32)
        predictor.add_new_points_or_box(state, initial_frame, 1, box=box)
        correction_frames = add_correction_prompts(predictor, state, job, np)
        collect_masks(iter(predictor.propagate_in_video(state, start_frame_idx=initial_frame, max_frame_num_to_track=frame_count, reverse=False)), job, masks, inference_ms, torch, device, np)
        if initial_frame > 0:
            collect_masks(iter(predictor.propagate_in_video(state, start_frame_idx=initial_frame, max_frame_num_to_track=frame_count, reverse=True)), job, masks, inference_ms, torch, device, np)

    return {
        "masks": masks,
        "inference_ms": inference_ms,
        "correction_frames": correction_frames,
        "model_load_ms": model_load_ms,
        "state_init_ms": state_init_ms,
        "started": started,
        "torch": torch,
        "device": device,
    }


def write_frozen_alpha(job: dict[str, object], run: dict[str, object], np):
    masks = run["masks"]
    frame_count = int(job["frame_count"])
    output_directory = Path(job["output_directory"])
    preview_directory = Path(job["preview_directory"])
    width = int(job["width"])
    height = int(job["height"])
    temporal = float(job["temporal"])
    initial_frame = int(job["initial_frame"])
    analysis_fps = float(job["analysis_fps"])
    correction_frames = run["correction_frames"]
    alpha_path = output_directory / "matte-alpha8.bin"
    frame_receipts: list[dict[str, object]] = []
    previous: np.ndarray | None = None
    chatter_values: list[float] = []
    with alpha_path.open("wb") as alpha_file:
        for frame in range(frame_count):
            alpha = masks[frame]
            if previous is not None and temporal > 0 and frame not in correction_frames and frame != initial_frame:
                alpha = alpha * (1.0 - temporal) + previous * temporal
            alpha = np.clip(alpha, 0.0, 1.0)
            payload = np.rint(alpha * 255.0).astype(np.uint8).tobytes()
            alpha_file.write(payload)
            preview = preview_directory / f"{frame:06d}.png"
            preview_payload = write_gray_png(preview, width, height, payload)
            binary = alpha >= 0.5
            chatter = 0.0
            if previous is not None:
                prior_binary = previous >= 0.5
                band = boundary_band(binary) | boundary_band(prior_binary)
                denominator = int(band.sum())
                chatter = float(np.logical_xor(binary, prior_binary)[band].sum() / denominator) if denominator else 0.0
            chatter_values.append(chatter)
            confidence = float(np.mean(np.abs(alpha - 0.5) * 2.0))
            frame_receipts.append({
                "frame": frame,
                "time": frame / analysis_fps,
                "alphaPath": str(preview),
                "confidence": confidence,
                "foregroundRatio": float(binary.mean()),
                "boundaryChatter": chatter,
                "previewSha256": hashlib.sha256(preview_payload).hexdigest(),
                "alphaFrameSha256": hashlib.sha256(payload).hexdigest(),
            })
            previous = alpha
    return alpha_path, frame_receipts, chatter_values


def freeze_result(job: dict[str, object], run: dict[str, object]) -> dict[str, object]:
    import numpy as np

    request = job["request"]
    masks = run["masks"]
    frame_count = int(job["frame_count"])
    if sorted(masks) != list(range(frame_count)):
        fail("SAM 2 propagation did not return every frame")
    output_directory = Path(job["output_directory"])
    width = int(job["width"])
    height = int(job["height"])
    initial_frame = int(job["initial_frame"])
    analysis_fps = float(job["analysis_fps"])
    correction_frames = run["correction_frames"]
    alpha_path, frame_receipts, chatter_values = write_frozen_alpha(job, run, np)
    model = request.get("model")
    if not isinstance(model, dict):
        fail("bound model receipt missing")
    torch = run["torch"]
    device = run["device"]
    inference_ms = run["inference_ms"]
    elapsed_ms = (time.perf_counter() - float(run["started"])) * 1000.0
    result = {
        "schema": "editkin.auto-roto-matte/v1",
        "engine": "editkin-sam21-video-memory-roto/v1",
        "width": width,
        "height": height,
        "analysisFps": analysis_fps,
        "initialFrame": initial_frame,
        "sequencePath": str(alpha_path),
        "sequenceSha256": hashlib.sha256(alpha_path.read_bytes()).hexdigest(),
        "sequenceBytes": alpha_path.stat().st_size,
        "frames": frame_receipts,
        "meanBoundaryChatter": float(sum(chatter_values) / len(chatter_values)),
        "correctionStrokesApplied": len(job["corrections"]),
        "correctedFrames": sorted(correction_frames),
        "sam2Model": {
            **model,
            "runtime": {
                "python": sys.version.split()[0],
                "torch": torch.__version__,
                "cudaRuntime": torch.version.cuda,
                "gpu": torch.cuda.get_device_name(device),
                "modelLoadMs": run["model_load_ms"],
                "stateInitializationMs": run["state_init_ms"],
                "propagationP95Ms": float(np.percentile(np.asarray(inference_ms), 95)) if inference_ms else 0.0,
                "propagationMeanMs": float(np.mean(np.asarray(inference_ms))) if inference_ms else 0.0,
                "peakAllocatedBytes": int(torch.cuda.max_memory_allocated(device)),
                "peakReservedBytes": int(torch.cuda.max_memory_reserved(device)),
                "elapsedMs": elapsed_ms,
            },
        },
        "frozen": True,
    }
    (output_directory / "matte-manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> int:
    if len(sys.argv) != 2 or os.environ.get("EDITKIN_AUTO_ROTO_OFFLINE") != "1":
        fail("offline request contract required")
    job = prepare_job(absolute_file(sys.argv[1], "request"))
    result = freeze_result(job, run_sam(job))
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        sys.stderr.write(f"AUTO_ROTO_SAM21_ERROR {type(error).__name__}: {error}\n")
        raise
