//! EG3 W3-2: bounded, opt-in, no-model edge refinement. Real-footage quality is diagnostic.
//! Work in the decoded RGB sampling space supplied by the caller; no HDR/linear-light claim.

use super::optical_alpha::{OpticalAlphaSettings, refine_texture_aware_optical_alpha_f32};
use super::roto::MatteFrame;
use super::roto_edge_color_v2::{recover_local_foreground, solve_directional_color_line};
use serde::{Deserialize, Serialize};

pub const ROTO_EDGE_V2_ENGINE: &str = "editkin-roto-edge/v2";
pub const ROTO_EDGE_V2_MAX_PIXELS: usize = 2_073_600;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotoEdgeSettingsV2 {
    pub band_radius: u32,
    pub local_radius: u32,
    pub motion_threshold: f32,
    pub temporal_stability: f32,
    pub temporal_gate: f32,
    pub despill: bool,
    pub motion_blur_edges: bool,
    pub alpha16: bool,
}

impl Default for RotoEdgeSettingsV2 {
    fn default() -> Self {
        Self {
            band_radius: 2,
            local_radius: 8,
            motion_threshold: 0.08,
            temporal_stability: 0.15,
            temporal_gate: 0.18,
            despill: true,
            motion_blur_edges: true,
            alpha16: true,
        }
    }
}

impl RotoEdgeSettingsV2 {
    pub fn validate(&self) -> Result<(), String> {
        if self.band_radius > 16
            || self.local_radius < self.band_radius + 2
            || self.local_radius > 64
            || !self.motion_threshold.is_finite()
            || !(0.01..=1.0).contains(&self.motion_threshold)
            || !self.temporal_stability.is_finite()
            || !(0.0..=0.9).contains(&self.temporal_stability)
            || !self.temporal_gate.is_finite()
            || !(0.0..=1.0).contains(&self.temporal_gate)
        {
            return Err("invalid roto edge v2 settings".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotoEdgeReceiptV2 {
    pub schema: &'static str,
    pub engine: &'static str,
    pub optical_engine: &'static str,
    pub quality_state: &'static str,
    pub alpha_precision: &'static str,
    pub rgb_precision: &'static str,
    pub edge_band_pixels: usize,
    pub motion_band_pixels: usize,
    pub solved_pixels: usize,
    pub directional_color_solved_pixels: usize,
    pub unsupported_pixels: usize,
    pub temporally_blended_pixels: usize,
    pub decontaminated_pixels: usize,
    pub unsupported_color_pixels: usize,
    pub settings: RotoEdgeSettingsV2,
}

#[derive(Clone, Debug)]
pub struct RotoEdgeResultV2 {
    pub matte: MatteFrame,
    pub alpha_f32: Vec<f32>,
    pub alpha16: Option<Vec<u16>>,
    pub straight_rgb: Vec<u8>,
    pub receipt: RotoEdgeReceiptV2,
}

pub struct RotoEdgePreviousV2<'a> {
    pub coarse: &'a MatteFrame,
    pub refined_alpha: &'a [f32],
}

fn validate_layout(coarse: &MatteFrame, rgb: &[u8]) -> Result<(), String> {
    // Bound before MatteFrame::validate and before any per-pixel/integral allocation.
    let pixels = (coarse.width as usize)
        .checked_mul(coarse.height as usize)
        .ok_or("edge dimensions overflow")?;
    if pixels == 0 || pixels > ROTO_EDGE_V2_MAX_PIXELS || rgb.len() != pixels * 3 {
        return Err("roto edge v2 exceeds bounded 1080p layout or RGB differs".into());
    }
    coarse.validate()
}

fn dilate(mask: &[bool], width: usize, height: usize, radius: usize) -> Vec<bool> {
    let stride = width + 1;
    let mut summed = vec![0_u32; stride * (height + 1)];
    for y in 0..height {
        let mut row = 0;
        for x in 0..width {
            row += u32::from(mask[y * width + x]);
            summed[(y + 1) * stride + x + 1] = summed[y * stride + x + 1] + row;
        }
    }
    let mut output = vec![false; mask.len()];
    for y in 0..height {
        for x in 0..width {
            let l = x.saturating_sub(radius);
            let t = y.saturating_sub(radius);
            let r = (x + radius + 1).min(width);
            let b = (y + radius + 1).min(height);
            output[y * width + x] = summed[b * stride + r] + summed[t * stride + l]
                > summed[t * stride + r] + summed[b * stride + l];
        }
    }
    output
}

/// Optionally extend the edge band by dilate(|M_t - M_prev| > threshold).
/// Detect motion even if extension is off: temporal deghosting must remain active.
/// Motion is a same-position coverage difference, not optical flow.
pub fn roto_edge_bands_v2(
    coarse: &MatteFrame,
    previous: Option<&MatteFrame>,
    settings: RotoEdgeSettingsV2,
) -> Result<(Vec<bool>, Vec<bool>), String> {
    settings.validate()?;
    let pixels = (coarse.width as usize)
        .checked_mul(coarse.height as usize)
        .ok_or("edge dimensions overflow")?;
    if pixels == 0 || pixels > ROTO_EDGE_V2_MAX_PIXELS {
        return Err("edge band pixel cap".into());
    }
    coarse.validate()?;
    if let Some(prior) = previous {
        prior.validate()?;
        if prior.width != coarse.width
            || prior.height != coarse.height
            || prior.frame.abs_diff(coarse.frame) != 1
        {
            return Err("edge prior must be an adjacent aligned frame".into());
        }
    }
    let width = coarse.width as usize;
    let height = coarse.height as usize;
    let mut edges = vec![false; pixels];
    let mut motion = vec![false; pixels];
    for y in 0..height {
        for x in 0..width {
            let i = y * width + x;
            let a = coarse.alpha[i];
            edges[i] = (21..235).contains(&a)
                || (x > 0 && a.abs_diff(coarse.alpha[i - 1]) > 20)
                || (x + 1 < width && a.abs_diff(coarse.alpha[i + 1]) > 20)
                || (y > 0 && a.abs_diff(coarse.alpha[i - width]) > 20)
                || (y + 1 < height && a.abs_diff(coarse.alpha[i + width]) > 20);
            motion[i] = previous.is_some_and(|p| {
                (a as f32 - p.alpha[i] as f32).abs() / 255.0 > settings.motion_threshold
            });
        }
    }
    let motion = dilate(&motion, width, height, settings.band_radius as usize);
    let mut band = dilate(&edges, width, height, settings.band_radius as usize);
    for i in 0..pixels {
        band[i] |= settings.motion_blur_edges && motion[i];
    }
    Ok((band, motion))
}

/// Input coarse coverage is separate from previous refined alpha. Pixel motion disables
/// same-position temporal blending to avoid introducing a stationary trail.
pub fn refine_roto_edge_v2(
    rgb: &[u8],
    coarse: &MatteFrame,
    previous: Option<RotoEdgePreviousV2<'_>>,
    settings: RotoEdgeSettingsV2,
) -> Result<RotoEdgeResultV2, String> {
    settings.validate()?;
    validate_layout(coarse, rgb)?;
    if let Some(prior) = &previous {
        if prior.refined_alpha.len() != coarse.alpha.len()
            || prior
                .refined_alpha
                .iter()
                .any(|a| !a.is_finite() || !(0.0..=1.0).contains(a))
        {
            return Err("invalid previous float alpha".into());
        }
    }
    let (band, motion) = roto_edge_bands_v2(coarse, previous.as_ref().map(|p| p.coarse), settings)?;
    let mut trimap = coarse.clone();
    for (i, value) in trimap.alpha.iter_mut().enumerate() {
        if band[i] {
            *value = (*value).clamp(21, 234);
        }
    }
    let optical = refine_texture_aware_optical_alpha_f32(
        rgb,
        &trimap,
        OpticalAlphaSettings {
            radius: settings.local_radius,
            coarse_weight: 0.0,
            temporal_stability: 0.0,
            ..Default::default()
        },
    )?;
    let mut alpha: Vec<f32> = coarse.alpha.iter().map(|a| *a as f32 / 255.0).collect();
    let mut solved = 0;
    let mut directional_solved = 0;
    let mut unsupported = 0;
    let mut temporal = 0;
    for i in 0..alpha.len() {
        if !band[i] {
            continue;
        }
        let directional = solve_directional_color_line(
            rgb,
            coarse,
            &band,
            i % coarse.width as usize,
            i / coarse.width as usize,
            settings.local_radius as usize,
        );
        if let Some(local) = directional {
            alpha[i] = local.alpha;
            directional_solved += 1;
        } else if optical.solve_confidence[i] >= 0.05 {
            alpha[i] = optical.alpha[i];
        } else {
            unsupported += 1;
            continue;
        }
        solved += 1;
        if let Some(prior) = &previous {
            let old = prior.refined_alpha[i];
            if !motion[i]
                && settings.temporal_stability > 0.0
                && (old - alpha[i]).abs() <= settings.temporal_gate
            {
                alpha[i] = alpha[i] * (1.0 - settings.temporal_stability)
                    + old * settings.temporal_stability;
                temporal += 1;
            }
        }
    }
    let (straight_rgb, recovered, unsupported_color) = if settings.despill {
        recover_local_foreground(rgb, coarse, &band, &alpha, settings.local_radius as usize)
    } else {
        (rgb.to_vec(), 0, 0)
    };
    let matte = MatteFrame {
        alpha: alpha.iter().map(|a| (a * 255.0).round() as u8).collect(),
        ..coarse.clone()
    };
    let alpha16 = settings
        .alpha16
        .then(|| alpha.iter().map(|a| (a * 65535.0).round() as u16).collect());
    let receipt = RotoEdgeReceiptV2 {
        schema: "editkin.roto-edge-refinement/v2",
        engine: ROTO_EDGE_V2_ENGINE,
        optical_engine: optical.receipt.engine,
        quality_state: "diagnostic",
        alpha_precision: if settings.alpha16 {
            "float-solve-to-unorm16"
        } else {
            "float-solve-to-unorm8"
        },
        rgb_precision: "decoded-rgb8-local-recovery",
        edge_band_pixels: band.iter().filter(|b| **b).count(),
        motion_band_pixels: motion.iter().filter(|b| **b).count(),
        solved_pixels: solved,
        directional_color_solved_pixels: directional_solved,
        unsupported_pixels: unsupported,
        temporally_blended_pixels: temporal,
        decontaminated_pixels: recovered,
        unsupported_color_pixels: unsupported_color,
        settings,
    };
    Ok(RotoEdgeResultV2 {
        matte,
        alpha_f32: alpha,
        alpha16,
        straight_rgb,
        receipt,
    })
}
