use super::*;

pub(crate) fn estimate_tokens(content: &str) -> i32 {
    let mut cjk = 0usize;
    let mut ascii_text = 0usize;
    let mut other_text = 0usize;
    let mut punctuation = 0usize;
    for ch in content.chars() {
        if is_cjk(ch) {
            cjk += 1;
        } else if ch.is_ascii_alphanumeric() {
            ascii_text += 1;
        } else if ch.is_alphanumeric() {
            other_text += 1;
        } else if !ch.is_whitespace() {
            punctuation += 1;
        }
    }
    let estimate = cjk + ascii_text.div_ceil(4) + other_text.div_ceil(2) + punctuation.div_ceil(2);
    estimate.max(1) as i32
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xf900..=0xfaff
            | 0x20000..=0x2ffff
            | 0x3040..=0x30ff
            | 0xac00..=0xd7af
    )
}

pub(super) fn title_from_file_name(file_name: &str) -> String {
    file_name
        .rsplit_once('.')
        .map(|(name, _)| name)
        .unwrap_or(file_name)
        .trim()
        .to_string()
}

pub(super) fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

pub(super) fn looks_like_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"PK\x05\x06")
        || bytes.starts_with(b"PK\x07\x08")
}

pub(super) fn decode_text(bytes: &[u8]) -> Result<String> {
    if let Some(without_bom) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8(without_bom.to_vec()).context("invalid_utf8_text");
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        let (decoded, _, had_errors) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        if !had_errors {
            return Ok(decoded.into_owned());
        }
        bail!("invalid_utf16le_text");
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let (decoded, _, had_errors) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        if !had_errors {
            return Ok(decoded.into_owned());
        }
        bail!("invalid_utf16be_text");
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(text.to_string());
    }
    let (decoded, _, had_errors) = encoding_rs::GBK.decode(bytes);
    if had_errors {
        bail!("unsupported_text_encoding");
    }
    Ok(decoded.into_owned())
}
