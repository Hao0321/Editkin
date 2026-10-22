"""Generate only the approved fresh-project BT.1886 SDR output. Never overwrite the old resources."""
from __future__ import annotations
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT.parents[1] / ".tools" / "pyocio-2.5.2"))
import PyOpenColorIO as ocio

CONFIG = ROOT / "public/color/aces2/studio-config-v4.0.0_aces-v2.0_ocio-v2.5.ocio"
EXPECTED = "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbaFAC1029A".lower()
if ocio.__version__ != "2.5.2" or hashlib.sha256(CONFIG.read_bytes()).hexdigest() != EXPECTED:
    raise SystemExit("Pinned OCIO/config mismatch")
config = ocio.Config.CreateFromFile(str(CONFIG))
baker = ocio.Baker()
baker.setConfig(config)
baker.setFormat("resolve_cube")
baker.setCubeSize(65)
baker.setInputSpace("ACEScct")
baker.setDisplayView("Rec.1886 Rec.709 - Display", "ACES 2.0 - SDR 100 nits (Rec.709)")
data = baker.bake().encode("utf-8")
target = ROOT / "public/color/aces2/luts/output-acescct-to-rec709_sdr_bt1886_v1.cube"
with target.open("xb") as stream:
    stream.write(data)
print(json.dumps({"path": str(target), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
    "ocioVersion": ocio.__version__, "configSha256": EXPECTED, "display": "Rec.1886 Rec.709 - Display",
    "view": "ACES 2.0 - SDR 100 nits (Rec.709)", "size": 65, "oldResourcesOverwritten": False}))
