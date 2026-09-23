use super::model::{BlendMode, MatteMode};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LinearRgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl LinearRgba {
    pub fn new(r: f32, g: f32, b: f32, a: f32) -> Result<Self, String> {
        if [r, g, b, a].iter().any(|value| !value.is_finite()) {
            return Err("pixel contains non-finite values".into());
        }
        Ok(Self { r, g, b, a })
    }

    pub fn premultiplied(self) -> Self {
        Self {
            r: self.r * self.a,
            g: self.g * self.a,
            b: self.b * self.a,
            a: self.a,
        }
    }

    pub fn unpremultiplied(self) -> Self {
        if self.a.abs() <= 1.0e-8 {
            return Self::default();
        }
        Self {
            r: self.r / self.a,
            g: self.g / self.a,
            b: self.b / self.a,
            a: self.a,
        }
    }

    pub fn clamped(self) -> Self {
        Self {
            r: self.r.clamp(0.0, 1.0),
            g: self.g.clamp(0.0, 1.0),
            b: self.b.clamp(0.0, 1.0),
            a: self.a.clamp(0.0, 1.0),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FloatFrame {
    pub width: u32,
    pub height: u32,
    /// Premultiplied scene-linear pixels.
    pub pixels: Vec<LinearRgba>,
}

impl FloatFrame {
    pub fn transparent(width: u32, height: u32) -> Result<Self, String> {
        let count = width
            .checked_mul(height)
            .ok_or("frame dimensions overflow")? as usize;
        if width == 0 || height == 0 || count > 268_435_456 {
            return Err("invalid frame dimensions".into());
        }
        Ok(Self {
            width,
            height,
            pixels: vec![LinearRgba::default(); count],
        })
    }

    pub fn solid(width: u32, height: u32, color: LinearRgba) -> Result<Self, String> {
        let mut frame = Self::transparent(width, height)?;
        frame.pixels.fill(color.premultiplied());
        Ok(frame)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.pixels.len() != self.width as usize * self.height as usize
            || self.pixels.iter().any(|p| {
                [p.r, p.g, p.b, p.a].iter().any(|v| !v.is_finite())
                    || p.a < 0.0
                    || p.a > 1.0
                    || p.r < -1.0e-5
                    || p.g < -1.0e-5
                    || p.b < -1.0e-5
                    || p.r > p.a + 1.0e-4
                    || p.g > p.a + 1.0e-4
                    || p.b > p.a + 1.0e-4
            })
        {
            return Err("frame violates premultiplied alpha contract".into());
        }
        Ok(())
    }
}

fn blend_channel(backdrop: f32, source: f32, mode: BlendMode) -> f32 {
    match mode {
        BlendMode::Normal => source,
        BlendMode::Add => (backdrop + source).min(1.0),
        BlendMode::Screen => backdrop + source - backdrop * source,
        BlendMode::Multiply => backdrop * source,
        BlendMode::Overlay => {
            if backdrop <= 0.5 {
                2.0 * backdrop * source
            } else {
                1.0 - 2.0 * (1.0 - backdrop) * (1.0 - source)
            }
        }
        BlendMode::SoftLight => {
            if source <= 0.5 {
                backdrop - (1.0 - 2.0 * source) * backdrop * (1.0 - backdrop)
            } else {
                let d = if backdrop <= 0.25 {
                    ((16.0 * backdrop - 12.0) * backdrop + 4.0) * backdrop
                } else {
                    backdrop.sqrt()
                };
                backdrop + (2.0 * source - 1.0) * (d - backdrop)
            }
        }
        BlendMode::HardLight => {
            if source <= 0.5 {
                2.0 * backdrop * source
            } else {
                1.0 - 2.0 * (1.0 - backdrop) * (1.0 - source)
            }
        }
        BlendMode::Difference => (backdrop - source).abs(),
        BlendMode::Darken => backdrop.min(source),
        BlendMode::Lighten => backdrop.max(source),
        BlendMode::ColorDodge => {
            if source >= 1.0 {
                1.0
            } else {
                (backdrop / (1.0 - source)).min(1.0)
            }
        }
        BlendMode::ColorBurn => {
            if source <= 0.0 {
                0.0
            } else {
                1.0 - ((1.0 - backdrop) / source).min(1.0)
            }
        }
    }
}

pub fn composite_pixel(
    backdrop: LinearRgba,
    source: LinearRgba,
    mode: BlendMode,
    opacity: f32,
    matte: f32,
) -> Result<LinearRgba, String> {
    if !opacity.is_finite()
        || !matte.is_finite()
        || !(0.0..=1.0).contains(&opacity)
        || !(0.0..=1.0).contains(&matte)
    {
        return Err("invalid composite opacity or matte".into());
    }
    let backdrop = backdrop.clamped();
    let mut source = source.clamped();
    let factor = opacity * matte;
    source.r *= factor;
    source.g *= factor;
    source.b *= factor;
    source.a *= factor;
    let cb = backdrop.unpremultiplied();
    let cs = source.unpremultiplied();
    let blend = |b: f32, s: f32| blend_channel(b, s, mode);
    let a = source.a + backdrop.a * (1.0 - source.a);
    let channel = |b_premult: f32, s_premult: f32, b: f32, s: f32| {
        (1.0 - source.a) * b_premult
            + (1.0 - backdrop.a) * s_premult
            + backdrop.a * source.a * blend(b, s)
    };
    Ok(LinearRgba {
        r: channel(backdrop.r, source.r, cb.r, cs.r),
        g: channel(backdrop.g, source.g, cb.g, cs.g),
        b: channel(backdrop.b, source.b, cb.b, cs.b),
        a,
    }
    .clamped())
}

pub fn matte_value(pixel: LinearRgba, mode: MatteMode) -> f32 {
    let straight = pixel.unpremultiplied();
    let luma =
        (0.2126 * straight.r + 0.7152 * straight.g + 0.0722 * straight.b).clamp(0.0, 1.0) * pixel.a;
    match mode {
        MatteMode::Alpha => pixel.a,
        MatteMode::AlphaInverted => 1.0 - pixel.a,
        MatteMode::Luma => luma,
        MatteMode::LumaInverted => 1.0 - luma,
    }
}

pub fn composite_frames(
    backdrop: &FloatFrame,
    source: &FloatFrame,
    mode: BlendMode,
    opacity: f32,
    matte: Option<(&FloatFrame, MatteMode)>,
) -> Result<FloatFrame, String> {
    backdrop.validate()?;
    source.validate()?;
    if backdrop.width != source.width || backdrop.height != source.height {
        return Err("composite frame sizes differ".into());
    }
    if let Some((matte_frame, _)) = matte {
        matte_frame.validate()?;
        if matte_frame.width != source.width || matte_frame.height != source.height {
            return Err("matte frame size differs".into());
        }
    }
    let mut output = FloatFrame::transparent(source.width, source.height)?;
    for index in 0..output.pixels.len() {
        let value = matte
            .map(|(frame, mode)| matte_value(frame.pixels[index], mode))
            .unwrap_or(1.0);
        output.pixels[index] = composite_pixel(
            backdrop.pixels[index],
            source.pixels[index],
            mode,
            opacity,
            value,
        )?;
    }
    output.validate()?;
    Ok(output)
}

pub fn apply_adjustment(
    frame: &mut FloatFrame,
    matrix: [[f32; 4]; 4],
    offset: [f32; 4],
    amount: f32,
) -> Result<(), String> {
    frame.validate()?;
    if !amount.is_finite()
        || !(0.0..=1.0).contains(&amount)
        || matrix
            .iter()
            .flatten()
            .chain(offset.iter())
            .any(|value| !value.is_finite())
    {
        return Err("invalid adjustment".into());
    }
    for pixel in &mut frame.pixels {
        let straight = pixel.unpremultiplied();
        let input = [straight.r, straight.g, straight.b, straight.a];
        let transformed = std::array::from_fn::<_, 4, _>(|row| {
            offset[row]
                + (0..4)
                    .map(|column| matrix[row][column] * input[column])
                    .sum::<f32>()
        });
        let mixed = LinearRgba {
            r: input[0] + (transformed[0] - input[0]) * amount,
            g: input[1] + (transformed[1] - input[1]) * amount,
            b: input[2] + (transformed[2] - input[2]) * amount,
            a: input[3] + (transformed[3] - input[3]) * amount,
        }
        .clamped()
        .premultiplied();
        *pixel = mixed;
    }
    frame.validate()
}

pub fn srgb_to_linear(value: f32) -> Result<f32, String> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err("sRGB value must be normalized".into());
    }
    Ok(if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    })
}

pub fn linear_to_srgb(value: f32) -> Result<f32, String> {
    if !value.is_finite() || value < 0.0 {
        return Err("linear value must be finite and non-negative".into());
    }
    Ok(if value <= 0.0031308 {
        12.92 * value
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    })
}

pub fn quantize_unorm(value: f32, bits: u8) -> Result<f32, String> {
    if !value.is_finite() || !matches!(bits, 8 | 10 | 12 | 16) {
        return Err("unsupported integer pixel depth".into());
    }
    let levels = ((1_u32 << bits) - 1) as f32;
    Ok((value.clamp(0.0, 1.0) * levels).round() / levels)
}
