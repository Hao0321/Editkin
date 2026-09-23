use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatteFrame {
    pub frame: u64,
    pub width: u32,
    pub height: u32,
    pub alpha: Vec<u8>,
    pub confidence: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct MatteRefine {
    pub radius: u32,
    pub contrast: f32,
    pub edge_shift: i32,
    pub temporal_stability: f32,
}

impl MatteFrame {
    pub fn validate(&self) -> Result<(), String> {
        let expected = self.width as usize * self.height as usize;
        if self.width == 0
            || self.height == 0
            || self.width > 16_384
            || self.height > 16_384
            || self.alpha.len() != expected
            || !self.confidence.is_finite()
            || !(0.0..=1.0).contains(&self.confidence)
        {
            return Err("invalid pixel matte frame".into());
        }
        Ok(())
    }
}

fn box_blur(alpha: &[u8], width: usize, height: usize, radius: usize) -> Vec<u8> {
    if radius == 0 {
        return alpha.to_vec();
    }
    let mut output = vec![0_u8; alpha.len()];
    for y in 0..height {
        for x in 0..width {
            let left = x.saturating_sub(radius);
            let right = (x + radius).min(width - 1);
            let top = y.saturating_sub(radius);
            let bottom = (y + radius).min(height - 1);
            let mut sum = 0_u64;
            let mut count = 0_u64;
            for sample_y in top..=bottom {
                for sample_x in left..=right {
                    sum += alpha[sample_y * width + sample_x] as u64;
                    count += 1;
                }
            }
            output[y * width + x] = (sum / count) as u8;
        }
    }
    output
}

fn shift_edge(alpha: &[u8], width: usize, height: usize, amount: i32) -> Vec<u8> {
    if amount == 0 {
        return alpha.to_vec();
    }
    let radius = amount.unsigned_abs() as usize;
    let mut output = vec![0_u8; alpha.len()];
    for y in 0..height {
        for x in 0..width {
            let left = x.saturating_sub(radius);
            let right = (x + radius).min(width - 1);
            let top = y.saturating_sub(radius);
            let bottom = (y + radius).min(height - 1);
            let mut value = if amount > 0 { 0_u8 } else { 255_u8 };
            for sample_y in top..=bottom {
                for sample_x in left..=right {
                    let sample = alpha[sample_y * width + sample_x];
                    value = if amount > 0 {
                        value.max(sample)
                    } else {
                        value.min(sample)
                    };
                }
            }
            output[y * width + x] = value;
        }
    }
    output
}

pub fn refine_matte(
    current: &MatteFrame,
    previous: Option<&MatteFrame>,
    settings: MatteRefine,
) -> Result<MatteFrame, String> {
    current.validate()?;
    if settings.radius > 64
        || !settings.contrast.is_finite()
        || !(0.0..=4.0).contains(&settings.contrast)
        || settings.edge_shift.unsigned_abs() > 64
        || !settings.temporal_stability.is_finite()
        || !(0.0..=1.0).contains(&settings.temporal_stability)
    {
        return Err("invalid matte refine settings".into());
    }
    if let Some(previous) = previous {
        previous.validate()?;
        if previous.width != current.width || previous.height != current.height {
            return Err("temporal matte dimensions differ".into());
        }
    }
    let width = current.width as usize;
    let height = current.height as usize;
    let shifted = shift_edge(&current.alpha, width, height, settings.edge_shift);
    let blurred = box_blur(&shifted, width, height, settings.radius as usize);
    let mut alpha = Vec::with_capacity(blurred.len());
    for (index, sample) in blurred.iter().enumerate() {
        let normalized = *sample as f32 / 255.0;
        let contrasted = ((normalized - 0.5) * settings.contrast + 0.5).clamp(0.0, 1.0);
        let stabilized = previous.map_or(contrasted, |prior| {
            let old = prior.alpha[index] as f32 / 255.0;
            contrasted * (1.0 - settings.temporal_stability) + old * settings.temporal_stability
        });
        alpha.push((stabilized * 255.0).round() as u8);
    }
    Ok(MatteFrame {
        frame: current.frame,
        width: current.width,
        height: current.height,
        alpha,
        confidence: current.confidence,
    })
}

pub fn warp_translation(
    source: &MatteFrame,
    target_frame: u64,
    dx: i32,
    dy: i32,
    confidence: f32,
) -> Result<MatteFrame, String> {
    source.validate()?;
    if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
        return Err("invalid propagation confidence".into());
    }
    let width = source.width as i32;
    let height = source.height as i32;
    let mut alpha = vec![0_u8; source.alpha.len()];
    for y in 0..height {
        for x in 0..width {
            let target_x = x + dx;
            let target_y = y + dy;
            if (0..width).contains(&target_x) && (0..height).contains(&target_y) {
                alpha[target_y as usize * width as usize + target_x as usize] =
                    source.alpha[y as usize * width as usize + x as usize];
            }
        }
    }
    Ok(MatteFrame {
        frame: target_frame,
        width: source.width,
        height: source.height,
        alpha,
        confidence,
    })
}

pub fn boundary_chatter(left: &MatteFrame, right: &MatteFrame) -> Result<f64, String> {
    left.validate()?;
    right.validate()?;
    if left.width != right.width || left.height != right.height {
        return Err("matte dimensions differ".into());
    }
    let changed = left
        .alpha
        .iter()
        .zip(&right.alpha)
        .filter(|(a, b)| (**a >= 128) != (**b >= 128))
        .count();
    Ok(changed as f64 / left.alpha.len() as f64)
}
