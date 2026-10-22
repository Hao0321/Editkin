use serde_json::Value;
use std::path::{Path, PathBuf};

/// Container suffixes do not identify the streams they actually contain.
/// Still/EXR suffixes retain their existing image, color and alpha defaults.
pub(crate) fn imported_media_defaults(
    path: &Path,
    probe: &Value,
) -> Result<(&'static str, &'static str, &'static str), String> {
    let has_video = probe
        .get("hasVideo")
        .and_then(Value::as_bool)
        .ok_or("素材探測缺少有效的影像串流資訊")?;
    let has_audio = probe
        .get("hasAudio")
        .and_then(Value::as_bool)
        .ok_or("素材探測缺少有效的音訊串流資訊")?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["png", "jpg", "jpeg", "webp", "exr", "json"].contains(&extension.as_str()) {
        if !has_video {
            return Err("圖片素材沒有可讀取的影像串流".into());
        }
        return Ok(if extension == "exr" || extension == "json" {
            ("image", "linear_rec709", "straight")
        } else {
            ("image", "auto", "auto")
        });
    }
    if has_video {
        Ok(("video", "auto", "auto"))
    } else if has_audio {
        Ok(("audio", "auto", "auto"))
    } else {
        Err("素材沒有可讀取的影像或音訊串流".into())
    }
}

/// Validate the whole response before the native caller grants any file paths.
pub(crate) fn imported_media_defaults_batch(
    paths: &[PathBuf],
    probes: &[Value],
) -> Result<Vec<(&'static str, &'static str, &'static str)>, String> {
    if paths.len() != probes.len() {
        return Err("inspect_media_batch 長度不符".into());
    }
    paths
        .iter()
        .zip(probes)
        .map(|(path, probe)| imported_media_defaults(path, probe))
        .collect()
}

/// Missing dimensions (normal for audio) must be omitted, not serialized as null.
/// Preserve present values so malformed probe data is still rejected by the project schema.
pub(crate) fn append_media_dimensions(asset: &mut Value, probe: &Value) {
    for field in ["width", "height", "displayAspectRatio"] {
        if let Some(value) = probe.get(field).filter(|value| !value.is_null()) {
            asset[field] = value.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{append_media_dimensions, imported_media_defaults, imported_media_defaults_batch};
    use serde_json::json;
    use std::path::{Path, PathBuf};

    #[test]
    fn audio_in_video_containers_is_audio() {
        for extension in ["mp4", "MOV", "mkv", "webm", "m4v"] {
            assert_eq!(
                imported_media_defaults(
                    Path::new(&format!("sound.{extension}")),
                    &json!({"hasVideo": false, "hasAudio": true})
                )
                .unwrap(),
                ("audio", "auto", "auto")
            );
        }
    }

    #[test]
    fn real_video_is_not_hidden_by_an_audio_suffix() {
        for extension in ["wav", "mp3", "m4a", "aac", "flac", "mp4"] {
            assert_eq!(
                imported_media_defaults(
                    Path::new(&format!("picture.{extension}")),
                    &json!({"hasVideo": true, "hasAudio": false})
                )
                .unwrap(),
                ("video", "auto", "auto")
            );
        }
    }

    #[test]
    fn still_and_sequence_defaults_are_preserved() {
        let probe = json!({"hasVideo": true, "hasAudio": false});
        for extension in ["png", "JPG", "jpeg", "webp"] {
            assert_eq!(
                imported_media_defaults(Path::new(&format!("still.{extension}")), &probe).unwrap(),
                ("image", "auto", "auto")
            );
        }
        for extension in ["exr", "json"] {
            assert_eq!(
                imported_media_defaults(Path::new(&format!("sequence.{extension}")), &probe)
                    .unwrap(),
                ("image", "linear_rec709", "straight")
            );
        }
    }

    #[test]
    fn video_with_audio_remains_video() {
        assert_eq!(
            imported_media_defaults(
                Path::new("clip.mp4"),
                &json!({"hasVideo": true, "hasAudio": true})
            )
            .unwrap(),
            ("video", "auto", "auto")
        );
    }

    #[test]
    fn missing_malformed_or_empty_stream_flags_are_rejected() {
        for probe in [
            json!({}),
            json!({"hasVideo": "false", "hasAudio": true}),
            json!({"hasVideo": false, "hasAudio": null}),
            json!({"hasVideo": false, "hasAudio": false}),
        ] {
            assert!(imported_media_defaults(Path::new("clip.mp4"), &probe).is_err());
        }
    }

    #[test]
    fn audio_bytes_with_image_suffix_are_not_invented_into_a_still() {
        assert!(imported_media_defaults(
            Path::new("fake.png"),
            &json!({"hasVideo": false, "hasAudio": true})
        )
        .is_err());
    }

    #[test]
    fn shorter_and_longer_batch_responses_are_rejected() {
        let paths = [PathBuf::from("one.mp4")];
        let probe = json!({"hasVideo": true, "hasAudio": false});
        assert!(imported_media_defaults_batch(&paths, &[]).is_err());
        assert!(imported_media_defaults_batch(&paths, &[probe.clone(), probe]).is_err());
    }

    #[test]
    fn invalid_later_probe_returns_no_partial_classification_batch() {
        let paths = [PathBuf::from("one.mp4"), PathBuf::from("two.mp4")];
        assert!(imported_media_defaults_batch(
            &paths,
            &[
                json!({"hasVideo": true, "hasAudio": false}),
                json!({"hasVideo": false, "hasAudio": false})
            ]
        )
        .is_err());
    }

    #[test]
    fn complete_batch_preserves_order_and_empty_import_is_valid() {
        let paths = [PathBuf::from("sound.mp4"), PathBuf::from("picture.wav")];
        let probes = [
            json!({"hasVideo": false, "hasAudio": true}),
            json!({"hasVideo": true, "hasAudio": false}),
        ];
        assert_eq!(
            imported_media_defaults_batch(&paths, &probes).unwrap(),
            vec![("audio", "auto", "auto"), ("video", "auto", "auto")]
        );
        assert!(imported_media_defaults_batch(&[], &[]).unwrap().is_empty());
    }

    #[test]
    fn audio_without_dimensions_does_not_emit_null_fields() {
        for probe in [json!({}), json!({ "width": null, "height": null })] {
            let mut asset = json!({ "kind": "audio" });
            append_media_dimensions(&mut asset, &probe);
            assert_eq!(asset, json!({ "kind": "audio" }));
        }
    }

    #[test]
    fn video_dimensions_survive_the_wire_boundary() {
        let mut asset = json!({ "kind": "video" });
        append_media_dimensions(&mut asset, &json!({ "width": 1920, "height": 1080 }));
        assert_eq!(
            asset,
            json!({ "kind": "video", "width": 1920, "height": 1080 })
        );
    }

    #[test]
    fn present_invalid_values_are_not_silently_sanitized() {
        let mut asset = json!({ "kind": "video" });
        append_media_dimensions(&mut asset, &json!({ "width": "invalid", "height": null }));
        assert_eq!(asset, json!({ "kind": "video", "width": "invalid" }));
    }

    #[test]
    fn physical_display_ratio_survives_native_import_without_changing_raster_dimensions() {
        let mut asset = json!({ "kind": "video", "duration": 9 });
        append_media_dimensions(
            &mut asset,
            &json!({ "width": 640, "height": 360, "displayAspectRatio": 64.0 / 27.0 }),
        );
        assert_eq!(
            asset,
            json!({ "kind": "video", "duration": 9, "width": 640, "height": 360, "displayAspectRatio": 64.0 / 27.0 })
        );
    }

    #[test]
    fn unknown_ratio_is_omitted_but_present_invalid_ratio_remains_rejectable() {
        let mut asset = json!({ "kind": "video" });
        append_media_dimensions(&mut asset, &json!({ "displayAspectRatio": null }));
        assert_eq!(asset, json!({ "kind": "video" }));
        append_media_dimensions(&mut asset, &json!({ "displayAspectRatio": -1 }));
        assert_eq!(asset, json!({ "kind": "video", "displayAspectRatio": -1 }));
    }
}
