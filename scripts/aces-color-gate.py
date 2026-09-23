from __future__ import annotations

import hashlib
import json
import random
import sys
from pathlib import Path

DEV_OCIO = Path(__file__).resolve().parents[3] / ".tools" / "pyocio-2.5.2"
if DEV_OCIO.exists():
    sys.path.insert(0, str(DEV_OCIO))
import PyOpenColorIO as ocio

ROOT = Path(__file__).resolve().parent.parent
COLOR_ROOT = ROOT / "public" / "color" / "aces2"
REPORT = ROOT / "reports" / "aces-color-gate.json"
MEAN_ERROR_LIMIT = 0.004
P99_ERROR_LIMIT = 0.03
SAMPLES_PER_TRANSFORM = 384


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_cube(path: Path) -> tuple[int, list[tuple[float, float, float]]]:
    size = 0
    values: list[tuple[float, float, float]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("TITLE"):
            continue
        fields = line.split()
        if fields[0] == "LUT_3D_SIZE":
            size = int(fields[1])
        elif fields[0] not in {"DOMAIN_MIN", "DOMAIN_MAX"}:
            values.append(tuple(map(float, fields[:3])))
    if size < 2 or len(values) != size**3:
        raise RuntimeError(f"Invalid cube: {path}")
    return size, values


def sample_cube(cube: tuple[int, list[tuple[float, float, float]]], rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    size, values = cube
    scaled = [max(0.0, min(1.0, value)) * (size - 1) for value in rgb]
    low = [min(size - 2, int(value)) for value in scaled]
    f = [scaled[index] - low[index] for index in range(3)]

    def at(dr: int, dg: int, db: int) -> tuple[float, float, float]:
        r, g, b = low[0] + dr, low[1] + dg, low[2] + db
        return values[r + g * size + b * size * size]

    c000, c100, c010, c001 = at(0, 0, 0), at(1, 0, 0), at(0, 1, 0), at(0, 0, 1)
    c110, c101, c011, c111 = at(1, 1, 0), at(1, 0, 1), at(0, 1, 1), at(1, 1, 1)
    result = []
    for channel in range(3):
        if f[0] >= f[1]:
            if f[1] >= f[2]:
                value = c000[channel] + f[0] * (c100[channel] - c000[channel]) + f[1] * (c110[channel] - c100[channel]) + f[2] * (c111[channel] - c110[channel])
            elif f[0] >= f[2]:
                value = c000[channel] + f[0] * (c100[channel] - c000[channel]) + f[2] * (c101[channel] - c100[channel]) + f[1] * (c111[channel] - c101[channel])
            else:
                value = c000[channel] + f[2] * (c001[channel] - c000[channel]) + f[0] * (c101[channel] - c001[channel]) + f[1] * (c111[channel] - c101[channel])
        elif f[2] >= f[1]:
            value = c000[channel] + f[2] * (c001[channel] - c000[channel]) + f[1] * (c011[channel] - c001[channel]) + f[0] * (c111[channel] - c011[channel])
        elif f[2] >= f[0]:
            value = c000[channel] + f[1] * (c010[channel] - c000[channel]) + f[2] * (c011[channel] - c010[channel]) + f[0] * (c111[channel] - c011[channel])
        else:
            value = c000[channel] + f[1] * (c010[channel] - c000[channel]) + f[0] * (c110[channel] - c010[channel]) + f[2] * (c111[channel] - c110[channel])
        result.append(value)
    return tuple(result)


def native_rgb(processor: ocio.CPUProcessor, rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    return tuple(processor.applyRGB(list(rgb)))


def transform_metrics(name: str, input_cube: tuple[int, list[tuple[float, float, float]]], output_cube: tuple[int, list[tuple[float, float, float]]], processor: ocio.CPUProcessor, seed: int) -> dict[str, float | str | int]:
    rng = random.Random(seed)
    samples = [(r, g, b) for r in (0.0, 0.001, 0.18, 0.5, 0.9, 1.0) for g in (0.0, 0.18, 1.0) for b in (0.0, 0.18, 1.0)]
    samples.extend((rng.random(), rng.random(), rng.random()) for _ in range(SAMPLES_PER_TRANSFORM))
    errors: list[float] = []
    for rgb in samples:
        baked = sample_cube(output_cube, sample_cube(input_cube, rgb))
        native = native_rgb(processor, rgb)
        errors.extend(abs(baked[channel] - native[channel]) for channel in range(3))
    errors.sort()
    return {
        "name": name,
        "samples": len(samples),
        "meanAbsoluteError": sum(errors) / len(errors),
        "p99AbsoluteError": errors[min(len(errors) - 1, int(len(errors) * 0.99))],
        "maxAbsoluteError": errors[-1],
    }


def main() -> None:
    manifest_path = COLOR_ROOT / "editkin-aces2.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if ocio.__version__ != manifest["ocioVersion"]:
        raise SystemExit(f"PyOpenColorIO version mismatch: {ocio.__version__}")
    config_path = COLOR_ROOT / manifest["config"]
    if sha256(config_path) != manifest["configSha256"]:
        raise SystemExit("ACES config SHA-256 mismatch")
    config = ocio.Config.CreateFromFile(str(config_path))
    input_cubes = {}
    output_cubes = {}
    for key, definition in manifest["inputs"].items():
        cube_path = COLOR_ROOT / definition["file"]
        if sha256(cube_path) != definition["sha256"]:
            raise SystemExit(f"LUT SHA-256 mismatch: {key}")
        input_cubes[key] = parse_cube(cube_path)
    for key, definition in manifest["outputs"].items():
        cube_path = COLOR_ROOT / definition["file"]
        if sha256(cube_path) != definition["sha256"]:
            raise SystemExit(f"LUT SHA-256 mismatch: {key}")
        output_cubes[key] = parse_cube(cube_path)
    metrics = []
    for input_index, (input_key, input_definition) in enumerate(manifest["inputs"].items()):
        for output_index, (output_key, output_definition) in enumerate(manifest["outputs"].items()):
            cpu = config.getProcessor(input_definition["colorSpace"], output_definition["display"], output_definition["view"], ocio.TRANSFORM_DIR_FORWARD).getDefaultCPUProcessor()
            metrics.append(transform_metrics(
                f"{input_key}->ACEScct->{output_key}", input_cubes[input_key], output_cubes[output_key], cpu,
                1000 + input_index * 10 + output_index,
            ))
    blocked_pairs = set(manifest.get("blockedLutPairs", {}))
    supported_metrics = [item for item in metrics if item["name"].replace("->ACEScct->", "->") not in blocked_pairs]
    if not supported_metrics:
        raise SystemExit("ACES manifest 不可把所有 transform 都標成 blocked")
    worst_mean = max(float(item["meanAbsoluteError"]) for item in supported_metrics)
    worst_max = max(float(item["maxAbsoluteError"]) for item in supported_metrics)
    worst_p99 = max(float(item["p99AbsoluteError"]) for item in supported_metrics)
    status = "GREEN" if worst_mean <= MEAN_ERROR_LIMIT and worst_p99 <= P99_ERROR_LIMIT else "RED"
    report = {
        "schemaVersion": 1,
        "status": status,
        "standard": manifest["standard"],
        "ocioVersion": manifest["ocioVersion"],
        "configSha256": manifest["configSha256"],
        "cubeSize": manifest["cubeSize"],
        "thresholds": {"meanAbsoluteError": MEAN_ERROR_LIMIT, "p99AbsoluteError": P99_ERROR_LIMIT},
        "blockedLutPairs": manifest.get("blockedLutPairs", {}),
        "supportedTransformCount": len(supported_metrics),
        "worst": {"meanAbsoluteError": worst_mean, "p99AbsoluteError": worst_p99, "diagnosticMaxAbsoluteError": worst_max},
        "transforms": metrics,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": status, "report": str(REPORT), "supportedTransformCount": len(supported_metrics), "blockedTransformCount": len(blocked_pairs), "worst": report["worst"]}, ensure_ascii=False))
    if status != "GREEN":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
