use super::composite::{FloatFrame, LinearRgba};

fn add(left: LinearRgba, right: LinearRgba) -> LinearRgba {
    LinearRgba {
        r: left.r + right.r,
        g: left.g + right.g,
        b: left.b + right.b,
        a: left.a + right.a,
    }
}
fn scale(pixel: LinearRgba, value: f32) -> LinearRgba {
    LinearRgba {
        r: pixel.r * value,
        g: pixel.g * value,
        b: pixel.b * value,
        a: pixel.a * value,
    }
}

fn box_sample(frame: &FloatFrame, x: i32, y: i32, radius: i32) -> LinearRgba {
    let mut sum = LinearRgba::default();
    let mut count = 0_u32;
    for oy in -radius..=radius {
        for ox in -radius..=radius {
            let sx = (x + ox).clamp(0, frame.width as i32 - 1) as usize;
            let sy = (y + oy).clamp(0, frame.height as i32 - 1) as usize;
            sum = add(sum, frame.pixels[sy * frame.width as usize + sx]);
            count += 1;
        }
    }
    scale(sum, 1.0 / count as f32)
}

/// Depth-aware reference blur. The production GPU implementation may use a
/// gather/scatter bokeh kernel, but it must match this alpha-safe contract.
pub fn depth_of_field(
    frame: &FloatFrame,
    depth: &[f32],
    focus_distance: f32,
    aperture: f32,
    max_radius: u32,
) -> Result<FloatFrame, String> {
    frame.validate()?;
    if depth.len() != frame.pixels.len()
        || depth
            .iter()
            .any(|value| !value.is_finite() && !value.is_infinite())
        || !focus_distance.is_finite()
        || !(0.0..=1.0).contains(&focus_distance)
        || !aperture.is_finite()
        || aperture < 0.0
        || max_radius > 32
    {
        return Err("invalid depth-of-field input".into());
    }
    let mut output = FloatFrame::transparent(frame.width, frame.height)?;
    for y in 0..frame.height as i32 {
        for x in 0..frame.width as i32 {
            let index = y as usize * frame.width as usize + x as usize;
            let z = depth[index];
            let radius = if z.is_infinite() {
                max_radius as i32
            } else {
                ((z - focus_distance).abs() * aperture * max_radius as f32)
                    .round()
                    .clamp(0.0, max_radius as f32) as i32
            };
            output.pixels[index] = if radius == 0 {
                frame.pixels[index]
            } else {
                box_sample(frame, x, y, radius)
            };
        }
    }
    output.validate()?;
    Ok(output)
}

/// Accumulates already-rendered shutter samples. All samples are premultiplied,
/// preventing dark fringes around transparent motion.
pub fn motion_blur(samples: &[FloatFrame], weights: Option<&[f32]>) -> Result<FloatFrame, String> {
    let first = samples.first().ok_or("motion blur requires samples")?;
    first.validate()?;
    if samples.len() > 64
        || samples.iter().any(|frame| {
            frame.width != first.width || frame.height != first.height || frame.validate().is_err()
        })
    {
        return Err("motion blur samples differ".into());
    }
    let normalized = match weights {
        Some(weights) => {
            if weights.len() != samples.len() || weights.iter().any(|w| !w.is_finite() || *w < 0.0)
            {
                return Err("invalid shutter weights".into());
            }
            let sum = weights.iter().sum::<f32>();
            if sum <= 0.0 {
                return Err("empty shutter weights".into());
            }
            weights.iter().map(|w| *w / sum).collect::<Vec<_>>()
        }
        None => vec![1.0 / samples.len() as f32; samples.len()],
    };
    let mut output = FloatFrame::transparent(first.width, first.height)?;
    for (sample, weight) in samples.iter().zip(normalized) {
        for (target, pixel) in output.pixels.iter_mut().zip(&sample.pixels) {
            *target = add(*target, scale(*pixel, weight));
        }
    }
    output.validate()?;
    Ok(output)
}

pub fn frame_energy(frame: &FloatFrame) -> Result<f64, String> {
    frame.validate()?;
    Ok(frame.pixels.iter().map(|p| (p.r + p.g + p.b) as f64).sum())
}
