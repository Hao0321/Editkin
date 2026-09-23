from __future__ import annotations

import hashlib
import json
import math
import platform
import statistics
import sys
import time
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def boundary(mask, np):
    padded = np.pad(mask, 1, mode="constant", constant_values=False)
    eroded = padded[1:-1, 1:-1].copy()
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        eroded &= padded[1 + dy : 1 + dy + mask.shape[0], 1 + dx : 1 + dx + mask.shape[1]]
    return mask & ~eroded


def dilate(mask, radius, np):
    padded = np.pad(mask, radius, mode="constant", constant_values=False)
    result = np.zeros_like(mask)
    height, width = mask.shape
    radius_sq = radius * radius
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy <= radius_sq:
                result |= padded[radius + dy : radius + dy + height, radius + dx : radius + dx + width]
    return result


def scores(predicted, truth, np):
    union = np.logical_or(predicted, truth).sum()
    j = 100.0 if union == 0 else 100.0 * np.logical_and(predicted, truth).sum() / union
    pred_boundary = boundary(predicted, np)
    truth_boundary = boundary(truth, np)
    tolerance = max(1, int(math.ceil(0.008 * math.hypot(*truth.shape))))
    pred_count = int(pred_boundary.sum())
    truth_count = int(truth_boundary.sum())
    if pred_count == 0 and truth_count == 0:
        f = 100.0
    elif pred_count == 0 or truth_count == 0:
        f = 0.0
    else:
        precision = float((pred_boundary & dilate(truth_boundary, tolerance, np)).sum()) / pred_count
        recall = float((truth_boundary & dilate(pred_boundary, tolerance, np)).sum()) / truth_count
        f = 0.0 if precision + recall == 0 else 200.0 * precision * recall / (precision + recall)
    return float(j), float(f)


def mean(values):
    return statistics.fmean(values) if values else 0.0


def evaluate_sequence(predictor, definition, davis_root, np, Image, torch):
    sequence_id = definition["id"]
    frame_root = davis_root / "JPEGImages" / "480p" / sequence_id
    annotation_root = davis_root / "Annotations" / "480p" / sequence_id
    frames = sorted(frame_root.glob("*.jpg"))
    annotations = sorted(annotation_root.glob("*.png"))
    if not frames or len(frames) != len(annotations):
        raise RuntimeError(f"Incomplete DAVIS sequence: {sequence_id}")
    first_truth = np.asarray(Image.open(annotations[0]), dtype=np.uint8)
    object_ids = [int(value) for value in np.unique(first_truth) if int(value) > 0 and int(value) != 255]
    if not object_ids:
        raise RuntimeError(f"No labeled objects in first frame: {sequence_id}")
    state_started = time.perf_counter()
    state = predictor.init_state(str(frame_root), offload_video_to_cpu=True, offload_state_to_cpu=False, async_loading_frames=False)
    state_seconds = time.perf_counter() - state_started
    for object_id in object_ids:
        predictor.add_new_mask(state, frame_idx=0, obj_id=object_id, mask=first_truth == object_id)
    frame_scores, propagated, latencies = [], [], []
    iterator = predictor.propagate_in_video(state, start_frame_idx=0, max_frame_num_to_track=len(frames), reverse=False)
    while True:
        torch.cuda.synchronize()
        frame_started = time.perf_counter()
        try:
            frame_index, output_ids, logits = next(iterator)
        except StopIteration:
            break
        torch.cuda.synchronize()
        latencies.append((time.perf_counter() - frame_started) * 1000.0)
        frame_index = int(frame_index)
        propagated.append(frame_index)
        if frame_index == 0:
            continue
        truth = np.asarray(Image.open(annotations[frame_index]), dtype=np.uint8)
        predicted_by_id = {int(output_ids[index]): (logits[index] > 0).detach().cpu().numpy().squeeze().astype(bool) for index in range(len(output_ids))}
        for object_id in object_ids:
            predicted = predicted_by_id.get(object_id, np.zeros_like(truth, dtype=bool))
            j, f = scores(predicted, truth == object_id, np)
            frame_scores.append({"frame": frame_index, "objectId": object_id, "j": j, "f": f, "jAndF": (j + f) / 2.0})
    if propagated != list(range(len(frames))):
        raise RuntimeError(f"Non-contiguous propagation: {sequence_id}")
    sequence_j = mean([item["j"] for item in frame_scores])
    sequence_f = mean([item["f"] for item in frame_scores])
    late_start = max(1, math.floor(len(frames) * 0.75))
    sequence = {
        "id": sequence_id, "tags": definition["tags"], "frames": len(frames), "objects": object_ids,
        "j": sequence_j, "f": sequence_f, "jAndF": (sequence_j + sequence_f) / 2.0,
        "lateQuartileJAndF": mean([item["jAndF"] for item in frame_scores if item["frame"] >= late_start]),
        "stateInitializationSeconds": state_seconds,
        "sourceIdentity": {
            "firstFrameSha256": sha256(frames[0]), "lastFrameSha256": sha256(frames[-1]),
            "firstAnnotationSha256": sha256(annotations[0]), "lastAnnotationSha256": sha256(annotations[-1]),
        },
    }
    del state
    torch.cuda.empty_cache()
    return sequence, [item["j"] for item in frame_scores], [item["f"] for item in frame_scores], latencies


def main() -> int:
    if len(sys.argv) != 6:
        raise SystemExit("usage: benchmark.py PACK_ROOT DAVIS_ROOT CONFIG REPORT CHECKPOINT")
    pack_root, davis_root, config_path, report_path, checkpoint = map(Path, sys.argv[1:])
    pack_manifest_path = pack_root / "manifest.json"
    pack_manifest = json.loads(pack_manifest_path.read_text(encoding="utf-8"))
    sys.path.insert(0, str(pack_root / "source"))
    import numpy as np
    import torch
    from PIL import Image
    from sam2.build_sam import build_sam2_video_predictor

    config = json.loads(config_path.read_text(encoding="utf-8"))
    thresholds = config["protocol"]["thresholds"]
    report_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    load_started = time.perf_counter()
    predictor = build_sam2_video_predictor(
        "configs/sam2.1/sam2.1_hiera_t.yaml", str(checkpoint), device="cuda",
        apply_postprocessing=False, vos_optimized=False,
    )
    model_load_seconds = time.perf_counter() - load_started
    sequences = []
    all_j, all_f, latencies = [], [], []
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.float16):
        for definition in config["sequences"]:
            sequence, sequence_j, sequence_f, sequence_latencies = evaluate_sequence(predictor, definition, davis_root, np, Image, torch)
            sequences.append(sequence)
            all_j.extend(sequence_j); all_f.extend(sequence_f); latencies.extend(sequence_latencies)
            print(f"AUTO_ROTO_DAVIS_PROGRESS sequence={sequence['id']} JF={sequence['jAndF']:.2f}", flush=True)
    aggregate_j = mean(all_j); aggregate_f = mean(all_f)
    aggregate_jf = (aggregate_j + aggregate_f) / 2.0
    checks = {
        "aggregateJAndF": aggregate_jf >= thresholds["aggregateJAndFMin"],
        "aggregateJ": aggregate_j >= thresholds["aggregateJMin"],
        "aggregateF": aggregate_f >= thresholds["aggregateFMin"],
        "perSequenceJAndF": all(item["jAndF"] >= thresholds["perSequenceJAndFMin"] for item in sequences),
        "lateQuartileJAndF": all(item["lateQuartileJAndF"] >= thresholds["lateQuartileJAndFMin"] for item in sequences),
        "diverseTags": len({tag for item in sequences for tag in item["tags"]}) >= 8,
        "completeSequences": len(sequences) == len(config["sequences"]),
    }
    status = "GREEN_DAVIS_HARDCASE" if all(checks.values()) else "FAIL"
    report = {
        "schema": "editkin.auto-roto-davis-hardcase-gate/v1", "status": status, "checks": checks,
        "protocol": config["protocol"], "dataset": config["dataset"], "sequences": sequences,
        "aggregate": {"j": aggregate_j, "f": aggregate_f, "jAndF": aggregate_jf, "evaluatedObjectFrames": len(all_j)},
        "runtime": {
            "platform": platform.platform(), "python": sys.version, "torch": torch.__version__, "cuda": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0), "modelLoadSeconds": model_load_seconds,
            "propagationMeanMs": mean(latencies), "propagationP95Ms": float(np.percentile(latencies, 95)),
            "peakAllocatedBytes": torch.cuda.max_memory_allocated(), "peakReservedBytes": torch.cuda.max_memory_reserved(),
            "elapsedSeconds": time.perf_counter() - started,
        },
        "artifacts": {
            "configSha256": sha256(config_path), "checkpointSha256": sha256(checkpoint),
            "pack": {
                "id": pack_manifest["id"], "version": pack_manifest["version"],
                "manifestSha256": sha256(pack_manifest_path), "receiptSha256": sha256(pack_root / "pack-receipt.json"),
                "publisherKeyId": pack_manifest["publisherKeyId"],
            },
        },
        "claimBoundary": "Internal non-commercial DAVIS screen for natural hair, articulated motion, blur, occlusion and reappearance. It does not prove transparency quality, public distribution rights, Adobe parity, or macOS parity.",
    }
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"AUTO_ROTO_DAVIS_RESULT status={status} JF={aggregate_jf:.2f} J={aggregate_j:.2f} F={aggregate_f:.2f} report={report_path}", flush=True)
    return 0 if status != "FAIL" else 1


if __name__ == "__main__":
    raise SystemExit(main())
