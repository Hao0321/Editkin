use hao_core::engine::optical_alpha::{
    OpticalAlphaSettings, refine_adaptive_optical_alpha, refine_optical_alpha,
    refine_texture_aware_optical_alpha,
};
use hao_core::engine::roto::MatteFrame;
use sha2::{Digest, Sha256};

#[test]
fn frozen_optical_alpha_algorithms_keep_all_bytes_and_receipts() {
    let mut outputs = Vec::new();
    for seed in 0..6_u32 {
        let width = 32_u32;
        let height = 24_u32;
        let n = (width * height) as usize;
        let alpha: Vec<u8> = (0..n)
            .map(|i| ((i as u32 * 47 + seed * 19) % 256) as u8)
            .collect();
        let rgb: Vec<u8> = (0..n * 3)
            .map(|i| ((i as u32 * 67 + seed * 43 + (i as u32 / 17) * 23) % 256) as u8)
            .collect();
        let coarse = MatteFrame {
            frame: seed as u64,
            width,
            height,
            alpha,
            confidence: 0.73,
        };
        let prior = MatteFrame {
            frame: seed as u64,
            width,
            height,
            alpha: (0..n)
                .map(|i| ((i as u32 * 53 + seed * 11) % 256) as u8)
                .collect(),
            confidence: 0.62,
        };
        let settings = OpticalAlphaSettings {
            radius: 3 + seed,
            ..Default::default()
        };
        for result in [
            refine_optical_alpha(&rgb, &coarse, Some(&prior), settings).unwrap(),
            refine_adaptive_optical_alpha(&rgb, &coarse, Some(&prior), settings).unwrap(),
            refine_texture_aware_optical_alpha(&rgb, &coarse, Some(&prior), settings).unwrap(),
        ] {
            outputs.push(serde_json::json!({"alphaSha256": format!("{:x}",Sha256::digest(&result.matte.alpha)),
                "receiptSha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&result.receipt).unwrap()))}));
        }
    }
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/roto_edge_legacy_optical_v2.json")).unwrap();
    assert_eq!(
        serde_json::json!(outputs),
        expected,
        "legacy optical bytes or receipts changed"
    );
}
