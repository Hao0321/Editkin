use serde_json::Value;

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
    use super::append_media_dimensions;
    use serde_json::json;

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
        append_media_dimensions(&mut asset, &json!({ "width": 640, "height": 360, "displayAspectRatio": 64.0 / 27.0 }));
        assert_eq!(asset, json!({ "kind": "video", "duration": 9, "width": 640, "height": 360, "displayAspectRatio": 64.0 / 27.0 }));
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
