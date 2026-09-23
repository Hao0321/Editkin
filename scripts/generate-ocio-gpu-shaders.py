from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEV_OCIO = ROOT.parents[1] / ".tools" / "pyocio-2.5.2"
if DEV_OCIO.exists():
    sys.path.insert(0, str(DEV_OCIO))

import PyOpenColorIO as ocio

COLOR_ROOT = ROOT / "public" / "color" / "aces2"
OUTPUT_ROOT = COLOR_ROOT / "gpu"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def texture_receipt(texture: ocio.GpuShaderDesc.Texture) -> dict[str, object]:
    channels = 1 if texture.channel == ocio.GpuShaderDesc.TEXTURE_RED_CHANNEL else 3
    return {
        "name": texture.textureName,
        "sampler": texture.samplerName,
        "width": texture.width,
        "height": texture.height,
        "channels": channels,
        "interpolation": "nearest" if texture.interpolation == ocio.INTERP_NEAREST else "linear",
        "values": [float(value) for value in texture.getValues()],
    }


def uniform_receipt(name: str, uniform: ocio.GpuShaderDesc.UniformData) -> dict[str, object]:
    if uniform.type == ocio.UNIFORM_BOOL:
        kind, value = "bool", bool(uniform.getBool())
    elif uniform.type == ocio.UNIFORM_DOUBLE:
        kind, value = "float", float(uniform.getDouble())
    elif uniform.type == ocio.UNIFORM_FLOAT3:
        kind, value = "vec3", [float(item) for item in uniform.getFloat3()]
    else:
        raise RuntimeError(f"unsupported OCIO GPU uniform {name}: {uniform.type}")
    return {"name": name, "type": kind, "default": value}


def extract(processor: ocio.Processor, key: str, stage: str) -> dict[str, object]:
    gpu = processor.getDefaultGPUProcessor()
    descriptor = ocio.GpuShaderDesc.CreateShaderDesc()
    descriptor.setLanguage(ocio.GPU_LANGUAGE_GLSL_ES_3_0)
    descriptor.setFunctionName(f"editkin_{stage}_ocio")
    descriptor.setResourcePrefix(f"editkin_{stage}_")
    gpu.extractGpuShaderInfo(descriptor)
    if descriptor.get3DTextures():
        raise RuntimeError(f"{stage}/{key} unexpectedly requires a 3D texture")
    return {
        "schema": "editkin.ocio-gpu-stage/v1",
        "ocioVersion": ocio.__version__,
        "key": key,
        "stage": stage,
        "functionName": descriptor.getFunctionName(),
        "cacheId": descriptor.getCacheID(),
        "shaderText": descriptor.getShaderText(),
        "textures": [texture_receipt(texture) for texture in descriptor.getTextures()],
        "uniforms": [uniform_receipt(name, uniform) for name, uniform in descriptor.getUniforms()],
    }


def grade_values(definition: dict[str, float]) -> tuple[ocio.GradingPrimary, ocio.GradingTone]:
    clamp = lambda value, minimum, maximum: max(minimum, min(maximum, value))
    primary = ocio.GradingPrimary(ocio.GRADING_LOG)
    exposure_step = 1.0 / 17.52
    master = definition["brightness"] * 0.1 + definition["exposure"] * exposure_step
    primary.brightness = ocio.GradingRGBM(
        master + definition["temperature"] * 0.025,
        master + definition["tint"] * 0.02,
        master - definition["temperature"] * 0.025,
        0.0,
    )
    primary.contrast = ocio.GradingRGBM(definition["contrast"], definition["contrast"], definition["contrast"], 1.0)
    primary.pivot = 0.4 + (definition["pivot"] - 0.5) * 0.4
    primary.saturation = definition["saturation"]
    primary.clampBlack = -65504.0
    primary.clampWhite = 65504.0
    tone = ocio.GradingTone(ocio.GRADING_LOG)
    tone.blacks.master = clamp(1.0 + definition["blacks"] * 0.5, 0.01, 1.99)
    tone.shadows.master = clamp(1.0 + definition["shadows"] * 0.5, 0.01, 1.99)
    tone.highlights.master = clamp(1.0 + definition["highlights"] * 0.5, 0.01, 1.99)
    tone.whites.master = clamp(1.0 + definition["whites"] * 0.5, 0.01, 1.99)
    return primary, tone


def hue_rotate(rgb: list[float], degrees: float) -> list[float]:
    import math
    angle = math.radians(degrees)
    cosine, sine = math.cos(angle), math.sin(angle)
    y = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
    i = 0.595716 * rgb[0] - 0.274453 * rgb[1] - 0.321263 * rgb[2]
    q = 0.211456 * rgb[0] - 0.522591 * rgb[1] + 0.311135 * rgb[2]
    rotated_i, rotated_q = i * cosine - q * sine, i * sine + q * cosine
    return [
        y + 0.9563 * rotated_i + 0.6210 * rotated_q,
        y - 0.2721 * rotated_i - 0.6474 * rotated_q,
        y - 1.1070 * rotated_i + 1.7046 * rotated_q,
    ]


def load_config() -> tuple[dict[str, object], ocio.Config]:
    manifest_path = COLOR_ROOT / "editkin-aces2.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    config_path = COLOR_ROOT / manifest["config"]
    if sha256(config_path) != manifest["configSha256"]:
        raise SystemExit("ACES config SHA-256 mismatch")
    if ocio.__version__ != manifest["ocioVersion"]:
        raise SystemExit(f"PyOpenColorIO version mismatch: {ocio.__version__}")
    config = ocio.Config.CreateFromFile(str(config_path))
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    return manifest, config


def write_grade_stage() -> tuple[ocio.Processor, dict[str, object], Path]:
    primary_transform = ocio.GradingPrimaryTransform(style=ocio.GRADING_LOG, dynamic=True)
    tone_transform = ocio.GradingToneTransform(style=ocio.GRADING_LOG, dynamic=True)
    grade_processor = ocio.Config.CreateRaw().getProcessor(ocio.GroupTransform([primary_transform, tone_transform]))
    grade_receipt = extract(grade_processor, "primary-tone", "grade")
    grade_path = OUTPUT_ROOT / "grade-primary-tone.json"
    grade_path.write_text(json.dumps(grade_receipt, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return grade_processor, grade_receipt, grade_path


def write_cpu_references(
    manifest: dict[str, object], config: ocio.Config, grade_processor: ocio.Processor, grade_receipt: dict[str, object]
) -> None:
    reference_source = [46, 128, 230, 255]
    reference_grade = {
        "brightness": 0.08, "contrast": 1.12, "saturation": 0.9, "hue": 18.0,
        "exposure": 0.75, "temperature": 0.3, "tint": -0.2, "pivot": 0.55,
        "shadows": 0.2, "highlights": -0.15, "blacks": 0.1, "whites": -0.1,
    }
    reference_input = manifest["inputs"]["rec709"]
    reference_output = manifest["outputs"]["rec709_sdr"]
    input_processor = config.getProcessor(reference_input["colorSpace"], "ACEScct")
    output_processor = config.getProcessor("ACEScct", reference_output["display"], reference_output["view"], ocio.TRANSFORM_DIR_FORWARD)
    baseline_processor = config.getProcessor(reference_input["colorSpace"], reference_output["display"], reference_output["view"], ocio.TRANSFORM_DIR_FORWARD)
    grade_cpu = grade_processor.getDefaultCPUProcessor()
    primary, tone = grade_values(reference_grade)
    grade_cpu.getDynamicProperty(ocio.DYNAMIC_PROPERTY_GRADING_PRIMARY).setGradingPrimary(primary)
    grade_cpu.getDynamicProperty(ocio.DYNAMIC_PROPERTY_GRADING_TONE).setGradingTone(tone)
    baseline_rgb = baseline_processor.getDefaultCPUProcessor().applyRGB([channel / 255.0 for channel in reference_source[:3]])
    reference = {
        "schema": "editkin.ocio-cpu-reference/v1",
        "ocioVersion": ocio.__version__,
        "configSha256": manifest["configSha256"],
        "input": "rec709",
        "output": "rec709_sdr",
        "processorCacheId": baseline_processor.getCacheID(),
        "sourceRgba8": reference_source,
        "expectedRgba8": [round(max(0.0, min(1.0, value)) * 255) for value in baseline_rgb] + [255],
    }
    (OUTPUT_ROOT / "cpu-reference.json").write_text(
        json.dumps(reference, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    grade_rgb = input_processor.getDefaultCPUProcessor().applyRGB([channel / 255.0 for channel in reference_source[:3]])
    grade_rgb = grade_cpu.applyRGB(grade_rgb)
    grade_rgb = hue_rotate(grade_rgb, reference_grade["hue"])
    grade_rgb = output_processor.getDefaultCPUProcessor().applyRGB(grade_rgb)
    grade_reference = {
        "schema": "editkin.ocio-grade-cpu-reference/v1",
        "ocioVersion": ocio.__version__,
        "configSha256": manifest["configSha256"],
        "input": "rec709",
        "output": "rec709_sdr",
        "processorCacheId": f"{input_processor.getCacheID()}:{grade_processor.getCacheID()}:{output_processor.getCacheID()}",
        "gradeCacheId": grade_receipt["cacheId"],
        "grade": reference_grade,
        "sourceRgba8": reference_source,
        "expectedRgba8": [round(max(0.0, min(1.0, value)) * 255) for value in grade_rgb] + [255],
    }
    (OUTPUT_ROOT / "grade-cpu-reference.json").write_text(
        json.dumps(grade_reference, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def write_processor_stages(
    manifest: dict[str, object], config: ocio.Config, grade_path: Path
) -> list[dict[str, object]]:
    generated: list[dict[str, object]] = [{"stage": "grade", "key": "primary-tone", "file": grade_path.name, "sha256": sha256(grade_path)}]
    for key, definition in manifest["inputs"].items():
        receipt = extract(config.getProcessor(definition["colorSpace"], "ACEScct"), key, "input")
        path = OUTPUT_ROOT / f"input-{key}.json"
        path.write_text(json.dumps(receipt, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        generated.append({"stage": "input", "key": key, "file": path.name, "sha256": sha256(path)})
    for key, definition in manifest["outputs"].items():
        processor = config.getProcessor(
            "ACEScct",
            definition["display"],
            definition["view"],
            ocio.TRANSFORM_DIR_FORWARD,
        )
        receipt = extract(processor, key, "output")
        path = OUTPUT_ROOT / f"output-{key}.json"
        path.write_text(json.dumps(receipt, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        generated.append({"stage": "output", "key": key, "file": path.name, "sha256": sha256(path)})
    return generated


def write_index(manifest: dict[str, object], generated: list[dict[str, object]]) -> Path:
    index = {
        "schema": "editkin.ocio-gpu-index/v1",
        "ocioVersion": ocio.__version__,
        "configSha256": manifest["configSha256"],
        "workingSpace": "ACEScct",
        "generated": generated,
    }
    index_path = OUTPUT_ROOT / "index.json"
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return index_path


def main() -> None:
    manifest, config = load_config()
    grade_processor, grade_receipt, grade_path = write_grade_stage()
    write_cpu_references(manifest, config, grade_processor, grade_receipt)
    generated = write_processor_stages(manifest, config, grade_path)
    index_path = write_index(manifest, generated)
    print(json.dumps({"status": "GREEN", "files": len(generated), "index": str(index_path)}))


if __name__ == "__main__":
    main()
