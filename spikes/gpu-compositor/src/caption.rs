use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use fontdue::{Font, FontSettings};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::engine_graph::{EngineVideoCaptionPlan, EngineVideoMotionGraphicPlan};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FontManifest {
    schema_version: u32,
    id: String,
    fonts: Vec<FontEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FontEntry {
    id: String,
    family: String,
    file: String,
    bytes: u64,
    sha256: String,
    faces: Vec<FontFace>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FontFace {
    id: String,
    weight: u16,
    file: String,
    bytes: u64,
    sha256: String,
    family: String,
    postscript_name: String,
    source_sha256: String,
}

#[derive(Clone, Debug)]
struct FontSelection {
    logical_family: String,
    face: FontFace,
    requested_weight: f64,
}

#[derive(Debug)]
pub struct CaptionRaster {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub glyph_count: usize,
    pub missing_glyph_count: usize,
    pub atlas_sha256: String,
    pub font_sha256: String,
    pub font_family: String,
    pub font_face_id: String,
    pub font_face_family: String,
    pub font_file: String,
    pub requested_font_weight: f64,
    pub resolved_font_weight: u16,
    pub font_weight_substituted: bool,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn parse_color(value: &str) -> Result<[u8; 4]> {
    let value = value
        .strip_prefix('#')
        .with_context(|| format!("caption color must start with #: {value}"))?;
    if !matches!(value.len(), 6 | 8) {
        bail!("caption color must use #RRGGBB or #RRGGBBAA: #{value}");
    }
    let mut color = [0_u8, 0, 0, 255];
    for (index, channel) in color.iter_mut().take(value.len() / 2).enumerate() {
        *channel = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .with_context(|| format!("invalid caption color: #{value}"))?;
    }
    Ok(color)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_relative_file(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(['\\', ':', '\0'])
        && !value.starts_with('/')
        && value.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && !part.ends_with(['.', ' ']))
}

fn validate_manifest(manifest: &FontManifest) -> Result<()> {
    if manifest.schema_version != 2 || manifest.id != "studio.hao.editkin-open-fonts" || manifest.fonts.is_empty() {
        bail!("overlay font manifest contract requires physical faces (schema 2)");
    }
    let mut ids = BTreeSet::new();
    let mut families = BTreeSet::new();
    let mut files = BTreeSet::new();
    let mut face_ids = BTreeSet::new();
    let mut face_families = BTreeSet::new();
    let mut face_hashes = BTreeSet::new();
    for entry in &manifest.fonts {
        if entry.id.is_empty() || !entry.id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || entry.family.trim().is_empty() || !ids.insert(&entry.id) || !families.insert(&entry.family)
            || !safe_relative_file(&entry.file) || !files.insert(&entry.file)
            || entry.bytes == 0 || !valid_sha256(&entry.sha256) || entry.faces.is_empty()
        {
            bail!("overlay font entry identity is invalid or duplicated: {}", entry.family);
        }
        let mut weights = BTreeSet::new();
        for face in &entry.faces {
            let expected_id = format!("EditkinFace-{}-{}", entry.id, face.weight);
            if !(100..=900).contains(&face.weight) || face.weight % 50 != 0 || !weights.insert(face.weight)
                || face.id != expected_id || face.postscript_name != expected_id
                || face.family != format!("EditkinFace {} {}", entry.id, face.weight)
                || face.file != format!("render/{expected_id}.ttf") || !safe_relative_file(&face.file)
                || !files.insert(&face.file) || !face_ids.insert(&face.id) || !face_families.insert(&face.family)
                || face.bytes == 0 || face.bytes > 64 * 1024 * 1024 || !valid_sha256(&face.sha256)
                || !face_hashes.insert(&face.sha256) || face.source_sha256 != entry.sha256
            {
                bail!("overlay physical face identity is invalid or duplicated: {}", face.id);
            }
        }
    }
    Ok(())
}

fn resolve_font_face(manifest: &FontManifest, family: &str, requested_weight: f64) -> Result<FontSelection> {
    if !requested_weight.is_finite() || !(100.0..=900.0).contains(&requested_weight) {
        bail!("overlay font weight must be finite and within 100..900");
    }
    validate_manifest(manifest)?;
    let entry = manifest.fonts.iter().find(|entry| entry.family == family)
        .with_context(|| format!("overlay font family is not bundled: {family}"))?;
    let face = entry.faces.iter().min_by(|a, b| {
        (f64::from(a.weight) - requested_weight).abs()
            .total_cmp(&(f64::from(b.weight) - requested_weight).abs())
            .then(a.weight.cmp(&b.weight))
    }).context("overlay font family has no physical faces")?;
    Ok(FontSelection { logical_family: entry.family.clone(), face: face.clone(), requested_weight })
}

fn reject_link_components(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        if matches!(component, Component::Prefix(_) | Component::CurDir) { continue; }
        let metadata = fs::symlink_metadata(&current).with_context(|| format!("inspect font path {}", current.display()))?;
        let mut is_link = metadata.file_type().is_symlink();
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            is_link |= metadata.file_attributes() & 0x400 != 0; // Reparse points include directory junctions.
        }
        if is_link { bail!("overlay font path must not contain symlinks/reparse points: {}", current.display()); }
    }
    Ok(())
}

fn checked_font_path(font_root: &Path, relative: &str) -> Result<PathBuf> {
    if !safe_relative_file(relative) { bail!("unsafe overlay font path: {relative}"); }
    reject_link_components(font_root)?;
    let root = fs::canonicalize(font_root)?;
    let path = root.join(relative);
    reject_link_components(&path)?;
    if !fs::metadata(&path)?.is_file() || !fs::canonicalize(&path)?.starts_with(&root) {
        bail!("overlay font path is not a contained regular file: {relative}");
    }
    Ok(path)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let slice = bytes.get(offset..offset + 2).context("truncated font u16")?;
    Ok(u16::from_be_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let slice = bytes.get(offset..offset + 4).context("truncated font u32")?;
    Ok(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

// Inspect the actual hash-bound SFNT, not just manifest claims. No extra parser/runtime dependency.
fn validate_static_face_bytes(bytes: &[u8], face: &FontFace) -> Result<()> {
    if read_u32(bytes, 0)? != 0x0001_0000 { bail!("overlay physical face must be a standalone TrueType font"); }
    let count = usize::from(read_u16(bytes, 4)?);
    let mut tables = BTreeMap::new();
    for index in 0..count {
        let offset = 12 + index * 16;
        let tag = bytes.get(offset..offset + 4).context("truncated font table directory")?;
        let start = usize::try_from(read_u32(bytes, offset + 8)?)?;
        let length = usize::try_from(read_u32(bytes, offset + 12)?)?;
        let end = start.checked_add(length).context("font table length overflow")?;
        let data = bytes.get(start..end).context("font table exceeds physical face bytes")?;
        if tables.insert(tag, data).is_some() { bail!("duplicate font table"); }
    }
    if tables.contains_key(b"fvar".as_slice()) { bail!("overlay physical face must not contain variable axes"); }
    let os2 = tables.get(b"OS/2".as_slice()).context("physical face has no OS/2 identity")?;
    if read_u16(os2, 4)? != face.weight { bail!("overlay physical face weight mismatch: {}", face.id); }
    let names = tables.get(b"name".as_slice()).context("physical face has no names")?;
    let name_count = usize::from(read_u16(names, 2)?);
    let strings = usize::from(read_u16(names, 4)?);
    let mut family_seen = false;
    let mut postscript_seen = false;
    for index in 0..name_count {
        let offset = 6 + index * 12;
        let platform = read_u16(names, offset)?;
        let name_id = read_u16(names, offset + 6)?;
        if !matches!(name_id, 1 | 6 | 16) || !matches!(platform, 0 | 1 | 3) { continue; }
        let length = usize::from(read_u16(names, offset + 8)?);
        let start = strings + usize::from(read_u16(names, offset + 10)?);
        let raw = names.get(start..start + length).context("physical face name exceeds table")?;
        let actual = if platform == 1 {
            String::from_utf8(raw.to_vec()).context("non-ASCII physical font name")?
        } else {
            if raw.len() % 2 != 0 { bail!("invalid physical font Unicode name"); }
            String::from_utf16(&raw.chunks_exact(2).map(|pair| u16::from_be_bytes([pair[0], pair[1]])).collect::<Vec<_>>())?
        };
        let expected = if name_id == 6 { &face.postscript_name } else { &face.family };
        if &actual != expected { bail!("overlay physical face name mismatch: {} nameID{name_id}", face.id); }
        family_seen |= name_id == 1;
        postscript_seen |= name_id == 6;
    }
    if !family_seen || !postscript_seen { bail!("physical face family/PostScript identity is missing"); }
    Ok(())
}

fn load_bundled_font(font_root: &Path, family: &str, requested_weight: f64) -> Result<(Font, FontSelection)> {
    let manifest_path = checked_font_path(font_root, "editkin-open-fonts.json")?;
    if fs::metadata(&manifest_path)?.len() > 1024 * 1024 { bail!("overlay font manifest is oversized"); }
    let manifest: FontManifest = serde_json::from_slice(
        &fs::read(&manifest_path).with_context(|| format!("read {}", manifest_path.display()))?,
    )
    .with_context(|| format!("parse {}", manifest_path.display()))?;
    let selection = resolve_font_face(&manifest, family, requested_weight)?;
    let font_path = checked_font_path(font_root, &selection.face.file)?;
    if fs::metadata(&font_path)?.len() != selection.face.bytes { bail!("overlay font identity mismatch: {family}"); }
    let font_bytes =
        fs::read(&font_path).with_context(|| format!("read {}", font_path.display()))?;
    if font_bytes.len() as u64 != selection.face.bytes || digest(&font_bytes) != selection.face.sha256 {
        bail!("overlay font identity mismatch: {family}");
    }
    validate_static_face_bytes(&font_bytes, &selection.face)?;
    let font = Font::from_bytes(font_bytes, FontSettings::default())
        .map_err(|error| anyhow::anyhow!("parse overlay font {family}: {error}"))?;
    Ok((font, selection))
}

fn blend_pixel(destination: &mut [u8], source: [u8; 4], coverage: u8) {
    let source_alpha = source[3] as f32 / 255.0 * coverage as f32 / 255.0;
    if source_alpha <= 0.0 {
        return;
    }
    let destination_alpha = destination[3] as f32 / 255.0;
    let output_alpha = source_alpha + destination_alpha * (1.0 - source_alpha);
    for channel in 0..3 {
        let source_value = source[channel] as f32 / 255.0;
        let destination_value = destination[channel] as f32 / 255.0;
        let output = if output_alpha <= f32::EPSILON {
            0.0
        } else {
            (source_value * source_alpha
                + destination_value * destination_alpha * (1.0 - source_alpha))
                / output_alpha
        };
        destination[channel] = (output.clamp(0.0, 1.0) * 255.0).round() as u8;
    }
    destination[3] = (output_alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
}

fn horizontal_origin(alignment: u8, canvas_width: i32, content_width: i32, padding: i32) -> i32 {
    match alignment {
        1 | 4 | 7 => padding,
        3 | 6 | 9 => canvas_width - content_width - padding,
        _ => (canvas_width - content_width) / 2,
    }
}

fn vertical_origin(
    alignment: u8,
    canvas_height: i32,
    content_height: i32,
    margin_vertical: i32,
) -> i32 {
    match alignment {
        7..=9 => margin_vertical,
        4..=6 => (canvas_height - content_height) / 2,
        _ => canvas_height - content_height - margin_vertical,
    }
}

pub fn rasterize_caption(
    plan: &EngineVideoCaptionPlan,
    font_root: &Path,
    width: u32,
    height: u32,
) -> Result<CaptionRaster> {
    let (font, selection) = load_bundled_font(font_root, &plan.font_family, if plan.bold { 800.0 } else { 400.0 })?;
    let text_color = parse_color(&plan.text_color)?;
    let outline_color = parse_color(&plan.outline_color)?;
    let background_color = parse_color(&plan.background_color)?;
    let font_size = plan.font_size;
    let line_height = (font_size * 1.25).ceil() as i32;
    let padding = (font_size * 0.35).ceil() as i32;
    let characters = plan.text.chars().collect::<Vec<_>>();
    let glyph_count = characters
        .iter()
        .filter(|character| !character.is_whitespace())
        .count();
    let missing_glyph_count = characters
        .iter()
        .filter(|character| !character.is_whitespace() && font.lookup_glyph_index(**character) == 0)
        .count();
    if missing_glyph_count > 0 {
        bail!("caption font is missing {missing_glyph_count} glyphs");
    }
    let metrics = characters
        .iter()
        .map(|character| font.metrics(*character, font_size))
        .collect::<Vec<_>>();
    let text_width = (metrics
        .iter()
        .map(|metrics| metrics.advance_width)
        .sum::<f32>()
        + plan.letter_spacing * characters.len().saturating_sub(1) as f32)
        .ceil() as i32;
    let box_width = (text_width + padding * 2).clamp(1, width as i32);
    let box_height = (line_height + padding).clamp(1, height as i32);
    let box_x = horizontal_origin(plan.alignment, width as i32, box_width, 20)
        .clamp(0, width as i32 - box_width);
    let box_y = vertical_origin(
        plan.alignment,
        height as i32,
        box_height,
        plan.margin_vertical.round() as i32,
    )
    .clamp(0, height as i32 - box_height);
    let mut pixels = vec![0_u8; width as usize * height as usize * 4];
    for y in box_y..box_y + box_height {
        for x in box_x..box_x + box_width {
            let offset = (y as usize * width as usize + x as usize) * 4;
            blend_pixel(&mut pixels[offset..offset + 4], background_color, 255);
        }
    }
    let mut glyph_mask = vec![0_u8; width as usize * height as usize];
    let mut cursor_x = box_x + padding;
    let glyph_top = box_y + (box_height - line_height) / 2;
    for (character, metrics) in characters.iter().zip(metrics.iter()) {
        let (raster_metrics, bitmap) = font.rasterize(*character, font_size);
        let glyph_x = cursor_x + raster_metrics.xmin;
        let glyph_y = glyph_top + (line_height - raster_metrics.height as i32) / 2;
        for row in 0..raster_metrics.height {
            for column in 0..raster_metrics.width {
                let x = glyph_x + column as i32;
                let y = glyph_y + row as i32;
                if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
                    continue;
                }
                let source = bitmap[row * raster_metrics.width + column];
                let target = y as usize * width as usize + x as usize;
                glyph_mask[target] = glyph_mask[target].max(source);
            }
        }
        cursor_x += (metrics.advance_width + plan.letter_spacing).ceil() as i32;
    }
    let shadow_offset = (plan.shadow * 2.0).round() as i32;
    if shadow_offset > 0 {
        for y in 0..height as i32 {
            for x in 0..width as i32 {
                let source_x = x - shadow_offset;
                let source_y = y - shadow_offset;
                if source_x < 0 || source_y < 0 {
                    continue;
                }
                let coverage = glyph_mask[source_y as usize * width as usize + source_x as usize];
                if coverage > 0 {
                    let offset = (y as usize * width as usize + x as usize) * 4;
                    blend_pixel(&mut pixels[offset..offset + 4], [0, 0, 0, 160], coverage);
                }
            }
        }
    }
    let outline_radius = plan.outline_width.ceil() as i32;
    if outline_radius > 0 && outline_color[3] > 0 {
        for y in (box_y - outline_radius).max(0)
            ..(box_y + box_height + outline_radius).min(height as i32)
        {
            for x in (box_x - outline_radius).max(0)
                ..(box_x + box_width + outline_radius).min(width as i32)
            {
                let mut coverage = 0_u8;
                for offset_y in -outline_radius..=outline_radius {
                    for offset_x in -outline_radius..=outline_radius {
                        if offset_x * offset_x + offset_y * offset_y
                            > outline_radius * outline_radius
                        {
                            continue;
                        }
                        let source_x = x + offset_x;
                        let source_y = y + offset_y;
                        if source_x >= 0
                            && source_y >= 0
                            && source_x < width as i32
                            && source_y < height as i32
                        {
                            coverage = coverage.max(
                                glyph_mask[source_y as usize * width as usize + source_x as usize],
                            );
                        }
                    }
                }
                if coverage > 0 {
                    let offset = (y as usize * width as usize + x as usize) * 4;
                    blend_pixel(&mut pixels[offset..offset + 4], outline_color, coverage);
                }
            }
        }
    }
    for (pixel_index, coverage) in glyph_mask.into_iter().enumerate() {
        if coverage > 0 {
            let offset = pixel_index * 4;
            blend_pixel(&mut pixels[offset..offset + 4], text_color, coverage);
        }
    }
    let atlas_sha256 = digest(&pixels);
    Ok(CaptionRaster {
        pixels,
        width,
        height,
        glyph_count,
        missing_glyph_count,
        atlas_sha256,
        font_sha256: selection.face.sha256,
        font_family: selection.logical_family,
        font_face_id: selection.face.id,
        font_face_family: selection.face.family,
        font_file: selection.face.file,
        requested_font_weight: selection.requested_weight,
        resolved_font_weight: selection.face.weight,
        font_weight_substituted: f64::from(selection.face.weight) != selection.requested_weight,
    })
}

fn inside_rounded_box(x: i32, y: i32, width: i32, height: i32, radius: i32) -> bool {
    let radius = radius.clamp(0, width.min(height) / 2);
    if radius == 0 || (x >= radius && x < width - radius) || (y >= radius && y < height - radius) {
        return true;
    }
    let center_x = if x < radius {
        radius
    } else {
        width - radius - 1
    };
    let center_y = if y < radius {
        radius
    } else {
        height - radius - 1
    };
    let delta_x = x - center_x;
    let delta_y = y - center_y;
    delta_x * delta_x + delta_y * delta_y <= radius * radius
}

fn alpha_scaled(mut color: [u8; 4], numerator: u16, denominator: u16) -> [u8; 4] {
    color[3] = ((u16::from(color[3]) * numerator) / denominator.max(1)).min(255) as u8;
    color
}

fn blend_canvas_pixel(
    pixels: &mut [u8],
    canvas_width: u32,
    canvas_height: u32,
    x: i32,
    y: i32,
    color: [u8; 4],
    coverage: u8,
) {
    if x < 0 || y < 0 || x >= canvas_width as i32 || y >= canvas_height as i32 {
        return;
    }
    let offset = (y as usize * canvas_width as usize + x as usize) * 4;
    blend_pixel(&mut pixels[offset..offset + 4], color, coverage);
}

#[allow(clippy::too_many_arguments)]
fn draw_motion_graphic_panel(
    pixels: &mut [u8],
    canvas_width: u32,
    canvas_height: u32,
    box_x: i32,
    box_y: i32,
    box_width: i32,
    box_height: i32,
    radius: i32,
    accent_width: i32,
    visual_style: &str,
    background_color: [u8; 4],
    accent_color: [u8; 4],
) {
    let panel_color = if visual_style == "solid_panel" {
        background_color
    } else {
        alpha_scaled(background_color, 3, 4)
    };
    let grid = (box_height / 5).clamp(7, 18);
    let corner = (box_height / 4).clamp(8, 22);
    for local_y in 0..box_height {
        for local_x in 0..box_width {
            if !inside_rounded_box(local_x, local_y, box_width, box_height, radius) {
                continue;
            }
            let x = box_x + local_x;
            let y = box_y + local_y;
            blend_canvas_pixel(pixels, canvas_width, canvas_height, x, y, panel_color, 255);
            let edge = local_x <= 1 || local_y <= 1 || local_x >= box_width - 2 || local_y >= box_height - 2;
            let corner_bracket = ((local_x < corner || local_x >= box_width - corner) && (local_y <= 2 || local_y >= box_height - 3))
                || ((local_y < corner || local_y >= box_height - corner) && (local_x <= 2 || local_x >= box_width - 3));
            let (hit, coverage) = match visual_style {
                "solid_panel" => (local_x < accent_width, 255),
                "holo_scan_cyan" => (corner_bracket || local_y % 5 == 0 || (local_y - box_height / 2).abs() <= 1, if (local_y - box_height / 2).abs() <= 1 { 210 } else { 72 }),
                "holo_grid_lime" => (edge || local_x % grid == 0 || local_y % grid == 0, if edge { 190 } else { 54 }),
                "target_lock_red" => (corner_bracket || ((local_x - box_width / 2).abs() <= 1 && (local_y < 8 || local_y >= box_height - 8)), if corner_bracket { 230 } else { 150 }),
                "spectral_wire_violet" => (edge || (local_x + local_y * 2).rem_euclid(grid + 5) <= 1, if edge { 170 } else { 46 }),
                "depth_glass_blue" => (edge || local_y == 3 || local_y == box_height - 4, if edge { 170 } else { 82 }),
                "telemetry_beam_amber" => (corner_bracket || local_y >= box_height - 5 && local_x % 12 <= 1 || local_x == accent_width, if corner_bracket { 220 } else { 110 }),
                "neon_extrude_white" => (edge || local_x == 4 || local_y == 4 || local_x == box_width - 5 || local_y == box_height - 5, if edge { 210 } else { 70 }),
                "quantum_label_magenta" => (corner_bracket || (local_x * 31 + local_y * 17).rem_euclid(89) <= 2, if corner_bracket { 215 } else { 90 }),
                _ => (false, 0),
            };
            if hit {
                blend_canvas_pixel(pixels, canvas_width, canvas_height, x, y, accent_color, coverage);
            }
        }
    }
}

pub fn rasterize_motion_graphic(
    plan: &EngineVideoMotionGraphicPlan,
    font_root: &Path,
    width: u32,
    height: u32,
) -> Result<CaptionRaster> {
    let (font, selection) = load_bundled_font(font_root, &plan.font_family, f64::from(plan.font_weight))?;
    let text_color = parse_color(&plan.text_color)?;
    let background_color = parse_color(&plan.background_color)?;
    let accent_color = parse_color(&plan.accent_color)?;
    let characters = plan.text.chars().collect::<Vec<_>>();
    let glyph_count = characters
        .iter()
        .filter(|character| !character.is_whitespace())
        .count();
    let missing_glyph_count = characters
        .iter()
        .filter(|character| !character.is_whitespace() && font.lookup_glyph_index(**character) == 0)
        .count();
    if missing_glyph_count > 0 {
        bail!("motion graphic font is missing {missing_glyph_count} glyphs");
    }
    let metrics = characters
        .iter()
        .map(|character| font.metrics(*character, plan.font_size))
        .collect::<Vec<_>>();
    let padding = (plan.font_size * 0.36).ceil() as i32;
    let accent_width = (plan.font_size * 0.16).ceil().max(6.0) as i32;
    let line_height = (plan.font_size * 1.25).ceil() as i32;
    let box_width = (plan.width * width as f32).round() as i32;
    let box_height = line_height + padding * 2;
    let box_x = (plan.x * width as f32).round() as i32;
    let box_y = (plan.y * height as f32).round() as i32;
    if box_width <= 0
        || box_height <= 0
        || box_x < 0
        || box_y < 0
        || box_x + box_width > width as i32
        || box_y + box_height > height as i32
    {
        bail!("motion graphic box exceeds the output canvas");
    }
    let text_width = (metrics
        .iter()
        .map(|metrics| metrics.advance_width)
        .sum::<f32>()
        + plan.letter_spacing * characters.len().saturating_sub(1) as f32)
        .ceil() as i32;
    if text_width + padding * 2 + accent_width > box_width {
        bail!("motion graphic text exceeds its authored width");
    }
    let radius = plan.corner_radius.round() as i32;
    let mut pixels = vec![0_u8; width as usize * height as usize * 4];
    let shadow = plan.shadow_depth.round() as i32;
    if shadow > 0 {
        for local_y in 0..box_height {
            for local_x in 0..box_width {
                if !inside_rounded_box(local_x, local_y, box_width, box_height, radius) {
                    continue;
                }
                let x = box_x + local_x + shadow;
                let y = box_y + local_y + shadow;
                if x < width as i32 && y < height as i32 {
                    let offset = (y as usize * width as usize + x as usize) * 4;
                    blend_pixel(&mut pixels[offset..offset + 4], [0, 0, 0, 150], 255);
                }
            }
        }
    }
    draw_motion_graphic_panel(
        &mut pixels,
        width,
        height,
        box_x,
        box_y,
        box_width,
        box_height,
        radius,
        accent_width,
        &plan.visual_style,
        background_color,
        accent_color,
    );
    let mut glyph_mask = vec![0_u8; width as usize * height as usize];
    let mut cursor_x = box_x + padding + accent_width;
    let glyph_top = box_y + padding + (line_height - plan.font_size.ceil() as i32) / 2;
    for (character, metrics) in characters.iter().zip(metrics.iter()) {
        let (raster_metrics, bitmap) = font.rasterize(*character, plan.font_size);
        let glyph_x = cursor_x + raster_metrics.xmin;
        let glyph_y = glyph_top + (line_height - raster_metrics.height as i32) / 2;
        for row in 0..raster_metrics.height {
            for column in 0..raster_metrics.width {
                let x = glyph_x + column as i32;
                let y = glyph_y + row as i32;
                if x < box_x || y < box_y || x >= box_x + box_width || y >= box_y + box_height {
                    continue;
                }
                let source = bitmap[row * raster_metrics.width + column];
                let target = y as usize * width as usize + x as usize;
                glyph_mask[target] = glyph_mask[target].max(source);
            }
        }
        cursor_x += (metrics.advance_width + plan.letter_spacing).ceil() as i32;
    }
    if matches!(plan.visual_style.as_str(), "neon_extrude_white" | "depth_glass_blue") {
        let extrusion_depth = (plan.font_size * 0.12).round().clamp(2.0, 9.0) as i32;
        for depth in (1..=extrusion_depth).rev() {
            let coverage_scale = ((extrusion_depth - depth + 2) * 180 / (extrusion_depth + 1)).clamp(24, 180) as u8;
            for y in box_y..box_y + box_height {
                for x in box_x..box_x + box_width {
                    let source_x = x - depth;
                    let source_y = y - depth;
                    if source_x < 0 || source_y < 0 || source_x >= width as i32 || source_y >= height as i32 {
                        continue;
                    }
                    let source = glyph_mask[source_y as usize * width as usize + source_x as usize];
                    if source > 0 {
                        blend_canvas_pixel(&mut pixels, width, height, x, y, accent_color, source.min(coverage_scale));
                    }
                }
            }
        }
    }
    let outline_radius = plan.outline_width.ceil() as i32;
    if outline_radius > 0 && accent_color[3] > 0 {
        for y in box_y..box_y + box_height {
            for x in box_x..box_x + box_width {
                let mut coverage = 0_u8;
                for offset_y in -outline_radius..=outline_radius {
                    for offset_x in -outline_radius..=outline_radius {
                        if offset_x * offset_x + offset_y * offset_y
                            > outline_radius * outline_radius
                        {
                            continue;
                        }
                        let source_x = x + offset_x;
                        let source_y = y + offset_y;
                        if source_x >= 0
                            && source_y >= 0
                            && source_x < width as i32
                            && source_y < height as i32
                        {
                            coverage = coverage.max(
                                glyph_mask[source_y as usize * width as usize + source_x as usize],
                            );
                        }
                    }
                }
                if coverage > 0 {
                    let offset = (y as usize * width as usize + x as usize) * 4;
                    blend_pixel(&mut pixels[offset..offset + 4], accent_color, coverage);
                }
            }
        }
    }
    for (pixel_index, coverage) in glyph_mask.into_iter().enumerate() {
        if coverage > 0 {
            let offset = pixel_index * 4;
            blend_pixel(&mut pixels[offset..offset + 4], text_color, coverage);
        }
    }
    let atlas_sha256 = digest(&pixels);
    Ok(CaptionRaster {
        pixels,
        width,
        height,
        glyph_count,
        missing_glyph_count,
        atlas_sha256,
        font_sha256: selection.face.sha256,
        font_family: selection.logical_family,
        font_face_id: selection.face.id,
        font_face_family: selection.face.family,
        font_file: selection.face.file,
        requested_font_weight: selection.requested_weight,
        resolved_font_weight: selection.face.weight,
        font_weight_substituted: f64::from(selection.face.weight) != selection.requested_weight,
    })
}

#[cfg(test)]
#[path = "caption_font_tests.rs"]
mod font_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use hao_core::engine::model::NodeFrameRange;
    use std::path::PathBuf;

    #[test]
    fn bundled_cjk_caption_raster_has_one_font_identity_and_visible_alpha() {
        let plan = EngineVideoCaptionPlan {
            node_id: "caption".into(),
            cue_id: "cue".into(),
            text: "字幕不要多色".into(),
            timeline: NodeFrameRange {
                timeline_start_frame: 0,
                source_start_frame: 0,
                duration_frames: 30,
            },
            font_family: "Noto Sans TC".into(),
            font_size: 32.0,
            text_color: "#FFFFFFFF".into(),
            outline_color: "#000000FF".into(),
            outline_width: 2.0,
            background_color: "#000000A6".into(),
            alignment: 2,
            margin_vertical: 20.0,
            bold: true,
            shadow: 1.0,
            letter_spacing: 0.0,
        };
        let font_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../public/fonts");
        let raster = rasterize_caption(&plan, &font_root, 320, 180).unwrap();
        assert_eq!(raster.glyph_count, 6);
        assert_eq!(raster.missing_glyph_count, 0);
        assert_eq!(raster.pixels.len(), 320 * 180 * 4);
        assert!(raster.pixels.chunks_exact(4).any(|pixel| pixel[3] > 0));
        assert_eq!(raster.atlas_sha256.len(), 64);
        assert_eq!(raster.font_sha256.len(), 64);
    }

    #[test]
    fn bundled_motion_graphic_raster_contains_background_accent_and_glyphs() {
        let plan = EngineVideoMotionGraphicPlan {
            node_id: "motion".into(),
            graphic_id: "stars".into(),
            graphic_kind: "tag".into(),
            text: "GitHub 1700+ 星".into(),
            timeline: NodeFrameRange {
                timeline_start_frame: 15,
                source_start_frame: 0,
                duration_frames: 45,
            },
            x: 0.08,
            y: 0.12,
            width: 0.55,
            font_size: 32.0,
            font_family: "Noto Sans TC".into(),
            font_weight: 700,
            letter_spacing: 0.0,
            outline_width: 2.0,
            shadow_depth: 2.0,
            corner_radius: 12.0,
            text_color: "#FFFFFFFF".into(),
            background_color: "#10151FEE".into(),
            accent_color: "#A8FF3EFF".into(),
            visual_style: "solid_panel".into(),
            animation: "fade".into(),
            tracking_mode: "anchor".into(),
            fade_in_frames: 5,
            fade_out_frames: 4,
            track_id: None,
            tracking_samples: vec![],
            canvas_width: 640,
            canvas_height: 360,
        };
        let font_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../public/fonts");
        let raster = rasterize_motion_graphic(&plan, &font_root, 640, 360).unwrap();
        assert!(raster.glyph_count >= 10);
        assert_eq!(raster.missing_glyph_count, 0);
        assert!(raster.pixels.chunks_exact(4).any(|pixel| pixel[3] > 0));
        assert!(
            raster
                .pixels
                .chunks_exact(4)
                .any(|pixel| pixel[0] > 130 && pixel[1] > 220 && pixel[2] < 120)
        );
        let mut procedural_hashes = std::collections::BTreeSet::new();
        for style in [
            "holo_scan_cyan",
            "holo_grid_lime",
            "target_lock_red",
            "spectral_wire_violet",
            "depth_glass_blue",
            "telemetry_beam_amber",
            "neon_extrude_white",
            "quantum_label_magenta",
        ] {
            let mut styled = plan.clone();
            styled.visual_style = style.into();
            let styled_raster = rasterize_motion_graphic(&styled, &font_root, 640, 360).unwrap();
            assert_ne!(styled_raster.atlas_sha256, raster.atlas_sha256, "{style} collapsed to solid_panel");
            procedural_hashes.insert(styled_raster.atlas_sha256);
        }
        assert_eq!(procedural_hashes.len(), 8, "procedural visual styles must produce distinct atlases");
    }
}
