//! EG3 W3-2 local foreground/background support; no model and no global key colour.

use super::roto::MatteFrame;

pub(crate) struct LocalColorSupport {
    width: usize,
    height: usize,
    planes: Vec<Vec<f64>>,
}

#[derive(Clone, Copy)]
pub(crate) struct LocalColors {
    pub foreground: [f32; 3],
    pub background: [f32; 3],
}

pub(crate) struct DirectionalColorSolve {
    pub colors: LocalColors,
    pub alpha: f32,
    residual: f32,
}

fn directional_support(
    coarse: &MatteFrame,
    band: &[bool],
    x: usize,
    y: usize,
    dx: isize,
    dy: isize,
    radius: usize,
) -> Option<(usize, bool)> {
    for step in 1..=radius {
        let sx = x as isize + dx * step as isize;
        let sy = y as isize + dy * step as isize;
        if sx < 0 || sy < 0 || sx >= coarse.width as isize || sy >= coarse.height as isize {
            break;
        }
        let i = sy as usize * coarse.width as usize + sx as usize;
        if !band[i] && (coarse.alpha[i] <= 20 || coarse.alpha[i] >= 235) {
            return Some((i, coarse.alpha[i] >= 235));
        }
    }
    None
}

/// Across-edge pairs avoid averaging unrelated background colours across a junction.
/// Only a separated, supported pair reconstructing observed RGB within one code is admitted;
/// otherwise the existing v3 solve remains the fallback. No optical flow or learned estimate.
pub(crate) fn solve_directional_color_line(
    rgb: &[u8],
    coarse: &MatteFrame,
    band: &[bool],
    x: usize,
    y: usize,
    radius: usize,
) -> Option<DirectionalColorSolve> {
    let observed: [f32; 3] =
        std::array::from_fn(|c| rgb[(y * coarse.width as usize + x) * 3 + c] as f32 / 255.0);
    let mut best: Option<DirectionalColorSolve> = None;
    for (dx, dy) in [(1, 0), (0, 1), (1, 1), (1, -1)] {
        let Some((a, a_fg)) = directional_support(coarse, band, x, y, dx, dy, radius) else {
            continue;
        };
        let Some((b, b_fg)) = directional_support(coarse, band, x, y, -dx, -dy, radius) else {
            continue;
        };
        if a_fg == b_fg {
            continue;
        }
        let (f, b) = if a_fg { (a, b) } else { (b, a) };
        let foreground: [f32; 3] = std::array::from_fn(|c| rgb[f * 3 + c] as f32 / 255.0);
        let background: [f32; 3] = std::array::from_fn(|c| rgb[b * 3 + c] as f32 / 255.0);
        let direction: [f32; 3] = std::array::from_fn(|c| foreground[c] - background[c]);
        let denominator: f32 = direction.iter().map(|d| d * d).sum();
        if denominator < (96.0 / 255.0_f32).powi(2) {
            continue;
        }
        let alpha: f32 = (0..3)
            .map(|c| (observed[c] - background[c]) * direction[c])
            .sum::<f32>()
            / denominator;
        if !(-0.02..=1.02).contains(&alpha) {
            continue;
        }
        let alpha = alpha.clamp(0.0, 1.0);
        let residual = ((0..3)
            .map(|c| (observed[c] - background[c] - alpha * direction[c]).powi(2))
            .sum::<f32>()
            / 3.0)
            .sqrt();
        if residual > 1.0 / 255.0 {
            continue;
        }
        if best.as_ref().is_none_or(|old| residual < old.residual) {
            best = Some(DirectionalColorSolve {
                colors: LocalColors {
                    foreground,
                    background,
                },
                alpha,
                residual,
            });
        }
    }
    best
}

impl LocalColorSupport {
    pub fn new(rgb: &[u8], coarse: &MatteFrame, band: &[bool]) -> Self {
        let width = coarse.width as usize;
        let height = coarse.height as usize;
        let stride = width + 1;
        let mut planes = Vec::with_capacity(8);
        for plane in 0..8 {
            let mut values = vec![0.0; stride * (height + 1)];
            for y in 0..height {
                let mut row = 0.0;
                for x in 0..width {
                    let i = y * width + x;
                    let known = !band[i]
                        && if plane < 4 {
                            coarse.alpha[i] >= 235
                        } else {
                            coarse.alpha[i] <= 20
                        };
                    let sample = if !known {
                        0.0
                    } else if plane % 4 == 0 {
                        1.0
                    } else {
                        rgb[i * 3 + plane % 4 - 1] as f64 / 255.0
                    };
                    row += sample;
                    values[(y + 1) * stride + x + 1] = values[y * stride + x + 1] + row;
                }
            }
            planes.push(values);
        }
        Self {
            width,
            height,
            planes,
        }
    }

    pub fn at(&self, x: usize, y: usize, radius: usize) -> Option<LocalColors> {
        let l = x.saturating_sub(radius);
        let t = y.saturating_sub(radius);
        let r = (x + radius + 1).min(self.width);
        let b = (y + radius + 1).min(self.height);
        let stride = self.width + 1;
        let sum = |plane: usize| {
            let p = &self.planes[plane];
            p[b * stride + r] - p[t * stride + r] - p[b * stride + l] + p[t * stride + l]
        };
        let foreground_count = sum(0);
        let background_count = sum(4);
        if foreground_count < 1.0 || background_count < 1.0 {
            return None;
        }
        let foreground = std::array::from_fn(|c| (sum(c + 1) / foreground_count) as f32);
        let background = std::array::from_fn(|c| (sum(c + 5) / background_count) as f32);
        let separation: f32 = (0..3)
            .map(|c| (foreground[c] - background[c]).powi(2))
            .sum();
        if separation < 16.0 / (255.0 * 255.0) {
            return None;
        }
        Some(LocalColors {
            foreground,
            background,
        })
    }
}

/// Recover straight RGB using the per-pixel local B. Alpha near zero has no stable colour.
/// Unsupported pixels retain observed RGB; caller records that this was a fallback.
pub(crate) fn recover_local_foreground(
    rgb: &[u8],
    coarse: &MatteFrame,
    band: &[bool],
    alpha: &[f32],
    radius: usize,
) -> (Vec<u8>, usize, usize) {
    let mut support: Option<LocalColorSupport> = None;
    let mut output = rgb.to_vec();
    let mut recovered = 0;
    let mut unsupported = 0;
    for (i, &a) in alpha.iter().enumerate() {
        if a < 0.02 {
            output[i * 3..i * 3 + 3].fill(0);
            continue;
        }
        if !band[i] || a >= 1.0 {
            continue;
        }
        let x = i % coarse.width as usize;
        let y = i / coarse.width as usize;
        let local = solve_directional_color_line(rgb, coarse, band, x, y, radius)
            .map(|s| s.colors)
            .or_else(|| {
                support
                    .get_or_insert_with(|| LocalColorSupport::new(rgb, coarse, band))
                    .at(x, y, radius)
            });
        let Some(local) = local else {
            unsupported += 1;
            continue;
        };
        for c in 0..3 {
            let observed = rgb[i * 3 + c] as f32 / 255.0;
            let solved = (observed - (1.0 - a) * local.background[c]) / a;
            // At tiny coverage, regularize towards known F instead of amplifying codec noise.
            let weight = ((a - 0.02) / 0.08).clamp(0.0, 1.0);
            let value = solved * weight + local.foreground[c] * (1.0 - weight);
            output[i * 3 + c] = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
        recovered += 1;
    }
    (output, recovered, unsupported)
}
