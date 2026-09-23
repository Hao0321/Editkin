from __future__ import annotations

import importlib.metadata
import json
import sys
from pathlib import Path


PACKAGES = (
    "torch", "torchvision", "numpy", "pillow", "hydra-core", "omegaconf", "iopath",
    "tqdm", "typing_extensions", "sympy", "networkx", "jinja2", "fsspec", "filelock",
    "mpmath", "markupsafe", "antlr4-python3-runtime", "portalocker", "pyyaml", "packaging", "pywin32",
)


def permitted(relative: Path) -> bool:
    lowered = tuple(part.lower() for part in relative.parts)
    if "__pycache__" in lowered or any(part in {"test", "tests"} for part in lowered):
        return False
    if relative.suffix.lower() in {".pyc", ".pyo", ".lib", ".h", ".hpp"}:
        return False
    if "include" in lowered or ("share" in lowered and "cmake" in lowered):
        return False
    return True


def main() -> None:
    site_files: dict[str, str] = {}
    versions: dict[str, str] = {}
    for name in PACKAGES:
        distribution = importlib.metadata.distribution(name)
        versions[name] = distribution.version
        for item in distribution.files or ():
            source = Path(distribution.locate_file(item)).resolve()
            if not source.is_file():
                continue
            parts = source.parts
            try:
                site_index = next(index for index, part in enumerate(parts) if part.lower() == "site-packages")
            except StopIteration:
                # Distribution console scripts and uninstall records are not runtime imports.
                continue
            relative = Path(*parts[site_index + 1:])
            if permitted(relative):
                site_files[relative.as_posix()] = str(source)
    base = Path(sys.base_prefix).resolve()
    print(json.dumps({
        "schema": "editkin.auto-roto-runtime-source/v1",
        "pythonVersion": sys.version.split()[0],
        "pythonHome": str(base),
        "pythonExecutable": str(base / "python.exe"),
        "versions": versions,
        "siteFiles": [{"relative": path, "source": site_files[path]} for path in sorted(site_files)],
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
