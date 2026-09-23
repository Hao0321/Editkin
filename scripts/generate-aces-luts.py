from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

DEV_OCIO = Path(__file__).resolve().parents[3] / ".tools" / "pyocio-2.5.2"
if DEV_OCIO.exists():
    sys.path.insert(0, str(DEV_OCIO))
import PyOpenColorIO as ocio

ROOT = Path(__file__).resolve().parent.parent
COLOR_ROOT = ROOT / "public" / "color" / "aces2"
CONFIG_NAME = "studio-config-v4.0.0_aces-v2.0_ocio-v2.5.ocio"
CONFIG_SHA256 = "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbaFAC1029A".lower()
CUBE_SIZE = 65

INPUTS = {
    "rec709": "Camera Rec.709",
    "srgb": "sRGB Encoded Rec.709 (sRGB)",
    "hlg": "Rec.2100-HLG - Display",
    "pq": "Rec.2100-PQ - Display",
    "acescct": "ACEScct",
    "apple_log": "Apple Log",
    "arri_logc3": "ARRI LogC3 (EI800)",
    "arri_logc4": "ARRI LogC4",
    "bmd_film_gen5": "BMDFilm WideGamut Gen5",
    "canon_log2": "CanonLog2 CinemaGamut D55",
    "canon_log3": "CanonLog3 CinemaGamut D55",
    "dji_dlog": "D-Log D-Gamut",
    "panasonic_vlog": "V-Log V-Gamut",
    "red_log3g10": "Log3G10 REDWideGamutRGB",
    "sony_slog3_cine": "S-Log3 S-Gamut3.Cine",
}
INPUT_CUBE_SIZES = {key: (97 if key in {"arri_logc4", "dji_dlog", "panasonic_vlog"} else CUBE_SIZE) for key in INPUTS}

OUTPUTS = {
    "rec709_sdr": ("sRGB - Display", "ACES 2.0 - SDR 100 nits (Rec.709)"),
    "p3d65_sdr": ("Display P3 - Display", "ACES 2.0 - SDR 100 nits (P3 D65)"),
    "rec2100_hlg_1000": ("Rec.2100-HLG - Display", "ACES 2.0 - HDR 1000 nits (P3 D65)"),
    "rec2100_pq_1000": ("Rec.2100-PQ - Display", "ACES 2.0 - HDR 1000 nits (Rec.2020)"),
}
OUTPUT_CUBE_SIZES = {"rec709_sdr": 65, "p3d65_sdr": 65, "rec2100_hlg_1000": 129, "rec2100_pq_1000": 129}
BLOCKED_LUT_PAIRS = {
    "panasonic_vlog->rec2100_pq_1000": "雙 3D LUT 的極端高彩度 p99 誤差超標；等待原生 OCIO processor",
    "dji_dlog->rec2100_pq_1000": "雙 3D LUT 的極端高彩度 p99 誤差超標；等待原生 OCIO processor",
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def bake_input(config: ocio.Config, source: str, cube_size: int) -> str:
    if source == "ACEScct":
        lines = [f"LUT_3D_SIZE {cube_size}"]
        for blue in range(cube_size):
            for green in range(cube_size):
                for red in range(cube_size):
                    lines.append(f"{red / (cube_size - 1):.6f} {green / (cube_size - 1):.6f} {blue / (cube_size - 1):.6f}")
        return "\n".join(lines) + "\n"
    baker = ocio.Baker()
    baker.setConfig(config)
    baker.setFormat("resolve_cube")
    baker.setCubeSize(cube_size)
    baker.setInputSpace(source)
    baker.setTargetSpace("ACEScct")
    return baker.bake()


def bake_output(config: ocio.Config, display: str, view: str, cube_size: int) -> str:
    baker = ocio.Baker()
    baker.setConfig(config)
    baker.setFormat("resolve_cube")
    baker.setCubeSize(cube_size)
    baker.setInputSpace("ACEScct")
    baker.setDisplayView(display, view)
    return baker.bake()


def main() -> None:
    config_path = COLOR_ROOT / CONFIG_NAME
    if sha(config_path) != CONFIG_SHA256:
        raise SystemExit("ACES config missing or hash mismatch; run aces:acquire first")
    if ocio.__version__ != "2.5.2":
        raise SystemExit(f"PyOpenColorIO 2.5.2 required, got {ocio.__version__}")
    config = ocio.Config.CreateFromFile(str(config_path))
    output_root = COLOR_ROOT / "luts"
    output_root.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, object] = {
        "schemaVersion": 1,
        "standard": "ACES 2.0",
        "ocioVersion": ocio.__version__,
        "config": CONFIG_NAME,
        "configSha256": CONFIG_SHA256,
        "cubeSize": {"inputs": INPUT_CUBE_SIZES, "outputs": OUTPUT_CUBE_SIZES},
        "workingSpace": "ACEScct",
        "blockedLutPairs": BLOCKED_LUT_PAIRS,
        "inputs": {},
        "outputs": {},
    }
    for key, source in INPUTS.items():
        path = output_root / f"input-{key}-to-acescct.cube"
        path.write_text(bake_input(config, source, INPUT_CUBE_SIZES[key]), encoding="utf-8", newline="\n")
        manifest["inputs"][key] = {"colorSpace": source, "cubeSize": INPUT_CUBE_SIZES[key], "file": f"luts/{path.name}", "sha256": sha(path)}
    for key, (display, view) in OUTPUTS.items():
        path = output_root / f"output-acescct-to-{key}.cube"
        path.write_text(bake_output(config, display, view, OUTPUT_CUBE_SIZES[key]), encoding="utf-8", newline="\n")
        manifest["outputs"][key] = {"display": display, "view": view, "cubeSize": OUTPUT_CUBE_SIZES[key], "file": f"luts/{path.name}", "sha256": sha(path)}
    manifest_path = COLOR_ROOT / "editkin-aces2.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"ACES_LUTS_READY {sha(manifest_path)}")


if __name__ == "__main__":
    main()
