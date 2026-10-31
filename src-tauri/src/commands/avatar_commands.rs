use super::config_store::{
    load_profile_preferences, normalize_profile_avatar, save_profile_preferences_to_store,
    ProfilePreferences,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::codecs::{jpeg::JpegEncoder, webp::WebPEncoder};
use image::imageops::FilterType;
use image::{DynamicImage, ExtendedColorType, ImageDecoder, ImageFormat, ImageReader, Limits};
use std::io::Cursor;
use tauri::ipc::{InvokeBody, Request};
use tauri::{command, AppHandle};

const SOURCE_MAX_BYTES: usize = 25 * 1024 * 1024;
const AVATAR_SIZE: u32 = 256;
const READ_IMAGE_ERROR: &str = "Couldn't read that image — try a PNG, JPEG, or WebP";
const OVERSIZE_IMAGE_ERROR: &str = "That image is over 25 MB";

fn validate_source_length(length: usize) -> Result<(), String> {
    if length > SOURCE_MAX_BYTES {
        Err(OVERSIZE_IMAGE_ERROR.to_string())
    } else if length == 0 {
        Err(READ_IMAGE_ERROR.to_string())
    } else {
        Ok(())
    }
}

fn render_avatar(bytes: &[u8], format: ImageFormat) -> image::ImageResult<(&'static str, Vec<u8>)> {
    let mut limits = Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder()?;
    // from_decoder does not reserve its output buffer against decoder limits.
    limits.reserve(decoder.total_bytes())?;
    decoder.set_limits(limits)?;
    let orientation = decoder.orientation()?;
    // The still-image decoder reads only the first frame of animated inputs.
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let (width, height) = (image.width(), image.height());
    let side = width.min(height);
    let pixels = image
        .crop_imm((width - side) / 2, (height - side) / 2, side, side)
        .resize_exact(AVATAR_SIZE, AVATAR_SIZE, FilterType::Lanczos3)
        .into_rgba8();
    let mut encoded = Vec::new();
    let mime = if pixels.pixels().all(|pixel| pixel[3] == 255) {
        let rgb = DynamicImage::ImageRgba8(pixels).into_rgb8();
        JpegEncoder::new_with_quality(&mut encoded, 85).encode(
            &rgb,
            AVATAR_SIZE,
            AVATAR_SIZE,
            ExtendedColorType::Rgb8,
        )?;
        "image/jpeg"
    } else {
        WebPEncoder::new_lossless(&mut encoded).encode(
            &pixels,
            AVATAR_SIZE,
            AVATAR_SIZE,
            ExtendedColorType::Rgba8,
        )?;
        "image/webp"
    };
    Ok((mime, encoded))
}

fn encode_avatar(bytes: &[u8]) -> Result<String, String> {
    validate_source_length(bytes.len())?;
    let format = image::guess_format(bytes).map_err(|_| READ_IMAGE_ERROR.to_string())?;
    if !matches!(
        format,
        ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::WebP
            | ImageFormat::Gif
            | ImageFormat::Bmp
    ) {
        return Err(READ_IMAGE_ERROR.to_string());
    }
    let (mime, encoded) = render_avatar(bytes, format).map_err(|_| READ_IMAGE_ERROR.to_string())?;
    normalize_profile_avatar(Some(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(encoded)
    )))
    .ok_or_else(|| READ_IMAGE_ERROR.to_string())
}

async fn persist_avatar(
    app: AppHandle,
    avatar: Option<String>,
) -> Result<ProfilePreferences, String> {
    super::run_blocking_store_op(move || {
        let store = super::open_store(&app, super::SETTINGS_STORE_FILE)?;
        let avatars = super::open_store(&app, super::PROFILE_AVATAR_STORE_FILE)?;
        let mut preferences = load_profile_preferences(&store, &avatars);
        preferences.profile.avatar = avatar;
        save_profile_preferences_to_store(&store, &avatars, &preferences)?;
        store.save()?;
        Ok(preferences)
    })
    .await
}

#[command]
pub async fn set_profile_avatar_from_bytes(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ProfilePreferences, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(READ_IMAGE_ERROR.to_string());
    };
    validate_source_length(bytes.len())?;
    let bytes = bytes.to_vec();
    let avatar = super::run_blocking_op(
        tokio::time::Instant::now() + super::BLOCKING_OP_TIMEOUT,
        READ_IMAGE_ERROR,
        move || encode_avatar(&bytes),
    )
    .await?;
    persist_avatar(app, Some(avatar)).await
}

#[command]
pub async fn clear_profile_avatar(app: AppHandle) -> Result<ProfilePreferences, String> {
    persist_avatar(app, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgb, RgbImage, Rgba, RgbaImage};

    fn png_bytes(image: DynamicImage) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    fn decode_data_url(avatar: &str) -> DynamicImage {
        let (_, payload) = avatar.split_once(',').unwrap();
        image::load_from_memory(&STANDARD.decode(payload).unwrap()).unwrap()
    }

    #[test]
    fn centered_square_crop_upscales_and_encodes_opaque_as_jpeg() {
        let source = RgbImage::from_fn(12, 4, |x, _| {
            Rgb(match x {
                0..4 => [255, 0, 0],
                4..8 => [0, 255, 0],
                _ => [0, 0, 255],
            })
        });
        let avatar = encode_avatar(&png_bytes(DynamicImage::ImageRgb8(source))).unwrap();
        assert!(avatar.starts_with("data:image/jpeg;base64,"));
        assert_eq!(
            normalize_profile_avatar(Some(avatar.clone())),
            Some(avatar.clone())
        );
        let decoded = decode_data_url(&avatar);
        assert_eq!(decoded.dimensions(), (256, 256));
        for x in [0, 128, 255] {
            let pixel = decoded.get_pixel(x, 128);
            assert!(pixel[0] < 10 && pixel[1] > 245 && pixel[2] < 10);
        }
    }

    #[test]
    fn transparency_is_preserved_with_lossless_webp() {
        let source = RgbaImage::from_pixel(5, 3, Rgba([30, 120, 220, 80]));
        let avatar = encode_avatar(&png_bytes(DynamicImage::ImageRgba8(source))).unwrap();
        assert!(avatar.starts_with("data:image/webp;base64,"));
        assert!(normalize_profile_avatar(Some(avatar.clone())).is_some());
        let decoded = decode_data_url(&avatar);
        assert_eq!(decoded.dimensions(), (256, 256));
        assert_eq!(decoded.get_pixel(128, 128)[3], 80);
    }

    #[test]
    fn garbage_and_empty_inputs_have_readable_errors() {
        for bytes in [b"not an image".as_slice(), b"".as_slice()] {
            assert_eq!(encode_avatar(bytes).unwrap_err(), READ_IMAGE_ERROR);
        }
    }

    #[test]
    fn source_size_limit_is_inclusive_and_oversize_is_rejected_before_decode() {
        assert!(validate_source_length(SOURCE_MAX_BYTES).is_ok());
        assert_eq!(
            encode_avatar(&vec![0; SOURCE_MAX_BYTES + 1]).unwrap_err(),
            OVERSIZE_IMAGE_ERROR
        );
    }

    #[test]
    fn decoder_rejects_dimensions_over_the_limit() {
        let source = RgbImage::from_pixel(16_385, 1, Rgb([0, 0, 0]));
        assert_eq!(
            encode_avatar(&png_bytes(DynamicImage::ImageRgb8(source))).unwrap_err(),
            READ_IMAGE_ERROR
        );
    }

    #[test]
    fn animated_gif_uses_only_the_first_frame() {
        let mut bytes = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            for color in [[255, 0, 0, 255], [0, 0, 255, 255]] {
                encoder
                    .encode_frame(image::Frame::new(RgbaImage::from_pixel(4, 4, Rgba(color))))
                    .unwrap();
            }
        }
        let decoded = decode_data_url(&encode_avatar(&bytes).unwrap());
        let pixel = decoded.get_pixel(128, 128);
        assert!(pixel[0] > 245 && pixel[2] < 10);
    }

    #[test]
    fn jpeg_exif_orientation_is_applied_before_cropping() {
        let source = RgbImage::from_fn(80, 40, |x, _| {
            Rgb(if x < 40 { [255, 0, 0] } else { [0, 0, 255] })
        });
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 95)
            .encode_image(&source)
            .unwrap();
        let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xe1];
        bytes.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        bytes.extend_from_slice(exif);
        bytes.extend_from_slice(&jpeg[2..]);
        let decoded = decode_data_url(&encode_avatar(&bytes).unwrap());
        let top = decoded.get_pixel(128, 32);
        let bottom = decoded.get_pixel(128, 224);
        assert!(top[0] > 200 && top[2] < 40);
        assert!(bottom[2] > 200 && bottom[0] < 40);
    }
}
