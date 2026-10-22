//! PNG stores 16-bit samples big-endian; raw alpha16le bake transport is a separate contract.
use super::roto_edge_v2::{ROTO_EDGE_V2_MAX_PIXELS, RotoEdgeResultV2};

pub fn encode_roto_edge_alpha_png_v2(result: &RotoEdgeResultV2) -> Result<Vec<u8>, String> {
    result.matte.validate()?;
    let pixels = result.matte.alpha.len();
    if pixels > ROTO_EDGE_V2_MAX_PIXELS
        || result.receipt.settings.alpha16 != result.alpha16.is_some()
    {
        return Err("invalid edge alpha PNG layout or precision".into());
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, result.matte.width, result.matte.height);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(if result.alpha16.is_some() {
            png::BitDepth::Sixteen
        } else {
            png::BitDepth::Eight
        });
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        if let Some(alpha16) = &result.alpha16 {
            if alpha16.len() != pixels {
                return Err("alpha16 PNG sample count differs".into());
            }
            let samples: Vec<u8> = alpha16.iter().flat_map(|a| a.to_be_bytes()).collect();
            writer
                .write_image_data(&samples)
                .map_err(|e| e.to_string())?;
        } else {
            writer
                .write_image_data(&result.matte.alpha)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(bytes)
}
