"""Review evidence for subject matte v1 (run with ``python -I``).

Given a source video and its subject matte (from subject_matte_v1.py), writes:
  * contact_sheet.jpg - 12 sampled frames, each as source | matte | huge word behind the subject;
  * behind_subject_5s.mp4 - an FFmpeg overlay composite (source -> word -> source keyed by the matte);
  * evidence.json - sampled frame indices, edge-band statistics and the commands used.

The word is a test graphic for art review only (Bebas Neue, OFL, from public/fonts). It is not a
template and it is not certified art.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
APP = HERE.parents[2]
HLG_TO_SDR = "zscale=t=linear:npl=100:agamma=0,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv"
BELOW_NORMAL = 0x00004000


def flags():
    return {"creationflags": BELOW_NORMAL | subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def tool(name):
    vendored = APP / "vendor" / "ffmpeg" / "win32-x64" / f"{name}.exe"
    return str(vendored) if vendored.is_file() else name


def probe(path):
    out = subprocess.run([tool("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,color_transfer:stream_side_data=rotation",
                          "-of", "json", str(path)], capture_output=True, check=True, **flags())
    stream = json.loads(out.stdout)["streams"][0]
    rotation = 0
    for item in stream.get("side_data_list") or []:
        if "rotation" in item:
            rotation = int(round(float(item["rotation"])))
    w, h = stream["width"], stream["height"]
    if rotation % 180:
        w, h = h, w
    return {"width": w, "height": h, "rate": stream["r_frame_rate"], "transfer": stream.get("color_transfer") or ""}


def decode_frames(path, width, height, filters, pix_fmt, channels):
    import numpy as np
    chain = ",".join([f for f in filters if f] + [f"scale={width}:{height}:flags=area", f"format={pix_fmt}"])
    proc = subprocess.Popen([tool("ffmpeg"), "-nostdin", "-v", "error", "-i", str(path), "-map", "0:v:0", "-fps_mode", "passthrough", "-vf", chain,
                             "-f", "rawvideo", "-pix_fmt", pix_fmt, "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **flags())
    size = width * height * channels
    frames = []
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        frames.append(np.frombuffer(buf, np.uint8).reshape((height, width, channels) if channels > 1 else (height, width)))
    proc.wait()
    return frames


def render_word(width, height, word, color, font_path, y_center):
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
    import numpy as np
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    size = int(height * 0.30)
    font = ImageFont.truetype(str(font_path), size)
    draw = ImageDraw.Draw(canvas)
    while True:
        box = draw.textbbox((0, 0), word, font=font)
        if box[2] - box[0] <= width * 1.04 or size < 40:  # bleeding a little off-frame is part of the look
            break
        size = int(size * 0.94)
        font = ImageFont.truetype(str(font_path), size)
    box = draw.textbbox((0, 0), word, font=font)
    x = (width - (box[2] - box[0])) // 2 - box[0]
    y = int(height * y_center) - (box[3] - box[1]) // 2 - box[1]
    shadow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).text((x, y + max(2, size // 40)), word, font=font, fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(2, size // 30)))
    ImageDraw.Draw(canvas).text((x, y), word, font=font, fill=color)
    return np.asarray(Image.alpha_composite(shadow, canvas))


def composite(src_rgb, matte_u8, word_rgba):
    import numpy as np
    s = src_rgb.astype(np.float32)
    ta = word_rgba[..., 3:4].astype(np.float32) / 255.0
    behind = s * (1 - ta) + word_rgba[..., :3].astype(np.float32) * ta
    m = (matte_u8.astype(np.float32) / 255.0)[..., None]
    return np.clip(behind * (1 - m) + s * m + 0.5, 0, 255).astype(np.uint8)


def main(argv=None):
    import cv2
    import numpy as np
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("matte", type=Path)
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--word", default="BEHIND")
    parser.add_argument("--color", default="#FCCC2C", help="S3 lifestyle_promo accent (measured R3 yellow)")
    parser.add_argument("--y", type=float, default=0.42, help="vertical centre of the word, 0..1")
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--duration", type=float, default=5.0)
    parser.add_argument("--font", type=Path, default=APP / "public" / "fonts" / "BebasNeue-Regular.ttf")
    parser.add_argument("--samples", type=int, default=12)
    args = parser.parse_args(argv)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    info = probe(args.source)
    mat = probe(args.matte)
    if (mat["width"], mat["height"]) != (info["width"], info["height"]):
        raise SystemExit("matte size differs from source")
    tonemap = HLG_TO_SDR if info["transfer"] == "arib-std-b67" else ""
    sheet_w = 360
    sheet_h = int(round(sheet_w * info["height"] / info["width"] / 2) * 2)
    src = decode_frames(args.source, sheet_w, sheet_h, [tonemap], "rgb24", 3)
    mats = decode_frames(args.matte, sheet_w, sheet_h, [], "gray", 1)
    if len(src) != len(mats):
        raise SystemExit(f"frame count differs: source {len(src)} matte {len(mats)}")
    color = tuple(int(args.color[i:i + 2], 16) for i in (1, 3, 5)) + (255,)
    word_small = render_word(sheet_w, sheet_h, args.word, color, args.font, args.y)
    picks = [int(round(i * (len(src) - 1) / (args.samples - 1))) for i in range(args.samples)]
    cells = []
    for index in picks:
        s, m = src[index], mats[index]
        comp = composite(s, m, word_small)
        cell = np.hstack([s, cv2.cvtColor(m, cv2.COLOR_GRAY2RGB), comp])
        cv2.putText(cell, f"frame {index}", (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
        cells.append(cell)
    rows = [np.hstack(cells[i:i + 2]) if i + 1 < len(cells) else np.hstack([cells[i], np.zeros_like(cells[i])]) for i in range(0, len(cells), 2)]
    sheet = np.vstack([np.vstack([r, np.full((6, r.shape[1], 3), 40, np.uint8)]) for r in rows])
    cv2.imwrite(str(args.out_dir / "contact_sheet.jpg"), cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 90])

    # Edge-band statistics on the sampled frames: share of soft (non-binary) matte pixels.
    soft = [float(((m > 12) & (m < 243)).mean()) for m in (mats[i] for i in picks)]

    # Full-resolution 5 s FFmpeg overlay composite: source -> word -> source keyed by the matte (alphamerge).
    word_full = render_word(info["width"], info["height"], args.word, color, args.font, args.y)
    word_png = args.out_dir / "test_word.png"
    cv2.imwrite(str(word_png), cv2.cvtColor(word_full, cv2.COLOR_RGBA2BGRA))
    out_mp4 = args.out_dir / "behind_subject_5s.mp4"
    graph = (f"[0:v]{tonemap + ',' if tonemap else ''}format=rgb24,split[base][fg];"
             f"[base][1:v]overlay=0:0:format=rgb[behind];"
             f"[2:v]format=gray[m];[fg]format=rgba[fga];[fga][m]alphamerge[cut];"
             f"[behind][cut]overlay=0:0:format=rgb,format=yuv420p[out]")
    command = [tool("ffmpeg"), "-nostdin", "-v", "error", "-ss", f"{args.start}", "-t", f"{args.duration}", "-i", str(args.source),
               "-loop", "1", "-framerate", info["rate"], "-i", str(word_png),
               "-ss", f"{args.start}", "-t", f"{args.duration}", "-i", str(args.matte),
               "-filter_complex", graph, "-map", "[out]", "-map", "0:a:0?", "-t", f"{args.duration}", "-c:v", "libx264", "-preset", "medium", "-crf", "16",
               "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-y", str(out_mp4)]
    subprocess.run(command, check=True, **flags())
    report = {"schema": "editkin.subject-matte-evidence/v1", "source": str(args.source), "matte": str(args.matte), "sampledFrames": picks,
              "decodedFrames": len(src), "softEdgePixelShareSampled": [round(v, 5) for v in soft], "word": args.word, "color": args.color,
              "font": str(args.font), "contactSheet": str(args.out_dir / "contact_sheet.jpg"), "composite": str(out_mp4),
              "compositeCommand": command, "qualityState": "diagnostic-art-review-required"}
    (args.out_dir / "evidence.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "contactSheet": report["contactSheet"], "composite": report["composite"]}, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
