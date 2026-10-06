"""Derive glyph advance widths for every bundled render face (offline, deterministic).

Motion Design v3 lays text out before libass or the browser renders it, so panels,
rules and counters can hug the copy. Advances depend only on the source font and
the instanced weight, never on the staged static-face bytes, so this reads the
committed variable sources directly. Usage:

    python scripts/build-font-advance-metrics.py            # verify the committed table
    python scripts/build-font-advance-metrics.py --write    # regenerate it
"""
import argparse, hashlib, json, pathlib
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'src' / 'generated' / 'fontAdvanceMetrics.json'
ASCII = ''.join(chr(code) for code in range(0x20, 0x7F))
EXTRA = '·×÷–—‘’“”…°‰€£¥•→←↑↓✓★「」『』（），。、：；！？＋－％'
CJK_PROBE = '中'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def subset_font(path, text):
    options = subset.Options()
    options.layout_features = []
    options.notdef_outline = True
    options.name_IDs = ['*']
    options.glyph_names = True
    font = TTFont(path, recalcTimestamp=False)
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    return font


def face_advances(source, weight, axes):
    font = subset_font(source, ASCII + EXTRA + CJK_PROBE)
    if axes:
        instantiateVariableFont(font, {**axes, 'wght': weight}, inplace=True)
    cmap, metrics = font.getBestCmap(), font['hmtx'].metrics
    advance = lambda char: metrics[cmap[ord(char)]][0] if ord(char) in cmap else None
    units = font['head'].unitsPerEm
    return {
        'unitsPerEm': units,
        'cjk': advance(CJK_PROBE),
        'ascii': [advance(char) or 0 for char in ASCII],
        'extra': {char: advance(char) for char in EXTRA if advance(char) is not None},
    }


def build(fonts):
    manifest_bytes = (fonts / 'editkin-open-fonts.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    faces = []
    for item in manifest['fonts']:
        source = fonts / item['file']
        if digest(source.read_bytes()) != item['sha256']:
            raise ValueError('font source hash mismatch: ' + item['file'])
        probe = TTFont(source, lazy=True)
        axes = {axis.axisTag: axis.defaultValue for axis in probe['fvar'].axes} if 'fvar' in probe else {}
        probe.close()
        for face in item['faces']:
            faces.append({'id': face['id'], **face_advances(source, face['weight'], axes)})
    return {'schema': 'editkin.font-advance-metrics/v1', 'manifestSha256': digest(manifest_bytes),
            'ascii': ASCII, 'faces': faces}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fonts', default=str(ROOT / 'public' / 'fonts'))
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    document = build(pathlib.Path(args.fonts))
    text = json.dumps(document, ensure_ascii=False, separators=(',', ':')) + '\n'
    if args.write:
        OUTPUT.write_text(text, encoding='utf-8', newline='\n')
    elif OUTPUT.read_text(encoding='utf-8') != text:
        raise SystemExit('font advance metrics are stale; rerun with --write')
    print(json.dumps({'status': 'VERIFIED_FONT_ADVANCE_METRICS', 'faces': len(document['faces']),
                      'bytes': len(text.encode('utf-8'))}))


if __name__ == '__main__':
    main()
