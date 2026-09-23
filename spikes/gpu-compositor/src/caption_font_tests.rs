//! Source-mode physical face contract tests. These do not certify a packaged render or shaping parity.
use super::*;
use hao_core::engine::model::NodeFrameRange;
use serde_json::{Value, json};

fn public_font_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../public/fonts")
}

fn public_manifest() -> FontManifest {
    serde_json::from_slice(&fs::read(public_font_root().join("editkin-open-fonts.json")).unwrap())
        .unwrap()
}

fn fixture_manifest() -> FontManifest {
    let fonts = [
        ("noto-sans-tc", "Noto Sans TC", 100, 900),
        ("noto-serif-tc", "Noto Serif TC", 200, 900),
        ("lxgw-wenkai-mono-tc", "LXGW WenKai Mono TC", 400, 400),
        ("bebas-neue", "Bebas Neue", 400, 400),
        ("fredoka", "Fredoka", 300, 700),
    ]
    .into_iter()
    .map(|(id, family, min, max)| {
        let source_hash = digest(id.as_bytes());
        FontEntry {
            id: id.into(),
            family: family.into(),
            file: format!("{id}.ttf"),
            bytes: 100,
            sha256: source_hash.clone(),
            faces: (min..=max)
                .step_by(50)
                .map(|weight| {
                    let face_id = format!("EditkinFace-{id}-{weight}");
                    FontFace {
                        id: face_id.clone(),
                        weight,
                        file: format!("render/{face_id}.ttf"),
                        bytes: 100,
                        sha256: digest(face_id.as_bytes()),
                        family: format!("EditkinFace {id} {weight}"),
                        postscript_name: face_id,
                        source_sha256: source_hash.clone(),
                    }
                })
                .collect(),
        }
    })
    .collect();
    FontManifest {
        schema_version: 2,
        id: "studio.hao.editkin-open-fonts".into(),
        fonts,
    }
}

#[test]
fn physical_face_selection_matches_all_five_family_weight_matrices() {
    let mut manifest = fixture_manifest();
    // Order is not an implicit tie breaker; the lower weight must win in either ordering.
    for entry in &mut manifest.fonts {
        entry.faces.reverse();
    }
    let requests = [
        100.0, 400.0, 425.0, 650.0, 675.0, 700.0, 800.0, 850.0, 900.0,
    ];
    let rows = [
        (
            "Noto Sans TC",
            [100, 400, 400, 650, 650, 700, 800, 850, 900],
        ),
        (
            "Noto Serif TC",
            [200, 400, 400, 650, 650, 700, 800, 850, 900],
        ),
        ("LXGW WenKai Mono TC", [400; 9]),
        ("Bebas Neue", [400; 9]),
        ("Fredoka", [300, 400, 400, 650, 650, 700, 700, 700, 700]),
    ];
    for (family, expected) in rows {
        for (requested, expected) in requests.into_iter().zip(expected) {
            let selection = resolve_font_face(&manifest, family, requested).unwrap();
            assert_eq!(selection.logical_family, family);
            assert_eq!(selection.requested_weight, requested);
            assert_eq!(selection.face.weight, expected, "{family}: {requested}");
            assert_eq!(selection.face.id, selection.face.postscript_name);
        }
    }
    assert_eq!(
        resolve_font_face(&manifest, "Noto Sans TC", 425.001)
            .unwrap()
            .face
            .weight,
        450
    );
    for invalid in [
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        0.0,
        99.999,
        900.001,
        1000.0,
    ] {
        assert!(
            resolve_font_face(&manifest, "Noto Sans TC", invalid)
                .unwrap_err()
                .to_string()
                .contains("finite")
        );
    }
    assert!(
        resolve_font_face(&manifest, "Unbundled User Font", 400.0)
            .unwrap_err()
            .to_string()
            .contains("not bundled")
    );
}

#[test]
fn rejects_invalid_schema_duplicates_unsafe_paths_and_identity_conflicts() {
    let good = fixture_manifest();
    validate_manifest(&good).unwrap();
    let mut variants = vec![];
    let mut bad = good.clone();
    bad.schema_version = 1;
    variants.push(("schema1", bad));
    let mut bad = good.clone();
    bad.fonts.clear();
    variants.push(("empty pack", bad));
    let mut bad = good.clone();
    bad.fonts.push(bad.fonts[0].clone());
    variants.push(("duplicate logical family", bad));
    let mut bad = good.clone();
    let duplicate = bad.fonts[0].faces[0].clone();
    bad.fonts[0].faces.push(duplicate);
    variants.push(("duplicate face", bad));
    let mut bad = good.clone();
    bad.fonts[0].faces.clear();
    variants.push(("missing faces", bad));
    let mut bad = good.clone();
    bad.fonts[0].faces[0].source_sha256 = "0".repeat(64);
    variants.push(("wrong source", bad));
    let mut bad = good.clone();
    bad.fonts[0].faces[0].sha256 = bad.fonts[0].faces[1].sha256.clone();
    variants.push(("same physical hash", bad));
    let mut bad = good.clone();
    bad.fonts[0].faces[0].family = "Noto Sans TC Thin".into();
    variants.push(("old name", bad));
    let mut bad = good.clone();
    bad.fonts[0].faces[0].postscript_name = "NotoSansTC-Thin".into();
    variants.push(("old PostScript", bad));
    let mut bad = good.clone();
    bad.fonts[0].faces[0].weight = 125;
    variants.push(("invalid grid", bad));
    let mut bad = good.clone();
    bad.fonts[0].faces[0].bytes = 0;
    variants.push(("empty bytes", bad));
    let mut bad = good.clone();
    bad.fonts[0].faces[0].bytes = 64 * 1024 * 1024 + 1;
    variants.push(("oversized bytes", bad));
    let mut bad = good.clone();
    bad.fonts[0].faces[0].sha256 = "Z".repeat(64);
    variants.push(("non-hash", bad));
    for path in [
        "../outside.ttf",
        "/outside.ttf",
        "C:/outside.ttf",
        "render\\outside.ttf",
        "render/../outside.ttf",
        "render//outside.ttf",
        "render/face.ttf.",
        "render/face.ttf ",
        "render/face.ttf:stream",
    ] {
        assert!(!safe_relative_file(path), "unsafe path accepted: {path}");
        let mut bad = good.clone();
        bad.fonts[0].faces[0].file = path.into();
        variants.push(("unsafe face path", bad));
        let mut bad = good.clone();
        bad.fonts[0].file = path.into();
        variants.push(("unsafe source path", bad));
    }
    for (reason, bad) in variants {
        assert!(validate_manifest(&bad).is_err(), "accepted {reason}");
    }
}

#[test]
fn actual_pack_all_43_faces_match_bytes_static_weight_and_internal_names() {
    let manifest = public_manifest();
    validate_manifest(&manifest).unwrap();
    let mut count = 0;
    for entry in &manifest.fonts {
        for face in &entry.faces {
            let path = checked_font_path(&public_font_root(), &face.file).unwrap();
            let bytes = fs::read(path).unwrap();
            assert_eq!(bytes.len() as u64, face.bytes);
            assert_eq!(digest(&bytes), face.sha256);
            validate_static_face_bytes(&bytes, face).unwrap();
            println!(
                "NATIVE_PHYSICAL_FACE {}",
                json!({"logicalFamily": entry.family, "faceId": face.id, "weight": face.weight, "bytes": face.bytes, "sha256": face.sha256})
            );
            count += 1;
        }
    }
    assert_eq!(manifest.fonts.len(), 5);
    assert_eq!(count, 43);
    // Test actual data selection too; a synthetic matrix alone cannot validate the staged pack.
    for (actual, fixture) in manifest.fonts.iter().map(|entry| {
        (
            entry,
            fixture_manifest()
                .fonts
                .into_iter()
                .find(|item| item.family == entry.family)
                .unwrap(),
        )
    }) {
        assert_eq!(
            actual
                .faces
                .iter()
                .map(|face| face.weight)
                .collect::<BTreeSet<_>>(),
            fixture
                .faces
                .iter()
                .map(|face| face.weight)
                .collect::<BTreeSet<_>>()
        );
    }
}

#[test]
fn real_glyph_metrics_and_rasters_change_with_physical_weight() {
    let (regular, regular_face) =
        load_bundled_font(&public_font_root(), "Noto Sans TC", 400.0).unwrap();
    let (bold, bold_face) = load_bundled_font(&public_font_root(), "Noto Sans TC", 800.0).unwrap();
    let width = |font: &Font| {
        "WAVE minimum 1700"
            .chars()
            .map(|character| font.metrics(character, 48.0).advance_width)
            .sum::<f32>()
    };
    let (regular_metrics, regular_glyph) = regular.rasterize('字', 48.0);
    let (bold_metrics, bold_glyph) = bold.rasterize('字', 48.0);
    assert_ne!(regular_face.face.sha256, bold_face.face.sha256);
    assert!(
        (width(&regular) - width(&bold)).abs() > 0.1,
        "physical Latin advance widths collapsed"
    );
    assert_ne!(
        digest(&regular_glyph),
        digest(&bold_glyph),
        "CJK weights collapsed to one glyph"
    );
    assert!(
        bold_glyph.iter().map(|byte| u64::from(*byte)).sum::<u64>()
            > regular_glyph
                .iter()
                .map(|byte| u64::from(*byte))
                .sum::<u64>()
    );
    println!(
        "NATIVE_GLYPH_EVIDENCE {}",
        json!({"logicalFamily": "Noto Sans TC", "regularFace": regular_face.face.id, "boldFace": bold_face.face.id, "regularSha256": regular_face.face.sha256, "boldSha256": bold_face.face.sha256, "regularAdvance": width(&regular), "boldAdvance": width(&bold), "regularGlyphWidth": regular_metrics.width, "boldGlyphWidth": bold_metrics.width, "regularGlyphSha256": digest(&regular_glyph), "boldGlyphSha256": digest(&bold_glyph)})
    );
}

fn caption_plan(family: &str, text: &str, bold: bool) -> EngineVideoCaptionPlan {
    EngineVideoCaptionPlan {
        node_id: "native-face-test".into(),
        cue_id: "cue".into(),
        text: text.into(),
        timeline: NodeFrameRange {
            timeline_start_frame: 0,
            source_start_frame: 0,
            duration_frames: 30,
        },
        font_family: family.into(),
        font_size: 32.0,
        text_color: "#FFFFFFFF".into(),
        outline_color: "#00000000".into(),
        outline_width: 0.0,
        background_color: "#00000000".into(),
        alignment: 2,
        margin_vertical: 20.0,
        bold,
        shadow: 0.0,
        letter_spacing: 0.0,
    }
}

#[test]
fn caption_uses_400_or_800_and_never_dilates_a_static_face() {
    for (family, text, expected_bold, should_differ) in [
        ("Noto Sans TC", "字面 Weight", 800, true),
        ("Bebas Neue", "WEIGHT", 400, false),
    ] {
        let regular = rasterize_caption(
            &caption_plan(family, text, false),
            &public_font_root(),
            640,
            180,
        )
        .unwrap();
        let bold = rasterize_caption(
            &caption_plan(family, text, true),
            &public_font_root(),
            640,
            180,
        )
        .unwrap();
        assert_eq!(regular.font_family, family);
        assert_eq!(bold.font_family, family);
        assert_eq!(regular.requested_font_weight, 400.0);
        assert_eq!(bold.requested_font_weight, 800.0);
        assert_eq!(regular.resolved_font_weight, 400);
        assert_eq!(bold.resolved_font_weight, expected_bold);
        assert_eq!(bold.font_weight_substituted, expected_bold != 800);
        assert_eq!(regular.atlas_sha256 != bold.atlas_sha256, should_differ);
        assert_eq!(
            bold.font_sha256,
            digest(&fs::read(public_font_root().join(&bold.font_file)).unwrap())
        );
    }
}

fn motion_plan(family: &str, text: &str, font_weight: u16) -> EngineVideoMotionGraphicPlan {
    EngineVideoMotionGraphicPlan {
        node_id: "native-motion-face-test".into(),
        graphic_id: "graphic".into(),
        graphic_kind: "tag".into(),
        text: text.into(),
        timeline: NodeFrameRange {
            timeline_start_frame: 0,
            source_start_frame: 0,
            duration_frames: 30,
        },
        x: 0.05,
        y: 0.1,
        width: 0.9,
        font_size: 32.0,
        font_family: family.into(),
        font_weight,
        letter_spacing: 0.0,
        outline_width: 0.0,
        shadow_depth: 0.0,
        corner_radius: 0.0,
        text_color: "#FFFFFFFF".into(),
        background_color: "#00000000".into(),
        accent_color: "#00000000".into(),
        visual_style: "solid_panel".into(),
        animation: "fade".into(),
        tracking_mode: "anchor".into(),
        fade_in_frames: 0,
        fade_out_frames: 0,
        track_id: None,
        tracking_samples: vec![],
        canvas_width: 640,
        canvas_height: 180,
    }
}

#[test]
fn motion_preserves_650_850_and_static_substitution_has_no_synthetic_bold() {
    let first = rasterize_motion_graphic(
        &motion_plan("Noto Sans TC", "字面 Weight", 650),
        &public_font_root(),
        640,
        180,
    )
    .unwrap();
    let second = rasterize_motion_graphic(
        &motion_plan("Noto Sans TC", "字面 Weight", 850),
        &public_font_root(),
        640,
        180,
    )
    .unwrap();
    assert_eq!(first.resolved_font_weight, 650);
    assert_eq!(second.resolved_font_weight, 850);
    assert!(!first.font_weight_substituted && !second.font_weight_substituted);
    assert_ne!(first.font_sha256, second.font_sha256);
    assert_ne!(first.atlas_sha256, second.atlas_sha256);
    let regular = rasterize_motion_graphic(
        &motion_plan("Bebas Neue", "WEIGHT", 400),
        &public_font_root(),
        640,
        180,
    )
    .unwrap();
    let requested_bold = rasterize_motion_graphic(
        &motion_plan("Bebas Neue", "WEIGHT", 900),
        &public_font_root(),
        640,
        180,
    )
    .unwrap();
    assert_eq!(regular.atlas_sha256, requested_bold.atlas_sha256);
    assert_eq!(requested_bold.requested_font_weight, 900.0);
    assert_eq!(requested_bold.resolved_font_weight, 400);
    assert!(requested_bold.font_weight_substituted);
}

#[test]
fn native_never_falls_back_for_unknown_families_or_missing_glyphs() {
    assert!(
        rasterize_caption(
            &caption_plan("Unbundled Font", "Caption", false),
            &public_font_root(),
            320,
            180
        )
        .unwrap_err()
        .to_string()
        .contains("not bundled")
    );
    for family in ["Bebas Neue", "Fredoka"] {
        assert!(
            rasterize_caption(
                &caption_plan(family, "字", false),
                &public_font_root(),
                320,
                180
            )
            .unwrap_err()
            .to_string()
            .contains("missing 1 glyphs")
        );
        assert!(
            rasterize_motion_graphic(
                &motion_plan(family, "字", 650),
                &public_font_root(),
                640,
                180
            )
            .unwrap_err()
            .to_string()
            .contains("missing 1 glyphs")
        );
    }
}

struct OwnedPack {
    root: PathBuf,
    manifest: Value,
    face_relative: String,
}

impl OwnedPack {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "editkin-native-face-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("render")).unwrap();
        let manifest: Value = serde_json::from_slice(
            &fs::read(public_font_root().join("editkin-open-fonts.json")).unwrap(),
        )
        .unwrap();
        let face_relative = manifest["fonts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == "bebas-neue")
            .unwrap()["faces"][0]["file"]
            .as_str()
            .unwrap()
            .to_string();
        fs::copy(
            public_font_root().join(&face_relative),
            root.join(&face_relative),
        )
        .unwrap();
        let pack = Self {
            root,
            manifest,
            face_relative,
        };
        pack.write_manifest();
        pack
    }
    fn write_manifest(&self) {
        fs::write(
            self.root.join("editkin-open-fonts.json"),
            serde_json::to_vec(&self.manifest).unwrap(),
        )
        .unwrap();
    }
    fn face_mut(&mut self) -> &mut Value {
        &mut self.manifest["fonts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|entry| entry["id"] == "bebas-neue")
            .unwrap()["faces"][0]
    }
    fn load_error(&self) -> String {
        load_bundled_font(&self.root, "Bebas Neue", 400.0)
            .unwrap_err()
            .to_string()
    }
}

impl Drop for OwnedPack {
    fn drop(&mut self) {
        // root is the exclusively created, opaque test directory; no public pack or user profile is touched.
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn real_loader_rejects_missing_corrupted_wrong_weight_and_wrong_name_bytes() {
    let mut pack = OwnedPack::new();
    load_bundled_font(&pack.root, "Bebas Neue", 400.0).unwrap();
    let path = pack.root.join(&pack.face_relative);
    let original = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    assert!(pack.load_error().contains("inspect font path"));
    let mut bad = original.clone();
    bad[0] ^= 1;
    fs::write(&path, &bad).unwrap();
    assert!(pack.load_error().contains("identity mismatch"));
    fs::write(&path, &original[..original.len() - 1]).unwrap();
    assert!(pack.load_error().contains("identity mismatch"));
    fs::write(&path, &original).unwrap();
    // Rebinding hash alone cannot legitimise wrong OS/2 weight or a false internal name.
    for (tag, offset_in_table) in [(b"OS/2", 4_usize), (b"name", usize::MAX)] {
        let mut bad = original.clone();
        let table_start = (0..usize::from(read_u16(&bad, 4).unwrap()))
            .find_map(|index| {
                let offset = 12 + index * 16;
                (&bad[offset..offset + 4] == tag)
                    .then(|| read_u32(&bad, offset + 8).unwrap() as usize)
            })
            .unwrap();
        if offset_in_table != usize::MAX {
            bad[table_start + offset_in_table..table_start + offset_in_table + 2]
                .copy_from_slice(&800_u16.to_be_bytes());
        } else {
            let count = read_u16(&bad, table_start + 2).unwrap() as usize;
            let strings = read_u16(&bad, table_start + 4).unwrap() as usize;
            let offset = (0..count)
                .map(|index| table_start + 6 + index * 12)
                .find(|offset| read_u16(&bad, offset + 6).unwrap() == 1)
                .unwrap();
            let start = table_start + strings + read_u16(&bad, offset + 10).unwrap() as usize;
            bad[start] ^= 1;
        }
        fs::write(&path, &bad).unwrap();
        pack.face_mut()["sha256"] = json!(digest(&bad));
        pack.write_manifest();
        let error = pack.load_error();
        assert!(
            error.contains(if offset_in_table != usize::MAX {
                "weight mismatch"
            } else {
                "name mismatch"
            }),
            "{error}"
        );
    }
}

#[test]
fn variable_source_cannot_masquerade_as_a_static_face() {
    let manifest = public_manifest();
    let entry = manifest
        .fonts
        .iter()
        .find(|entry| entry.family == "Fredoka")
        .unwrap();
    let bytes = fs::read(public_font_root().join(&entry.file)).unwrap();
    let error = validate_static_face_bytes(&bytes, &entry.faces[0])
        .unwrap_err()
        .to_string();
    assert!(error.contains("variable axes"), "{error}");
}

#[test]
fn rejects_a_real_linked_font_directory_without_reading_target_bytes() {
    let pack = OwnedPack::new();
    let target = pack.root.join("owned-render-target");
    fs::rename(pack.root.join("render"), &target).unwrap();
    let link = pack.root.join("render");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "cannot calibrate junction rejection: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let error = pack.load_error();
    // Explicitly remove only the owned junction before the owned parent cleanup.
    #[cfg(windows)]
    fs::remove_dir(&link).unwrap();
    #[cfg(unix)]
    fs::remove_file(&link).unwrap();
    assert!(error.contains("symlinks/reparse"), "{error}");
    assert!(
        target
            .join(Path::new(&pack.face_relative).file_name().unwrap())
            .is_file()
    );
}
