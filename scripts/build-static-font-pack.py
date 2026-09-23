"""Offline deterministic static-face staging. Never edits/promotes the active pack."""
import argparse, concurrent.futures, hashlib, json, pathlib, shutil
import fontTools
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def build_face(job):
    source, output, font_id, weight, axes, source_sha = job
    font = TTFont(source, recalcTimestamp=False)
    if axes:
        instantiateVariableFont(font, {**axes, 'wght': weight}, inplace=True)
    assert 'fvar' not in font
    family = f'EditkinFace {font_id} {weight}'
    ps = f'EditkinFace-{font_id}-{weight}'
    names = {1: family, 2: 'Regular', 3: ps, 4: family, 6: ps, 16: family, 17: 'Regular'}
    for key in names:
        font['name'].removeNames(nameID=key)
        font['name'].setName(names[key], key, 3, 1, 0x409)
        font['name'].setName(names[key], key, 0, 4, 0)
    font['OS/2'].usWeightClass = weight
    font['OS/2'].fsSelection = (font['OS/2'].fsSelection & ~(1 | 32)) | 64
    font['head'].macStyle &= ~3
    target = pathlib.Path(output) / 'render' / (ps + '.ttf')
    font.save(target, reorderTables=True)
    font.close()
    check = TTFont(target, lazy=True)
    assert 'fvar' not in check and check['OS/2'].usWeightClass == weight
    assert check['name'].getDebugName(1) == family and check['name'].getDebugName(6) == ps
    check.close()
    return {'id': ps, 'weight': weight, 'file': 'render/' + ps + '.ttf', 'bytes': target.stat().st_size,
            'sha256': digest(target), 'family': family, 'postscriptName': ps, 'sourceSha256': source_sha}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--stage', required=True)
    parser.add_argument('--workers', type=int, default=2)
    args = parser.parse_args()
    source, stage = pathlib.Path(args.source).resolve(), pathlib.Path(args.stage).resolve()
    if stage.exists() or stage == source or source in stage.parents:
        raise ValueError('Stage must be a new directory outside source pack')
    manifest = json.loads((source / 'editkin-open-fonts.json').read_text(encoding='utf8'))
    stage.mkdir(parents=True)
    (stage / 'render').mkdir()
    jobs, provenance = [], []
    for item in manifest['fonts']:
        path = source / item['file']
        assert digest(path) == item['sha256'] and path.stat().st_size == item['bytes']
        license_path = source / item['licenseFile']
        shutil.copy2(path, stage / item['file'])
        shutil.copy2(license_path, stage / item['licenseFile'])
        item['licenseSha256'] = digest(license_path)
        font = TTFont(path, lazy=True)
        axes = {a.axisTag: a.defaultValue for a in font['fvar'].axes} if 'fvar' in font else {}
        ranges = {a.axisTag: [a.minValue, a.defaultValue, a.maxValue] for a in font['fvar'].axes} if 'fvar' in font else {}
        weights = list(range(int(ranges['wght'][0]), int(ranges['wght'][2]) + 1, 50)) if 'wght' in ranges else [400]
        font.close()
        item['faces'] = []
        provenance.append({'id': item['id'], 'sourceSha256': item['sha256'], 'licenseSha256': item['licenseSha256'], 'axes': ranges, 'weights': weights})
        jobs.extend((str(path), str(stage), item['id'], weight, axes, item['sha256']) for weight in weights)
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers) as pool:
        for face in pool.map(build_face, jobs):
            next(item for item in manifest['fonts'] if face['sourceSha256'] == item['sha256'])['faces'].append(face)
            print(face['id'], flush=True)
    manifest['schemaVersion'] = 2
    provenance_data = {'schema': 'editkin.static-font-provenance/v1', 'generator': 'scripts/build-static-font-pack.py',
                       'generatorSha256': digest(pathlib.Path(__file__)), 'fontToolsVersion': fontTools.__version__, 'families': provenance}
    provenance_path = stage / 'static-face-provenance.json'
    provenance_path.write_text(json.dumps(provenance_data, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    manifest['staticFaceProvenance'] = {'file': provenance_path.name, 'sha256': digest(provenance_path)}
    (stage / 'editkin-open-fonts.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'stage': str(stage), 'faces': len(jobs)}))

if __name__ == '__main__':
    main()
