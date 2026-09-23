from __future__ import annotations

import hashlib
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEV_OCIO = ROOT.parents[1] / ".tools" / "pyocio-2.5.2"
if DEV_OCIO.exists():
    sys.path.insert(0, str(DEV_OCIO))

import PyOpenColorIO as ocio

COLOR_ROOT = ROOT / "public" / "color" / "aces2"
CONFIG = COLOR_ROOT / "studio-config-v4.0.0_aces-v2.0_ocio-v2.5.ocio"
CONFIG_SHA256 = "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a"
MAGIC = b"EKF32V1\0"
OUTPUTS = {
    "hlg": ("Rec.2100-HLG - Display", "ACES 2.0 - HDR 1000 nits (P3 D65)"),
    "pq": ("Rec.2100-PQ - Display", "ACES 2.0 - HDR 1000 nits (Rec.2020)"),
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[3] not in OUTPUTS:
        raise SystemExit("usage: aces2-native-hdr-reference.py <input.ekf32> <output.rgba16le> <hlg|pq>")
    if ocio.__version__ != "2.5.2" or sha256(CONFIG) != CONFIG_SHA256:
        raise SystemExit("pinned OCIO 2.5.2 / ACES 2 config is unavailable or changed")
    source = Path(sys.argv[1]).read_bytes()
    if len(source) < 16 or source[:8] != MAGIC:
        raise SystemExit("invalid EKF32 input")
    width, height = struct.unpack_from("<II", source, 8)
    if width == 0 or height == 0 or len(source) != 16 + width * height * 16:
        raise SystemExit("invalid EKF32 dimensions or payload")
    display, view = OUTPUTS[sys.argv[3]]
    config = ocio.Config.CreateFromFile(str(CONFIG))
    processor = config.getProcessor(
        "Linear Rec.709 (sRGB)", display, view, ocio.TRANSFORM_DIR_FORWARD
    )
    cpu = processor.getDefaultCPUProcessor()
    output = bytearray(width * height * 8)
    for pixel_index, rgba in enumerate(struct.iter_unpack("<ffff", source[16:])):
        if not all(math.isfinite(value) for value in rgba) or not 0.0 <= rgba[3] <= 1.0:
            raise SystemExit("non-finite source or invalid alpha")
        display_rgb = [0.0, 0.0, 0.0] if rgba[3] <= 0.000001 else cpu.applyRGB(list(rgba[:3]))
        codes = [
            int(math.floor(max(0.0, min(1.0, channel)) * 65535.0 + 0.5))
            for channel in display_rgb
        ]
        alpha_code = int(math.floor(struct.unpack("<f", struct.pack("<f", rgba[3] * 65535.0))[0] + 0.5))
        struct.pack_into("<HHHH", output, pixel_index * 8, *codes, alpha_code)
    Path(sys.argv[2]).write_bytes(output)
    print(json.dumps({
        "schema": "editkin.ocio-aces2-hdr-cpu-reference/v1",
        "ocioVersion": ocio.__version__,
        "acesVersion": "2.0",
        "configSha256": CONFIG_SHA256,
        "processorCacheId": processor.getCacheID(),
        "output": sys.argv[3],
        "display": display,
        "view": view,
        "width": width,
        "height": height,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
