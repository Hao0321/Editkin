use hao_core::engine::optical_alpha::{
    OpticalAlphaSettings, recover_straight_foreground, refine_texture_aware_optical_alpha,
    refine_texture_aware_optical_alpha_f32,
};
use hao_core::engine::roto::MatteFrame;
use hao_core::engine::roto_edge_png_v2::encode_roto_edge_alpha_png_v2;
use hao_core::engine::roto_edge_v2::{
    RotoEdgePreviousV2, RotoEdgeSettingsV2, refine_roto_edge_v2, roto_edge_bands_v2,
};
use std::io::Cursor;

fn fixture(frame: u64, shift: usize) -> (Vec<u8>, MatteFrame, Vec<f32>, Vec<u8>) {
    let (width, height) = (64_usize, 40_usize);
    let foreground = [220_u8, 44, 33];
    let mut truth = Vec::new();
    let mut rgb = Vec::new();
    let mut fg = Vec::new();
    for y in 0..height {
        let background = if y < 20 {
            [20_u8, 130, 220]
        } else {
            [150_u8, 20, 120]
        };
        for x in 0..width {
            let a = ((x as f32 - (28 + shift) as f32) / 8.0).clamp(0.0, 1.0);
            truth.push(a);
            fg.extend(foreground);
            for c in 0..3 {
                rgb.push(
                    (a * foreground[c] as f32 + (1.0 - a) * background[c] as f32).round() as u8,
                );
            }
        }
    }
    let coarse = MatteFrame {
        frame,
        width: width as u32,
        height: height as u32,
        alpha: truth.iter().map(|a| (a * 255.0).round() as u8).collect(),
        confidence: 0.9,
    };
    (rgb, coarse, truth, fg)
}

fn settings() -> RotoEdgeSettingsV2 {
    RotoEdgeSettingsV2 {
        local_radius: 12,
        temporal_stability: 0.0,
        ..Default::default()
    }
}

#[test]
fn exact_edge_and_motion_dilation_union_has_no_wraparound() {
    let current = MatteFrame {
        frame: 1,
        width: 9,
        height: 3,
        alpha: (0..27).map(|i| if i % 9 >= 4 { 255 } else { 0 }).collect(),
        confidence: 1.0,
    };
    let mut previous = current.clone();
    previous.frame = 0;
    previous.alpha[9] = 255;
    let s = RotoEdgeSettingsV2 {
        band_radius: 1,
        local_radius: 4,
        ..settings()
    };
    let (band, motion) = roto_edge_bands_v2(&current, Some(&previous), s).unwrap();
    assert_eq!(band, (0..27).map(|i| i % 9 <= 5).collect::<Vec<_>>());
    assert_eq!(motion, (0..27).map(|i| i % 9 <= 1).collect::<Vec<_>>());
    let (_, still) = roto_edge_bands_v2(&current, None, s).unwrap();
    assert!(still.iter().all(|v| !v));
}

#[test]
fn float_optical_capture_keeps_the_same_v3_u8_and_receipt() {
    let (rgb, coarse, _, _) = fixture(0, 0);
    let s = OpticalAlphaSettings {
        radius: 12,
        ..Default::default()
    };
    let old = refine_texture_aware_optical_alpha(&rgb, &coarse, None, s).unwrap();
    let float = refine_texture_aware_optical_alpha_f32(&rgb, &coarse, s).unwrap();
    assert_eq!(old.matte.alpha, float.matte.alpha);
    assert_eq!(
        serde_json::to_vec(&old.receipt).unwrap(),
        serde_json::to_vec(&float.receipt).unwrap()
    );
    assert!(
        float
            .alpha
            .iter()
            .zip(&float.matte.alpha)
            .all(|(a, u)| (*a * 255.0).round() as u8 == *u)
    );
}

#[test]
fn analytic_multiple_backgrounds_recover_straight_foreground_and_sub_u8_alpha() {
    let (rgb, coarse, truth, fg) = fixture(0, 0);
    let result = refine_roto_edge_v2(&rgb, &coarse, None, settings()).unwrap();
    let legacy = recover_straight_foreground(&rgb, &coarse.alpha, [20, 130, 220], 0.02).unwrap();
    let mut max_rgb_error = 0;
    let mut legacy_max = 0;
    let mut alpha_error = 0.0_f32;
    for y in [2_usize, 37] {
        for x in 30..36 {
            let i = y * 64 + x;
            alpha_error = alpha_error.max((result.alpha_f32[i] - truth[i]).abs());
            for c in 0..3 {
                max_rgb_error =
                    max_rgb_error.max(result.straight_rgb[i * 3 + c].abs_diff(fg[i * 3 + c]));
                legacy_max = legacy_max.max(legacy[i * 3 + c].abs_diff(fg[i * 3 + c]));
            }
        }
    }
    println!(
        "EDGE_LOCAL_CONTROL max_rgb_error={max_rgb_error} global_background_error={legacy_max} alpha_error={alpha_error}"
    );
    assert!(max_rgb_error <= 3, "local foreground error {max_rgb_error}");
    assert!(
        legacy_max > 20,
        "wrong-global-background negative must fail"
    );
    assert!(alpha_error < 0.008);
    let high = result.alpha16.as_ref().unwrap();
    assert!(high.iter().any(|a| *a != 0 && *a != 65535 && *a % 257 != 0));
    assert!(
        high.iter()
            .zip(&result.alpha_f32)
            .all(|(u, a)| *u == (*a * 65535.0).round() as u16)
    );
    assert_ne!(
        high,
        &result
            .matte
            .alpha
            .iter()
            .map(|a| *a as u16 * 257)
            .collect::<Vec<_>>(),
        "replicated-u8 precision negative"
    );
    assert_eq!(result.receipt.quality_state, "diagnostic");
    assert_eq!(
        result.receipt.optical_engine,
        "editkin-self-authored-texture-aware-optical-alpha-refiner/v3"
    );
    assert!(result.receipt.decontaminated_pixels > 0);
    if let Ok(directory) = std::env::var("EDITKIN_ROTO_EDGE_EVIDENCE_DIR") {
        let root = std::path::PathBuf::from(directory);
        std::fs::create_dir(&root).expect("exclusive native diagnostic fixture output");
        for (name, bytes) in [
            ("source.rgb24", rgb),
            ("straight.rgb24", result.straight_rgb.clone()),
            ("alpha8.gray", result.matte.alpha.clone()),
            (
                "alpha16.gray16le",
                high.iter().flat_map(|a| a.to_le_bytes()).collect(),
            ),
            (
                "alpha16.png",
                encode_roto_edge_alpha_png_v2(&result).unwrap(),
            ),
            (
                "receipt.json",
                serde_json::to_vec_pretty(&result.receipt).unwrap(),
            ),
        ] {
            std::fs::write(root.join(name), bytes).unwrap();
        }
    }
}

#[test]
fn unsupported_color_and_alpha_solve_keep_original_coverage() {
    let coarse = MatteFrame {
        frame: 0,
        width: 32,
        height: 24,
        alpha: vec![128; 768],
        confidence: 0.4,
    };
    let rgb = vec![90; 768 * 3];
    let result = refine_roto_edge_v2(&rgb, &coarse, None, settings()).unwrap();
    assert_eq!(result.matte.alpha, coarse.alpha);
    assert_eq!(result.straight_rgb, rgb);
    assert_eq!(result.receipt.solved_pixels, 0);
    assert_eq!(result.receipt.unsupported_pixels, 768);
    assert_eq!(result.receipt.unsupported_color_pixels, 768);
}

#[test]
fn complete_edge_including_background_junction_keeps_local_foreground() {
    let (rgb, coarse, truth, fg) = fixture(0, 0);
    let result = refine_roto_edge_v2(&rgb, &coarse, None, settings()).unwrap();
    let mut maximum = 0_u8;
    let mut maximum_alpha = 0.0_f32;
    for y in 0..40 {
        for x in 30..36 {
            let i = y * 64 + x;
            maximum_alpha = maximum_alpha.max((result.alpha_f32[i] - truth[i]).abs());
            for c in 0..3 {
                maximum = maximum.max(result.straight_rgb[i * 3 + c].abs_diff(fg[i * 3 + c]));
            }
        }
    }
    println!("EDGE_FULL_CONTROL maximum_rgb_error={maximum} maximum_alpha_error={maximum_alpha}");
    assert!(
        maximum <= 3,
        "whole edge includes the background junction: {maximum}"
    );
    assert!(maximum_alpha < 0.008);
}

#[test]
fn constant_definite_regions_do_not_create_an_edge_or_new_alpha() {
    for a in [0_u8, 255] {
        let coarse = MatteFrame {
            frame: 0,
            width: 16,
            height: 16,
            alpha: vec![a; 256],
            confidence: 0.8,
        };
        let result = refine_roto_edge_v2(&vec![120; 768], &coarse, None, settings()).unwrap();
        assert_eq!(result.matte.alpha, coarse.alpha);
        assert_eq!(result.receipt.edge_band_pixels, 0);
        assert_eq!(result.receipt.solved_pixels, 0);
        if a == 0 {
            assert!(result.straight_rgb.iter().all(|v| *v == 0));
        } else {
            assert!(result.straight_rgb.iter().all(|v| *v == 120));
        }
    }
}

#[test]
fn moving_band_does_not_mix_previous_screen_position_alpha() {
    let (prior_rgb, prior_coarse, _, _) = fixture(0, 0);
    let prior = refine_roto_edge_v2(&prior_rgb, &prior_coarse, None, settings()).unwrap();
    let (rgb, coarse, _, _) = fixture(1, 4);
    let base = refine_roto_edge_v2(
        &rgb,
        &coarse,
        Some(RotoEdgePreviousV2 {
            coarse: &prior_coarse,
            refined_alpha: &prior.alpha_f32,
        }),
        settings(),
    )
    .unwrap();
    let s = RotoEdgeSettingsV2 {
        temporal_stability: 0.9,
        temporal_gate: 1.0,
        ..settings()
    };
    let (_, moving) = roto_edge_bands_v2(&coarse, Some(&prior_coarse), s).unwrap();
    let result = refine_roto_edge_v2(
        &rgb,
        &coarse,
        Some(RotoEdgePreviousV2 {
            coarse: &prior_coarse,
            refined_alpha: &prior.alpha_f32,
        }),
        s,
    )
    .unwrap();
    assert!(result.receipt.motion_band_pixels > 0);
    for (i, motion) in moving.iter().enumerate() {
        if *motion {
            assert_eq!(result.alpha_f32[i], base.alpha_f32[i]);
        }
    }
}

#[test]
fn disabling_motion_band_extension_still_prevents_screen_position_ghosts() {
    let (prior_rgb, prior_coarse, _, _) = fixture(0, 0);
    let prior = refine_roto_edge_v2(&prior_rgb, &prior_coarse, None, settings()).unwrap();
    let (rgb, coarse, _, _) = fixture(1, 4);
    let s = RotoEdgeSettingsV2 {
        motion_blur_edges: false,
        ..settings()
    };
    let base = refine_roto_edge_v2(
        &rgb,
        &coarse,
        Some(RotoEdgePreviousV2 {
            coarse: &prior_coarse,
            refined_alpha: &prior.alpha_f32,
        }),
        s,
    )
    .unwrap();
    let result = refine_roto_edge_v2(
        &rgb,
        &coarse,
        Some(RotoEdgePreviousV2 {
            coarse: &prior_coarse,
            refined_alpha: &prior.alpha_f32,
        }),
        RotoEdgeSettingsV2 {
            temporal_stability: 0.9,
            temporal_gate: 1.0,
            ..s
        },
    )
    .unwrap();
    let i = 2 * 64 + 34;
    assert!(
        (coarse.alpha[i] as f32 - prior_coarse.alpha[i] as f32).abs() / 255.0 > s.motion_threshold
    );
    assert_eq!(result.alpha_f32[i], base.alpha_f32[i]);
}

#[test]
fn static_frame_blends_only_supported_stable_pixels() {
    let (rgb, coarse, _, _) = fixture(1, 0);
    let mut previous = coarse.clone();
    previous.frame = 0;
    let base = refine_roto_edge_v2(&rgb, &coarse, None, settings()).unwrap();
    let old: Vec<f32> = base.alpha_f32.iter().map(|a| (a - 0.01).max(0.0)).collect();
    let s = RotoEdgeSettingsV2 {
        temporal_stability: 0.5,
        ..settings()
    };
    let result = refine_roto_edge_v2(
        &rgb,
        &coarse,
        Some(RotoEdgePreviousV2 {
            coarse: &previous,
            refined_alpha: &old,
        }),
        s,
    )
    .unwrap();
    assert_eq!(result.receipt.motion_band_pixels, 0);
    assert!(result.receipt.temporally_blended_pixels > 0);
    assert!(
        (result.alpha_f32[2 * 64 + 32] - (base.alpha_f32[2 * 64 + 32] + old[2 * 64 + 32]) * 0.5)
            .abs()
            < 1e-7
    );
}

#[test]
fn optional_precision_and_despill_do_not_change_the_alpha_solve() {
    let (rgb, coarse, _, _) = fixture(0, 0);
    let high = refine_roto_edge_v2(&rgb, &coarse, None, settings()).unwrap();
    let low = refine_roto_edge_v2(
        &rgb,
        &coarse,
        None,
        RotoEdgeSettingsV2 {
            despill: false,
            alpha16: false,
            ..settings()
        },
    )
    .unwrap();
    assert_eq!(high.alpha_f32, low.alpha_f32);
    assert_eq!(high.matte.alpha, low.matte.alpha);
    assert!(low.alpha16.is_none());
    assert_eq!(low.straight_rgb, rgb);
    assert_eq!(low.receipt.alpha_precision, "float-solve-to-unorm8");
}

#[test]
fn png8_and_png16_roundtrip_exact_samples_and_endianness() {
    let (rgb, coarse, _, _) = fixture(0, 0);
    for alpha16 in [false, true] {
        let result = refine_roto_edge_v2(
            &rgb,
            &coarse,
            None,
            RotoEdgeSettingsV2 {
                alpha16,
                ..settings()
            },
        )
        .unwrap();
        let bytes = encode_roto_edge_alpha_png_v2(&result).unwrap();
        let mut decoder = png::Decoder::new(Cursor::new(bytes));
        decoder.set_transformations(png::Transformations::IDENTITY);
        let mut reader = decoder.read_info().unwrap();
        let mut output = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut output).unwrap();
        assert_eq!((info.width, info.height), (64, 40));
        assert_eq!(info.color_type, png::ColorType::Grayscale);
        assert_eq!(
            info.bit_depth,
            if alpha16 {
                png::BitDepth::Sixteen
            } else {
                png::BitDepth::Eight
            }
        );
        if alpha16 {
            let values: Vec<u16> = output[..info.buffer_size()]
                .chunks_exact(2)
                .map(|b| u16::from_be_bytes([b[0], b[1]]))
                .collect();
            assert_eq!(values, result.alpha16.unwrap());
        } else {
            assert_eq!(output[..info.buffer_size()], result.matte.alpha);
        }
    }
}

#[test]
fn deterministic_identical_inputs_produce_identical_bytes_and_receipts() {
    let (rgb, coarse, _, _) = fixture(0, 0);
    let a = refine_roto_edge_v2(&rgb, &coarse, None, settings()).unwrap();
    let b = refine_roto_edge_v2(&rgb, &coarse, None, settings()).unwrap();
    assert_eq!(a.alpha_f32, b.alpha_f32);
    assert_eq!(a.alpha16, b.alpha16);
    assert_eq!(a.straight_rgb, b.straight_rgb);
    assert_eq!(
        serde_json::to_vec(&a.receipt).unwrap(),
        serde_json::to_vec(&b.receipt).unwrap()
    );
    assert_eq!(
        encode_roto_edge_alpha_png_v2(&a).unwrap(),
        encode_roto_edge_alpha_png_v2(&b).unwrap()
    );
}

#[test]
fn invalid_settings_layout_precision_and_previous_are_refused() {
    let (rgb, coarse, _, _) = fixture(1, 0);
    for s in [
        RotoEdgeSettingsV2 {
            band_radius: 17,
            ..settings()
        },
        RotoEdgeSettingsV2 {
            local_radius: 1,
            ..settings()
        },
        RotoEdgeSettingsV2 {
            temporal_stability: f32::NAN,
            ..settings()
        },
        RotoEdgeSettingsV2 {
            temporal_gate: -1.0,
            ..settings()
        },
        RotoEdgeSettingsV2 {
            motion_threshold: f32::INFINITY,
            ..settings()
        },
    ] {
        assert!(refine_roto_edge_v2(&rgb, &coarse, None, s).is_err());
    }
    assert!(refine_roto_edge_v2(&rgb[..10], &coarse, None, settings()).is_err());
    let huge = MatteFrame {
        width: u32::MAX,
        height: u32::MAX,
        alpha: vec![],
        ..coarse.clone()
    };
    assert!(refine_roto_edge_v2(&[], &huge, None, settings()).is_err());
    let mut old = coarse.clone();
    old.frame = 99;
    let alpha = vec![0.5; coarse.alpha.len()];
    assert!(
        refine_roto_edge_v2(
            &rgb,
            &coarse,
            Some(RotoEdgePreviousV2 {
                coarse: &old,
                refined_alpha: &alpha
            }),
            settings()
        )
        .is_err()
    );
    old.frame = 0;
    assert!(
        refine_roto_edge_v2(
            &rgb,
            &coarse,
            Some(RotoEdgePreviousV2 {
                coarse: &old,
                refined_alpha: &[0.5]
            }),
            settings()
        )
        .is_err()
    );
    let mut result = refine_roto_edge_v2(&rgb, &coarse, None, settings()).unwrap();
    result.alpha16.as_mut().unwrap().pop();
    assert!(encode_roto_edge_alpha_png_v2(&result).is_err());
    let mut json = serde_json::to_value(settings()).unwrap();
    json["model"] = serde_json::json!("sam");
    assert!(serde_json::from_value::<RotoEdgeSettingsV2>(json).is_err());
}
