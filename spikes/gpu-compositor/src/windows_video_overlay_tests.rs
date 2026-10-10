//! Pure admission/packing controls. No GPU, media, window or process is opened.
use super::*;
use hao_core::engine::composite::LinearRgba;

fn frame(pixel: LinearRgba) -> FloatFrame {
    FloatFrame { width: 1, height: 1, pixels: vec![pixel] }
}

#[test]
fn binary16_retains_linear_values_and_rounds_ties_even() {
    for (linear, expected) in [
        (0.0, 0x0000), (-0.0, 0x0000), (0.5, 0x3800), (1.0, 0x3c00),
        (2_f32.powi(-24), 0x0001), (2_f32.powi(-14), 0x0400),
        (2_f32.powi(-25), 0x0000), (3.0 * 2_f32.powi(-25), 0x0002),
        (0.500244140625, 0x3800), (0.500732421875, 0x3802),
        (1023.5 * 2_f32.powi(-24), 0x0400),
    ] {
        assert_eq!(linear_unit_f16(linear), expected, "linear={linear}");
    }
    // Both channels would become zero in RGBA8. Float staging retains them.
    let bytes = pack_scene_linear_overlay(&frame(LinearRgba {
        r: 2_f32.powi(-14), g: 0.0, b: 0.0, a: 2_f32.powi(-13),
    })).unwrap();
    assert_eq!(bytes, [0, 4, 0, 0, 0, 0, 0, 8]);
}

#[test]
fn packing_requires_exact_pixel_count_and_bounded_dimensions() {
    let pixel = LinearRgba::default();
    for (width, height, pixels) in [
        (0, 1, vec![]), (1, 0, vec![]), (1, 1, vec![]),
        (1, 1, vec![pixel, pixel]), (8193, 1, vec![]),
        (8192, 8192, vec![]), (u32::MAX, u32::MAX, vec![]),
    ] {
        assert!(pack_scene_linear_overlay(&FloatFrame { width, height, pixels }).is_err());
    }
    let transparent = pack_scene_linear_overlay(&frame(pixel)).unwrap();
    assert_eq!(transparent.len(), 8);
    assert!(transparent.iter().all(|byte| *byte == 0));
}

#[test]
fn packing_rejects_nonfinite_and_invalid_premultiplication() {
    for invalid in [
        LinearRgba { r: f32::NAN, g: 0.0, b: 0.0, a: 1.0 },
        LinearRgba { r: 0.0, g: f32::INFINITY, b: 0.0, a: 1.0 },
        LinearRgba { r: 0.0, g: 0.0, b: 0.0, a: f32::NAN },
        LinearRgba { r: -f32::EPSILON, g: 0.0, b: 0.0, a: 1.0 },
        LinearRgba { r: 0.50001, g: 0.0, b: 0.0, a: 0.5 },
        LinearRgba { r: 0.001, g: 0.0, b: 0.0, a: 0.0 },
        LinearRgba { r: 0.0, g: 0.0, b: 0.0, a: 1.00001 },
        LinearRgba { r: 0.0, g: 0.0, b: 0.0, a: -f32::EPSILON },
    ] {
        assert!(pack_scene_linear_overlay(&frame(invalid)).is_err());
    }
    let mut late_invalid = frame(LinearRgba { r: 0.25, g: 0.125, b: 0.0, a: 0.5 });
    late_invalid.width = 2;
    late_invalid.pixels.push(LinearRgba { r: 0.0, g: 0.0, b: f32::NEG_INFINITY, a: 1.0 });
    assert!(pack_scene_linear_overlay(&late_invalid).is_err());
}

#[test]
fn overlay_encoding_declares_alpha_and_transfer_without_changing_caption_contract() {
    let caption = ResidentOverlayEncoding::SrgbStraight.style(1920, 1080);
    assert_eq!((caption.source_alpha_mode, caption.source_color_contract), (0, 0.0));
    let paint = ResidentOverlayEncoding::SceneLinearPremultiplied(SceneLinearOverlayBasis::LinearRec709).style(1920, 1080);
    assert_eq!((paint.source_alpha_mode, paint.source_color_contract), (2, 0.0));
    assert_eq!((paint.source_width, paint.source_height), (1920.0, 1080.0));
    assert_eq!((paint.opacity, paint.composite_opacity), (1.0, 1.0));
}
