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

fn sfnt_tables(bytes: &[u8]) -> Result<BTreeMap<&[u8], &[u8]>> {
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
    Ok(tables)
}

// Inspect the actual hash-bound SFNT, not just manifest claims. No extra parser/runtime dependency.
fn validate_static_face_bytes(bytes: &[u8], face: &FontFace) -> Result<()> {
    let tables = sfnt_tables(bytes)?;
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
    let (font, selection, _) = load_bundled_face(font_root, family, requested_weight)?;
    Ok((font, selection))
}

/// The hash-checked physical face, plus the vertical metrics libass sizes it by (read from the same bytes).
fn load_bundled_face(font_root: &Path, family: &str, requested_weight: f64) -> Result<(Font, FontSelection, FaceVerticalMetrics)> {
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
    let vertical = face_vertical_metrics(&font_bytes)?;
    let font = Font::from_bytes(font_bytes, FontSettings::default())
        .map_err(|error| anyhow::anyhow!("parse overlay font {family}: {error}"))?;
    Ok((font, selection, vertical))
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

/// libass draws `\blur b` as a Gaussian of σ = b·2/√ln 256 (measured on the vendored FFmpeg: \blur 1/2/3/4/6
/// → σ 0.84/1.66/2.58/3.40/5.10 px). render/captionLayout.ts uses the same constant for the HTML preview.
const LIBASS_BLUR_SIGMA_PER_UNIT: f32 = 0.849_321_8;
/// MarginL/MarginR of the exported caption Style (render/captionAss.ts).
const CAPTION_SIDE_MARGIN: f32 = 40.0;
/// Punctuation a line never starts with / never ends with (render/captionLineBreak.ts).
const NO_LINE_START: &str = "，。、；：！？」』）》〉】〕…‧·,.;:!?)]}%～〜ー";
const NO_LINE_END: &str = "「『（《〈【〔([{";

/// The vertical metrics libass sizes a face by: the ASS Fontsize is OS/2 win ascent + descent, and lines stack
/// by the hhea ascent + descent (FreeType's face ascender/descender) at that scale. The generated
/// src/typography/fontEmMetrics.json the TypeScript previews use carries the same numbers.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct FaceVerticalMetrics {
    pub units_per_em: f32,
    pub hhea_ascender: f32,
    pub hhea_descender: f32,
    pub win_ascent: f32,
    pub win_descent: f32,
}

impl FaceVerticalMetrics {
    /// The pixel em, line ascent and line descent libass uses for an ASS Fontsize.
    pub(crate) fn at_ass_size(&self, size: f32) -> (f32, f32, f32) {
        let per_unit = size / (self.win_ascent + self.win_descent);
        (self.units_per_em * per_unit, self.hhea_ascender * per_unit, self.hhea_descender * per_unit)
    }
}

pub(crate) fn face_vertical_metrics(bytes: &[u8]) -> Result<FaceVerticalMetrics> {
    let tables = sfnt_tables(bytes)?;
    let head = tables.get(b"head".as_slice()).context("physical face has no head table")?;
    let hhea = tables.get(b"hhea".as_slice()).context("physical face has no hhea table")?;
    let os2 = tables.get(b"OS/2".as_slice()).context("physical face has no OS/2 identity")?;
    let units_per_em = f32::from(read_u16(head, 18)?);
    let hhea_ascender = f32::from(read_u16(hhea, 4)? as i16);
    let hhea_descender = -f32::from(read_u16(hhea, 6)? as i16);
    let (win_ascent, win_descent) = (f32::from(read_u16(os2, 74)?), f32::from(read_u16(os2, 76)?));
    if units_per_em < 16.0 || hhea_ascender <= 0.0 || hhea_descender < 0.0 || win_ascent + win_descent <= 0.0 {
        bail!("physical face vertical metrics are unusable");
    }
    Ok(FaceVerticalMetrics { units_per_em, hhea_ascender, hhea_descender, win_ascent, win_descent })
}

fn wide_character(character: char) -> bool {
    matches!(u32::from(character), 0x1100..=0x11FF | 0x2E80..=0x2FFF | 0x3000..=0x303F | 0x3040..=0x30FF
        | 0x3100..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF01..=0xFF60 | 0xFFE0..=0xFFE6 | 0x20000..=0x3FFFF)
}

/// Where a caption line may end: after a run of spaces, or next to a full-width character, never before closing
/// or after opening punctuation.
fn caption_break_after(characters: &[char], index: usize) -> bool {
    let (Some(&current), Some(&next)) = (characters.get(index), characters.get(index + 1)) else { return false };
    if current == ' ' {
        return next != ' ';
    }
    if next == ' ' || NO_LINE_START.contains(next) || NO_LINE_END.contains(current) {
        return false;
    }
    wide_character(current) || wide_character(next)
}

struct CaptionLine {
    /// Each drawn character with its pen offset from the line start.
    glyphs: Vec<(char, f32)>,
    width: f32,
}

fn caption_line(characters: &[char], advances: &[f32]) -> CaptionLine {
    let (mut from, mut to) = (0, characters.len());
    while from < to && characters[from] == ' ' { from += 1; }
    while to > from && characters[to - 1] == ' ' { to -= 1; }
    let mut pen = 0.0;
    let mut glyphs = Vec::with_capacity(to - from);
    for index in from..to {
        glyphs.push((characters[index], pen));
        pen += advances[index];
    }
    CaptionLine { glyphs, width: pen }
}

/// The lines TypeScript sent, already broken where the export breaks. A line still wider than the room
/// between the side margins (its Latin widths are estimates) wraps greedily at its last break opportunity, as
/// the HTML preview's own wrapping and libass would, rather than run off the frame.
fn caption_lines(font: &Font, text: &[char], em: f32, letter_spacing: f32, available: f32) -> Vec<CaptionLine> {
    let mut lines = Vec::new();
    for source in text.split(|character| *character == '\n') {
        // libass adds the style spacing after every glyph, the last one included.
        let advances = source.iter().map(|character| font.metrics(*character, em).advance_width + letter_spacing).collect::<Vec<_>>();
        let (mut start, mut last_break) = (0, None);
        for index in 0..source.len() {
            if source[index] != ' ' {
                if let Some(cut) = last_break.filter(|cut| *cut >= start) {
                    if caption_line(&source[start..=index], &advances[start..=index]).width > available {
                        lines.push(caption_line(&source[start..=cut], &advances[start..=cut]));
                        start = cut + 1;
                        last_break = None;
                    }
                }
            }
            if caption_break_after(source, index) { last_break = Some(index); }
        }
        lines.push(caption_line(&source[start..], &advances[start..]));
    }
    lines
}

/// A pixel rectangle of the canvas that every coverage mask of one caption shares.
#[derive(Clone, Copy)]
struct CoverageRegion {
    x: i32,
    y: i32,
    width: usize,
    height: usize,
}

impl CoverageRegion {
    fn around(left: f32, top: f32, right: f32, bottom: f32, canvas_width: u32, canvas_height: u32) -> Option<Self> {
        let x0 = left.floor().max(0.0) as i32;
        let y0 = top.floor().max(0.0) as i32;
        let x1 = (right.ceil() as i32).min(canvas_width as i32);
        let y1 = (bottom.ceil() as i32).min(canvas_height as i32);
        (x1 > x0 && y1 > y0).then(|| Self { x: x0, y: y0, width: (x1 - x0) as usize, height: (y1 - y0) as usize })
    }

    fn get(&self, mask: &[f32], x: i32, y: i32) -> f32 {
        let (local_x, local_y) = (x - self.x, y - self.y);
        if local_x < 0 || local_y < 0 || local_x as usize >= self.width || local_y as usize >= self.height {
            return 0.0;
        }
        mask[local_y as usize * self.width + local_x as usize]
    }

    /// Coverage at a fractional offset (a shadow need not move by whole pixels).
    fn shifted(&self, mask: &[f32], x: i32, y: i32, offset: f32) -> f32 {
        let position = (x as f32 - offset, y as f32 - offset);
        let (base_x, base_y) = (position.0.floor(), position.1.floor());
        let (fraction_x, fraction_y) = (position.0 - base_x, position.1 - base_y);
        let (base_x, base_y) = (base_x as i32, base_y as i32);
        self.get(mask, base_x, base_y) * (1.0 - fraction_x) * (1.0 - fraction_y)
            + self.get(mask, base_x + 1, base_y) * fraction_x * (1.0 - fraction_y)
            + self.get(mask, base_x, base_y + 1) * (1.0 - fraction_x) * fraction_y
            + self.get(mask, base_x + 1, base_y + 1) * fraction_x * fraction_y
    }
}

/// The glyphs grown by `radius` px in every direction, like libass's stroker (round joins), with an
/// antialiased rim.
fn dilate_coverage(mask: &[f32], region: CoverageRegion, radius: f32) -> Vec<f32> {
    let reach = (radius + 0.5).ceil() as i32;
    let mut kernel = Vec::new();
    for offset_y in -reach..=reach {
        for offset_x in -reach..=reach {
            let weight = (radius + 0.5 - ((offset_x * offset_x + offset_y * offset_y) as f32).sqrt()).clamp(0.0, 1.0);
            if weight > 0.0 { kernel.push((offset_x, offset_y, weight)); }
        }
    }
    let mut grown = vec![0.0; mask.len()];
    for y in 0..region.height as i32 {
        for x in 0..region.width as i32 {
            let mut coverage = 0.0_f32;
            for &(offset_x, offset_y, weight) in &kernel {
                coverage = coverage.max(region.get(mask, region.x + x + offset_x, region.y + y + offset_y) * weight);
                if coverage >= 1.0 { break; }
            }
            grown[y as usize * region.width + x as usize] = coverage;
        }
    }
    grown
}

/// Separable Gaussian blur of standard deviation `sigma` px (libass `\blur`).
fn gaussian_blur(mask: &mut [f32], region: CoverageRegion, sigma: f32) {
    let reach = (sigma * 3.0).ceil() as i32;
    let weights = (-reach..=reach).map(|offset| (-((offset * offset) as f32) / (2.0 * sigma * sigma)).exp()).collect::<Vec<_>>();
    let total = weights.iter().sum::<f32>();
    let weights = weights.iter().map(|weight| weight / total).collect::<Vec<_>>();
    let (width, height) = (region.width as i32, region.height as i32);
    let mut pass = vec![0.0; mask.len()];
    for y in 0..height {
        for x in 0..width {
            let mut sum = 0.0;
            for (tap, weight) in weights.iter().enumerate() {
                let source = x + tap as i32 - reach;
                if (0..width).contains(&source) { sum += mask[(y * width + source) as usize] * weight; }
            }
            pass[(y * width + x) as usize] = sum;
        }
    }
    for y in 0..height {
        for x in 0..width {
            let mut sum = 0.0;
            for (tap, weight) in weights.iter().enumerate() {
                let source = y + tap as i32 - reach;
                if (0..height).contains(&source) { sum += pass[(source * width + x) as usize] * weight; }
            }
            mask[(y * width + x) as usize] = sum;
        }
    }
}

/// Area coverage of an axis-aligned box over one pixel.
fn box_coverage(x: i32, y: i32, left: f32, top: f32, right: f32, bottom: f32) -> f32 {
    let horizontal = ((x + 1) as f32).min(right) - (x as f32).max(left);
    let vertical = ((y + 1) as f32).min(bottom) - (y as f32).max(top);
    horizontal.clamp(0.0, 1.0) * vertical.clamp(0.0, 1.0)
}

fn coverage_byte(coverage: f32) -> u8 {
    (coverage.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Draws a caption the way the export's libass draws it (render/captionLayout.ts describes the same model for
/// the HTML preview): the ASS Fontsize is the face's OS/2 win ascent + descent, the lines are the ones
/// TypeScript broke (`lines`) stacked by hhea ascent + descent between 40 px side margins and MarginV, an outline
/// is the glyph grown by the outline width, the shadow is that grown shape (the bare glyph without an outline)
/// offset by `shadow` px in the shadow colour, `shadow_blur` (libass `\blur`) softens only outline and shadow,
/// and a visible background colour draws BorderStyle 3 instead: one box per line padded by max(8, outline).
pub fn rasterize_caption(
    plan: &EngineVideoCaptionPlan,
    font_root: &Path,
    width: u32,
    height: u32,
) -> Result<CaptionRaster> {
    let (font, selection, vertical) =
        load_bundled_face(font_root, &plan.font_family, if plan.bold { 800.0 } else { 400.0 })?;
    let text_color = parse_color(&plan.text_color)?;
    let outline_color = parse_color(&plan.outline_color)?;
    let background_color = parse_color(&plan.background_color)?;
    let boxed = background_color[3] > 0;
    // ASS BackColour: a box shadows in its own colour; otherwise the authored shadow colour, else the background.
    let shadow_color = match (&plan.shadow_color, boxed) {
        (Some(color), false) => parse_color(color)?,
        _ => background_color,
    };
    // The lines TypeScript broke where the export breaks; a plan without them draws the text as typed.
    let drawn = plan.lines.as_ref().map_or_else(|| plan.text.clone(), |lines| lines.join("\n"));
    let characters = drawn.chars().filter(|character| *character != '\r').collect::<Vec<_>>();
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
    let (em, ascent, descent) = vertical.at_ass_size(plan.font_size);
    let pitch = ascent + descent;
    let (canvas_width, canvas_height) = (width as f32, height as f32);
    let available = (canvas_width - 2.0 * CAPTION_SIDE_MARGIN).max(1.0);
    let lines = caption_lines(&font, &characters, em, plan.letter_spacing, available);
    // libass stacks the line boxes (an empty line is half as tall) and anchors the block by alignment.
    let heights = lines.iter().map(|line| if line.glyphs.is_empty() { pitch / 2.0 } else { pitch }).collect::<Vec<_>>();
    let block = heights.iter().sum::<f32>();
    let mut line_top = match plan.alignment {
        7..=9 => plan.margin_vertical,
        4..=6 => (canvas_height - block) / 2.0,
        _ => canvas_height - plan.margin_vertical - block,
    };
    // Glyph bitmaps at their libass positions, and each non-empty line's box (line box + advance width).
    let mut placed = Vec::new();
    let mut line_boxes = Vec::new();
    for (line, line_height) in lines.iter().zip(&heights) {
        let start = match plan.alignment % 3 {
            1 => CAPTION_SIDE_MARGIN,
            0 => canvas_width - CAPTION_SIDE_MARGIN - line.width,
            _ => CAPTION_SIDE_MARGIN + (available - line.width) / 2.0,
        };
        if !line.glyphs.is_empty() {
            line_boxes.push((start, line_top, start + line.width, line_top + pitch));
        }
        let baseline = (line_top + ascent).round() as i32;
        for &(character, pen) in &line.glyphs {
            if character.is_whitespace() { continue; }
            let (metrics, bitmap) = font.rasterize(character, em);
            let left = (start + pen).round() as i32 + metrics.xmin;
            let top = baseline - metrics.ymin - metrics.height as i32;
            placed.push((left, top, metrics.width, metrics.height, bitmap));
        }
        line_top += line_height;
    }
    let mut pixels = vec![0_u8; width as usize * height as usize * 4];
    let mut paint = |region: CoverageRegion, coverage: &dyn Fn(i32, i32) -> f32, color: [u8; 4]| {
        for y in region.y..region.y + region.height as i32 {
            for x in region.x..region.x + region.width as i32 {
                let value = coverage_byte(coverage(x, y));
                if value > 0 { blend_canvas_pixel(&mut pixels, width, height, x, y, color, value); }
            }
        }
    };
    let shadow = if plan.shadow > 0.0 && shadow_color[3] > 0 { plan.shadow } else { 0.0 };
    let border = if boxed { 0.0 } else { plan.outline_width.max(0.0) };
    let sigma = if !boxed && border > 0.0 && plan.shadow_blur > 0.0 { plan.shadow_blur.min(32.0) * LIBASS_BLUR_SIGMA_PER_UNIT } else { 0.0 };
    let (mut left, mut top, mut right, mut bottom) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for (x, y, glyph_width, glyph_height, _) in &placed {
        left = left.min(*x as f32);
        top = top.min(*y as f32);
        right = right.max((*x + *glyph_width as i32) as f32);
        bottom = bottom.max((*y + *glyph_height as i32) as f32);
    }
    if boxed {
        // BorderStyle 3: one box per line, padded by the ASS Outline the writer uses for a box.
        let padding = plan.outline_width.max(8.0);
        let boxes = line_boxes.iter().map(|&(x0, y0, x1, y1)| (x0 - padding, y0 - padding, x1 + padding, y1 + padding)).collect::<Vec<_>>();
        let union = |offset: f32, x: i32, y: i32| boxes.iter()
            .map(|&(x0, y0, x1, y1)| box_coverage(x, y, x0 + offset, y0 + offset, x1 + offset, y1 + offset))
            .fold(0.0_f32, f32::max);
        for &(x0, y0, x1, y1) in &boxes {
            left = left.min(x0);
            top = top.min(y0);
            right = right.max(x1 + shadow);
            bottom = bottom.max(y1 + shadow);
        }
        if let Some(region) = CoverageRegion::around(left, top, right + 1.0, bottom + 1.0, width, height) {
            if shadow > 0.0 { paint(region, &|x, y| union(shadow, x, y), shadow_color); }
            paint(region, &|x, y| union(0.0, x, y), background_color);
        }
    }
    let margin = border + sigma * 3.0 + shadow + 2.0;
    if let Some(region) = (!placed.is_empty()).then(|| CoverageRegion::around(left - margin, top - margin, right + margin, bottom + margin, width, height)).flatten() {
        let mut fill = vec![0.0_f32; region.width * region.height];
        for (x, y, glyph_width, glyph_height, bitmap) in &placed {
            for row in 0..*glyph_height {
                for column in 0..*glyph_width {
                    let (target_x, target_y) = (x + column as i32 - region.x, y + row as i32 - region.y);
                    if target_x < 0 || target_y < 0 || target_x as usize >= region.width || target_y as usize >= region.height { continue; }
                    let target = target_y as usize * region.width + target_x as usize;
                    fill[target] = fill[target].max(f32::from(bitmap[row * glyph_width + column]) / 255.0);
                }
            }
        }
        if !boxed {
            let mut grown = if border > 0.0 { dilate_coverage(&fill, region, border) } else { Vec::new() };
            if sigma > 0.0 { gaussian_blur(&mut grown, region, sigma); }
            // The shadow copies the (softened) grown shape before the outline is trimmed under a see-through fill.
            if shadow > 0.0 {
                let source = if border > 0.0 { &grown } else { &fill };
                paint(region, &|x, y| region.shifted(source, x, y, shadow), shadow_color);
            }
            if border > 0.0 && outline_color[3] > 0 {
                if text_color[3] < 255 {
                    // libass fix_outline: under a see-through fill the outline keeps only what the fill does not cover.
                    for (outline, glyph) in grown.iter_mut().zip(&fill) {
                        *outline = if *outline > *glyph { *outline - *glyph / 2.0 } else { 0.0 };
                    }
                }
                paint(region, &|x, y| region.get(&grown, x, y), outline_color);
            }
        }
        paint(region, &|x, y| region.get(&fill, x, y), text_color);
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
            shadow_color: None,
            shadow_blur: 0.0,
            lines: None,
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

    fn shorts_caption_plan(family: &str, font_size: f32, text: &str) -> EngineVideoCaptionPlan {
        // shortsCaptionStyle on 1080x1920, as render/engineGraph.ts sends it.
        EngineVideoCaptionPlan {
            node_id: "caption".into(),
            cue_id: "cue".into(),
            text: text.into(),
            timeline: NodeFrameRange {
                timeline_start_frame: 0,
                source_start_frame: 0,
                duration_frames: 30,
            },
            font_family: family.into(),
            font_size,
            text_color: "#FFFFFF".into(),
            outline_color: "#00000073".into(),
            outline_width: 3.0,
            background_color: "#00000000".into(),
            alignment: 2,
            margin_vertical: 300.0,
            bold: true,
            shadow: 4.0,
            letter_spacing: 0.0,
            shadow_color: Some("#00000099".into()),
            shadow_blur: 4.0,
            lines: None,
        }
    }

    fn public_fonts() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../public/fonts")
    }

    /// The raster over the parity harness's #808080, as luma.
    fn over_grey(raster: &CaptionRaster) -> Vec<u8> {
        raster.pixels.chunks_exact(4).map(|pixel| {
            let alpha = f32::from(pixel[3]) / 255.0;
            let luma = (f32::from(pixel[0]) + f32::from(pixel[1]) + f32::from(pixel[2])) / 3.0;
            (luma * alpha + 128.0 * (1.0 - alpha)).round() as u8
        }).collect()
    }

    /// (top, bottom, left, right) of each band of near-white fill ink, the harness's line measure.
    fn fill_bands(raster: &CaptionRaster) -> Vec<(usize, usize, usize, usize)> {
        let (width, grey) = (raster.width as usize, over_grey(raster));
        let rows = (0..raster.height as usize).filter(|y| grey[y * width..(y + 1) * width].iter().any(|value| *value >= 200)).collect::<Vec<_>>();
        let mut bands: Vec<(usize, usize, usize, usize)> = Vec::new();
        for y in rows {
            let columns = (0..width).filter(|x| grey[y * width + x] >= 200).collect::<Vec<_>>();
            let (left, right) = (columns[0], *columns.last().unwrap());
            match bands.last_mut() {
                Some(band) if y - band.1 <= 6 => *band = (band.0, y, band.2.min(left), band.3.max(right)),
                _ => bands.push((y, y, left, right)),
            }
        }
        bands
    }

    fn near(actual: usize, expected: usize, tolerance: usize) -> bool {
        actual.abs_diff(expected) <= tolerance
    }

    #[test]
    fn caption_size_converts_the_ass_fontsize_like_libass() {
        // Export references (vendored FFmpeg/libass, same faces, 1080x1920): Noto Sans TC 95 and LXGW WenKai TC
        // 86 draw 「樹上停滿獨角仙」 as 62 px ink, Noto at rows 1545-1606 / columns 312-764, WenKai 1546-1607 / 314-761.
        for (family, size, top, bottom, left, right) in [("Noto Sans TC", 95.0, 1545, 1606, 312, 764), ("LXGW WenKai TC", 86.0, 1546, 1607, 314, 761)] {
            let raster = rasterize_caption(&shorts_caption_plan(family, size, "樹上停滿獨角仙"), &public_fonts(), 1080, 1920).unwrap();
            let bands = fill_bands(&raster);
            assert_eq!(bands.len(), 1, "{family}: {bands:?}");
            let (ink_top, ink_bottom, ink_left, ink_right) = bands[0];
            assert!((61..=63).contains(&(ink_bottom - ink_top + 1)), "{family} glyph height {}", ink_bottom - ink_top + 1);
            assert!(near(ink_top, top, 1) && near(ink_bottom, bottom, 1), "{family} rows {ink_top}-{ink_bottom}");
            assert!(near(ink_left, left, 2) && near(ink_right, right, 2), "{family} columns {ink_left}-{ink_right}");
        }
    }

    #[test]
    fn caption_draws_every_line_typescript_broke_with_the_libass_line_pitch() {
        // The export draws these three lines (breakCaptionLines, maxLineEm 11) at rows 1355-1416, 1450-1511 and
        // 1545-1606: a 95 px pitch, the last line box ending MarginV 300 above the frame bottom.
        let mut plan = shorts_caption_plan("Noto Sans TC", 95.0, "今天帶大家來看觀音山遊客中心門口這棵樹上停滿的獨角仙");
        plan.lines = Some(vec!["今天帶大家來看觀音山".into(), "遊客中心門口這棵".into(), "樹上停滿的獨角仙".into()]);
        let raster = rasterize_caption(&plan, &public_fonts(), 1080, 1920).unwrap();
        let bands = fill_bands(&raster);
        assert_eq!(bands.len(), 3, "{bands:?}");
        for ((top, bottom, left, right), (expected_top, expected_bottom, expected_left, expected_right)) in
            bands.iter().zip([(1355, 1416, 214, 861), (1450, 1511, 279, 800), (1545, 1606, 279, 797)])
        {
            assert!(near(*top, expected_top, 1) && near(*bottom, expected_bottom, 1), "rows {top}-{bottom}");
            assert!(near(*left, expected_left, 2) && near(*right, expected_right, 2), "columns {left}-{right}");
        }
        assert_eq!(raster.glyph_count, 26);
    }

    #[test]
    fn caption_shadow_takes_its_colour_offset_and_libass_blur() {
        // One horizontal bar: the column under its middle sees only the bar's own shadow.
        let text = "一";
        let shadow_alpha_below = |blur: f32| {
            let mut plan = shorts_caption_plan("Noto Sans TC", 95.0, text);
            // Only the shadow shows: a transparent outline still widens the shadow shape, as in libass.
            plan.outline_color = "#00000000".into();
            plan.shadow_color = Some("#FF0000FF".into());
            plan.shadow_blur = blur;
            let raster = rasterize_caption(&plan, &public_fonts(), 1080, 1920).unwrap();
            let (_, bottom, left, right) = fill_bands(&raster)[0];
            let column = (left + right) / 2;
            // From two rows under the fill's last bright row, so no antialiased fill pixel is sampled.
            (bottom + 3..bottom + 26).map(|y| {
                let pixel = &raster.pixels[(y * 1080 + column) * 4..][..4];
                assert!(pixel[3] == 0 || (pixel[0] == 255 && pixel[1] == 0 && pixel[2] == 0), "shadow colour {pixel:?}");
                pixel[3]
            }).collect::<Vec<_>>()
        };
        let soft = shadow_alpha_below(4.0);
        let hard = shadow_alpha_below(0.0);
        // Hard: the glyph grown by the 3 px border and moved 4 px down stays solid to its edge, then nothing.
        assert!(hard[..2].iter().all(|alpha| *alpha == 255) && hard[7..].iter().all(|alpha| *alpha == 0), "{hard:?}");
        // \blur 4 (σ ≈ 3.4 px): a smooth fall-off that already fades where the hard one is solid and reaches past it.
        let distinct = soft.iter().collect::<BTreeSet<_>>().len();
        assert!(distinct >= 10 && soft.windows(2).all(|pair| pair[1] <= pair[0]) && soft[9] > 0 && soft[0] < 255, "{soft:?}");
        // The legacy default keeps a transparent BackColour: no shadow at all.
        let mut legacy = shorts_caption_plan("Noto Sans TC", 54.0, text);
        legacy.shadow_color = None;
        legacy.outline_color = "#00000000".into();
        legacy.shadow_blur = 0.0;
        let raster = rasterize_caption(&legacy, &public_fonts(), 1080, 1920).unwrap();
        assert!(raster.pixels.chunks_exact(4).all(|pixel| pixel[3] == 0 || (pixel[0] == 255 && pixel[1] == 255 && pixel[2] == 255)));
    }

    #[test]
    fn boxed_caption_draws_one_padded_box_per_line_like_border_style_3() {
        // The export's box for the long-form default with a 65% black background: columns 784-1136, rows 946-1016
        // (line box ± max(8, outline) and the 1 px shadow box).
        let plan = EngineVideoCaptionPlan {
            text: "清楚可讀，才是重點".into(),
            font_size: 54.0,
            outline_color: "#000000".into(),
            outline_width: 4.0,
            background_color: "#000000A6".into(),
            margin_vertical: 72.0,
            shadow: 1.0,
            shadow_color: None,
            shadow_blur: 0.0,
            ..shorts_caption_plan("Noto Sans TC", 54.0, "")
        };
        let raster = rasterize_caption(&plan, &public_fonts(), 1920, 1080).unwrap();
        let painted = raster.pixels.chunks_exact(4).enumerate().filter(|(_, pixel)| pixel[3] > 24).map(|(index, _)| (index % 1920, index / 1920)).collect::<Vec<_>>();
        let (left, right) = (painted.iter().map(|p| p.0).min().unwrap(), painted.iter().map(|p| p.0).max().unwrap());
        let (top, bottom) = (painted.iter().map(|p| p.1).min().unwrap(), painted.iter().map(|p| p.1).max().unwrap());
        assert!(near(left, 784, 1) && near(right, 1136, 1) && near(top, 946, 1) && near(bottom, 1016, 1), "{left}-{right} x {top}-{bottom}");
    }

    #[test]
    fn a_line_wider_than_the_frame_still_wraps_inside_the_side_margins() {
        let plan = EngineVideoCaptionPlan {
            text: "永".repeat(60),
            font_size: 54.0,
            margin_vertical: 72.0,
            ..shorts_caption_plan("Noto Sans TC", 54.0, "")
        };
        let raster = rasterize_caption(&plan, &public_fonts(), 1920, 1080).unwrap();
        let bands = fill_bands(&raster);
        assert_eq!(bands.len(), 2, "{bands:?}");
        assert!(bands.iter().all(|band| band.2 >= 40 && band.3 < 1880), "{bands:?}");
    }

    #[test]
    fn face_metrics_are_the_ones_the_typescript_previews_use() {
        // src/typography/fontEmMetrics.json drives the HTML preview's size conversion; the native raster reads the
        // same OS/2 win and hhea numbers from the hash-checked faces themselves.
        let index: serde_json::Value = serde_json::from_slice(&fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/generated/fontEmMetrics.json")).unwrap()).unwrap();
        let manifest: FontManifest = serde_json::from_slice(&fs::read(public_fonts().join("editkin-open-fonts.json")).unwrap()).unwrap();
        let mut checked = 0;
        for face in manifest.fonts.iter().flat_map(|entry| &entry.faces) {
            let metrics = face_vertical_metrics(&fs::read(public_fonts().join(&face.file)).unwrap()).unwrap();
            let expected = index["faces"].as_array().unwrap().iter().find(|item| item["id"] == face.id.as_str()).unwrap();
            for (actual, key) in [(metrics.units_per_em, "unitsPerEm"), (metrics.win_ascent, "assAscender"), (metrics.win_descent, "assDescender"),
                (metrics.hhea_ascender, "cssAscender"), (metrics.hhea_descender, "cssDescender")] {
                assert_eq!(f64::from(actual), expected[key].as_f64().unwrap(), "{} {key}", face.id);
            }
            checked += 1;
        }
        assert!(checked >= 40, "{checked} faces");
        let noto = face_vertical_metrics(&fs::read(public_fonts().join("render/EditkinFace-noto-sans-tc-800.ttf")).unwrap()).unwrap();
        let (em, ascent, descent) = noto.at_ass_size(95.0);
        assert!((em - 95.0 / 1.448).abs() < 1e-4 && (ascent + descent - 95.0).abs() < 1e-4);
    }

    /// Caption parity harness, not a regression test. Each line of the file named by
    /// EDITKIN_CAPTION_PARITY_JOBS is `<caption node json>|<width>|<height>|<out png>`: the node is the
    /// caption node TypeScript writes into the engine graph, prepared exactly like the resident preview
    /// prepares it, rasterized, and composited over #808080 so it can be compared with the libass export.
    #[test]
    #[ignore = "parity harness: run explicitly with --ignored and EDITKIN_CAPTION_PARITY_JOBS"]
    fn caption_parity_dump() {
        let jobs = std::env::var("EDITKIN_CAPTION_PARITY_JOBS").expect("EDITKIN_CAPTION_PARITY_JOBS");
        let font_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../public/fonts");
        for job in fs::read_to_string(jobs).unwrap().lines().filter(|line| !line.trim().is_empty()) {
            let parts = job.split('|').collect::<Vec<_>>();
            let node: hao_core::engine::model::EngineNode =
                serde_json::from_str(&fs::read_to_string(parts[0]).unwrap()).unwrap();
            let plan = crate::engine_graph::prepare_video_caption(&node, &mut BTreeSet::new()).unwrap();
            let (width, height) = (parts[1].parse::<u32>().unwrap(), parts[2].parse::<u32>().unwrap());
            let raster = rasterize_caption(&plan, &font_root, width, height).unwrap();
            let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
            for pixel in raster.pixels.chunks_exact(4) {
                let alpha = f32::from(pixel[3]) / 255.0;
                for channel in 0..3 {
                    rgb.push((f32::from(pixel[channel]) * alpha + 128.0 * (1.0 - alpha)).round() as u8);
                }
            }
            image::save_buffer(parts[3], &rgb, width, height, image::ColorType::Rgb8).unwrap();
        }
    }
}
