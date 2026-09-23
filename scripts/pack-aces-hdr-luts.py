from __future__ import annotations

import hashlib
import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LUT_ROOT = ROOT / "public" / "color" / "aces2" / "luts"
LUT_SIZE = 129
SOURCES = {
    "rec2100_hlg_1000": "ab4a459ae1a284ceb34546ffe1bed664af6bdf6f43f4b7bc4ca562a4492a0eda",
    "rec2100_pq_1000": "0cad3aecbc3c5e12aec4f0c489bea6eb5a3a4c0e322aa28010468b856b6b121f",
}


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def parse_cube(payload: bytes) -> list[float]:
    values: list[float] = []
    declared_size: int | None = None
    for line_number, raw in enumerate(payload.decode("utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("TITLE"):
            continue
        fields = line.split()
        if fields[0] == "LUT_3D_SIZE":
            if len(fields) != 2 or declared_size is not None:
                raise ValueError(f"invalid LUT size declaration at line {line_number}")
            declared_size = int(fields[1])
            continue
        if fields[0] in {"DOMAIN_MIN", "DOMAIN_MAX"}:
            raise ValueError("HDR LUT must retain the exact normalized domain")
        if len(fields) != 3:
            raise ValueError(f"invalid LUT row at line {line_number}")
        values.extend(float(value) for value in fields)
    if declared_size != LUT_SIZE or len(values) != LUT_SIZE**3 * 3:
        raise ValueError(f"unexpected HDR LUT payload: size={declared_size}, floats={len(values)}")
    return values


def main() -> None:
    for output_space, expected_source_sha in SOURCES.items():
        source = LUT_ROOT / f"output-acescct-to-{output_space}.cube"
        source_bytes = source.read_bytes()
        if sha256(source_bytes) != expected_source_sha:
            raise ValueError(f"source LUT identity mismatch: {source.name}")
        raw = struct.pack(f"<{LUT_SIZE**3 * 3}f", *parse_cube(source_bytes))
        compressed = zlib.compress(raw, level=9)
        destination = LUT_ROOT / f"output-acescct-to-{output_space}.rgb-f32le.zlib"
        destination.write_bytes(compressed)
        print(
            f"{destination.relative_to(ROOT)} bytes={len(compressed)} "
            f"rawSha256={sha256(raw)} compressedSha256={sha256(compressed)}"
        )


if __name__ == "__main__":
    main()
