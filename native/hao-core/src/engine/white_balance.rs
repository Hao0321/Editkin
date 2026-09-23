//! Physical channel gains, independent of the legacy artistic temperature/tint controls.
use super::model::PrimaryGrade;

pub const REC709_PRIMARY_V2: &str = "editkin-rec709-primary/v2";
pub const REC709_TO_LINEAR_PRIMARY_V2: &str = "editkin-rec709-to-linear-rec709-primary/v2";
pub const LINEAR_PRIMARY_V2: &str = "editkin-linear-primary/v2";

pub fn is_v2(processor: &str) -> bool {
    matches!(processor, REC709_PRIMARY_V2 | REC709_TO_LINEAR_PRIMARY_V2 | LINEAR_PRIMARY_V2)
}

pub fn stops(grade: PrimaryGrade) -> [f32; 3] {
    [grade.white_balance_red, grade.white_balance_green, grade.white_balance_blue]
}

pub fn validate_contract(processor: &str, grade: PrimaryGrade) -> Result<(), String> {
    let values = stops(grade);
    if values.iter().any(|v| !v.is_finite() || !(-4.0..=4.0).contains(v)) {
        return Err("white-balance channel stops must be finite within [-4,4]".into());
    }
    if is_v2(processor) {
        if grade.white_balance_fields_present != 7 {
            return Err("white-balance v2 requires all three explicit channel stops".into());
        }
    } else if values.iter().any(|v| *v != 0.0) {
        return Err("nonzero white balance requires a supported v2 primary processor".into());
    }
    Ok(())
}

pub fn decode_rec709(value: f32) -> f32 {
    if value < 0.081 { value / 4.5 } else { ((value + 0.099) / 1.099).powf(1.0 / 0.45) }
}

pub fn encode_rec709(value: f32) -> f32 {
    if value < 0.018 { 4.5 * value } else { 1.099 * value.powf(0.45) - 0.099 }
}

pub fn apply_linear(rgb: [f32; 3], channel_stops: [f32; 3]) -> Result<[f32; 3], String> {
    if rgb.iter().any(|v| !v.is_finite())
        || channel_stops.iter().any(|v| !v.is_finite() || !(-4.0..=4.0).contains(v)) {
        return Err("invalid physical white-balance pixel or stops".into());
    }
    Ok(std::array::from_fn(|i| rgb[i] * channel_stops[i].exp2()))
}

pub fn apply_encoded_rec709(rgb: [f32; 3], channel_stops: [f32; 3]) -> Result<[f32; 3], String> {
    // Avoid a round trip for identity: preserve legacy values including negative/over-range.
    if channel_stops == [0.0; 3] { return apply_linear(rgb, channel_stops); }
    Ok(apply_linear(rgb.map(decode_rec709), channel_stops)?.map(encode_rec709))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wire() -> serde_json::Value { serde_json::to_value(PrimaryGrade::default()).unwrap() }

    #[test]
    fn white_balance_contract_defaults_roundtrip_and_fail_closed() {
        let mut old = wire();
        for name in ["whiteBalanceRed", "whiteBalanceGreen", "whiteBalanceBlue"] { old.as_object_mut().unwrap().remove(name); }
        let legacy: PrimaryGrade = serde_json::from_value(old.clone()).unwrap();
        assert!(legacy.is_identity());
        assert!(validate_contract("editkin-rec709-primary/v1", legacy).is_ok());
        assert!(validate_contract(REC709_PRIMARY_V2, legacy).is_err());
        let mut current = wire(); current["whiteBalanceRed"] = json!(1.25);
        let grade: PrimaryGrade = serde_json::from_value(current.clone()).unwrap();
        assert_eq!(grade.white_balance_red, 1.25);
        assert_eq!(serde_json::to_value(grade).unwrap(), current);
        assert!(validate_contract(REC709_PRIMARY_V2, grade).is_ok());
        assert!(validate_contract("editkin-rec709-primary/v1", grade).is_err());
        assert!(validate_contract("unknown-v2", grade).is_err());
        for name in ["whiteBalanceRed", "whiteBalanceGreen", "whiteBalanceBlue"] {
            let mut absent = current.clone(); absent.as_object_mut().unwrap().remove(name);
            assert!(validate_contract(REC709_PRIMARY_V2, serde_json::from_value(absent).unwrap()).is_err());
            let mut null = current.clone(); null[name] = json!(null);
            assert!(validate_contract(REC709_PRIMARY_V2, serde_json::from_value(null).unwrap()).is_err());
            for invalid in [-4.001, 4.001] { let mut bad = current.clone(); bad[name] = json!(invalid); assert!(validate_contract(REC709_PRIMARY_V2, serde_json::from_value(bad).unwrap()).is_err()); }
        }
        old["whiteBalnceRed"] = json!(1.0);
        assert!(serde_json::from_value::<PrimaryGrade>(old).is_err());
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] { let mut bad = grade; bad.white_balance_green = invalid; assert!(validate_contract(REC709_PRIMARY_V2, bad).is_err()); }
    }

    #[test]
    fn white_balance_physical_math_preserves_identity_highlights_and_negative_extension() {
        for rgb in [[-0.2, 0.0, 0.18], [0.4, 1.0, 8.0]] {
            assert_eq!(apply_encoded_rec709(rgb, [0.0; 3]).unwrap(), rgb);
        }
        assert_eq!(apply_linear([0.25, 2.0, -0.125], [1.0, -1.0, 4.0]).unwrap(), [0.5, 1.0, -2.0]);
        let output = apply_encoded_rec709([0.5, 0.5, 0.5], [1.0, 0.0, -1.0]).unwrap();
        // Independently evaluated double-precision Rec.709 OETF equations, not sRGB.
        assert!((output[0] - 0.7192581137958829).abs() < 0.000001);
        assert!((output[2] - 0.33949366593571484).abs() < 0.000001);
        assert!((decode_rec709(-0.09) + 0.02).abs() < 1e-6);
        assert!((encode_rec709(-0.02) + 0.09).abs() < 1e-6);
        assert!(apply_linear([f32::NAN, 0.0, 0.0], [0.0; 3]).is_err());
    }
}
