//! `stremiro://` links arrive from argv, browsers, and chat pastes, so every link is untrusted.
//! A link can only open a details page or prefill the addon add box; adding stays a user click.

use super::config_commands::MAX_ADDON_URL_INPUT_CHARS;
use super::config_store::{normalize_addon_url, strip_ascii_prefix_ignore_case};
use crate::providers::fetch_policy::is_blocked_ip_literal;
use serde::Serialize;

pub(super) const APP_LINK_SCHEME: &str = "stremiro://";
const TITLE_LINK_PREFIX: &str = "details/";
/// Suffixes that resolve on the local network: the add box probes the manifest as soon as it is
/// prefilled, so a link must not aim that request at a router or NAS.
const LOCAL_NETWORK_SUFFIXES: [&str; 6] = ["localhost", "local", "lan", "internal", "home", "arpa"];

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum AppLink {
    Addon {
        url: String,
    },
    Title {
        #[serde(rename = "mediaType")]
        media_type: &'static str,
        #[serde(rename = "mediaId")]
        media_id: String,
        /// Episode links land on this season/episode of a series details page.
        #[serde(skip_serializing_if = "Option::is_none")]
        season: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        episode: Option<u32>,
    },
}

pub(crate) fn parse_app_link(input: &str) -> Option<AppLink> {
    let link = input.trim();
    if link.len() > MAX_ADDON_URL_INPUT_CHARS
        || link
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return None;
    }
    let rest = strip_ascii_prefix_ignore_case(link, APP_LINK_SCHEME)?;
    match strip_ascii_prefix_ignore_case(rest, TITLE_LINK_PREFIX) {
        Some(path) => parse_title_link(path),
        None => parse_addon_link(link),
    }
}

/// The first `stremiro://` argument; the OS passes the link as one argv entry.
pub(crate) fn find_app_link(args: impl IntoIterator<Item = String>) -> Option<AppLink> {
    args.into_iter()
        .find(|arg| strip_ascii_prefix_ignore_case(arg.trim(), APP_LINK_SCHEME).is_some())
        .and_then(|arg| parse_app_link(&arg))
}

fn parse_title_link(path: &str) -> Option<AppLink> {
    // Browsers may append a trailing slash when handing the link to the OS.
    let path = path.strip_suffix('/').unwrap_or(path);
    let mut segments = path.split('/');
    let (media_type, encoded_id) = (segments.next()?, segments.next()?);
    let coordinates = match (segments.next(), segments.next(), segments.next()) {
        (None, ..) => None,
        (Some(season), Some(episode), None) => Some((
            parse_link_coordinate(season)?,
            parse_link_coordinate(episode)?,
        )),
        _ => return None,
    };
    if encoded_id.contains(['?', '#']) {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(encoded_id)
        .decode_utf8()
        .ok()?;
    if decoded.chars().any(char::is_control) {
        return None;
    }
    let media_id = super::normalize_media_id(&decoded)?;
    let media_type = super::normalize_stream_media_type(media_type, Some(&media_id))?;
    if coordinates.is_some() && media_type == "movie" {
        return None;
    }
    Some(AppLink::Title {
        media_type,
        media_id,
        season: coordinates.map(|(season, _)| season),
        episode: coordinates.map(|(_, episode)| episode),
    })
}

/// Plain decimal digits only: signs, spaces and encodings are rejected rather than normalized.
fn parse_link_coordinate(segment: &str) -> Option<u32> {
    if segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    segment.parse().ok()
}

fn parse_addon_link(link: &str) -> Option<AppLink> {
    let url = normalize_addon_url(link).ok().flatten()?;
    let parsed = reqwest::Url::parse(&url).ok()?;
    (parsed.scheme() == "https" && parsed.host_str().is_some_and(is_public_host))
        .then_some(AppLink::Addon { url })
}

fn is_public_host(host: &str) -> bool {
    if is_blocked_ip_literal(host) {
        return false;
    }
    if host.starts_with('[') {
        return true;
    }
    host.trim_end_matches('.')
        .rsplit_once('.')
        .is_some_and(|(_, suffix)| {
            !LOCAL_NETWORK_SUFFIXES
                .iter()
                .any(|local| suffix.eq_ignore_ascii_case(local))
        })
}

/// `stremiro://` form of a stored addon URL, or `None` when the link would not open the same
/// addon (plain http, local hosts, oversized URLs); callers then share the plain URL.
pub(crate) fn addon_share_link(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let (location, query) = match rest.split_once('?') {
        Some((location, query)) => (location, Some(query)),
        None => (rest, None),
    };
    let mut link = format!(
        "{APP_LINK_SCHEME}{}/manifest.json",
        location.trim_end_matches('/')
    );
    if let Some(query) = query {
        link.push('?');
        link.push_str(query);
    }
    matches!(parse_app_link(&link), Some(AppLink::Addon { url: parsed }) if parsed == url)
        .then_some(link)
}

#[tauri::command]
pub(crate) fn resolve_app_link(link: String) -> Option<AppLink> {
    parse_app_link(&link)
}

#[cfg(test)]
mod tests {
    use super::super::config_store::LEGACY_INSTALL_SCHEME;
    use super::*;

    fn addon(url: &str) -> Option<AppLink> {
        Some(AppLink::Addon {
            url: url.to_string(),
        })
    }

    fn title(media_type: &'static str, media_id: &str) -> Option<AppLink> {
        Some(AppLink::Title {
            media_type,
            media_id: media_id.to_string(),
            season: None,
            episode: None,
        })
    }

    fn episode(media_type: &'static str, media_id: &str, season: u32, episode: u32) -> AppLink {
        AppLink::Title {
            media_type,
            media_id: media_id.to_string(),
            season: Some(season),
            episode: Some(episode),
        }
    }

    #[test]
    fn addon_links_open_public_https_addons_only() {
        assert_eq!(
            parse_app_link("STREMIRO://addon.example/abc/manifest.json"),
            addon("https://addon.example/abc")
        );
        assert_eq!(
            parse_app_link("stremiro://https://user:pass@addon.example/manifest.json#x"),
            addon("https://addon.example")
        );
        for rejected in [
            "stremiro://http://addon.example/manifest.json",
            "stremiro://http://127.0.0.1:7000/manifest.json",
            "stremiro://127.0.0.1:7000/manifest.json",
            "stremiro://192.168.1.10/manifest.json",
            "stremiro://[::1]/manifest.json",
            "stremiro://2130706433/manifest.json",
            "stremiro://localhost/manifest.json",
            "stremiro://nas/manifest.json",
            "stremiro://router.lan/manifest.json",
            "stremiro://printer.local./manifest.json",
            "stremiro://file:///C:/manifest.json",
            "stremiro://",
            &format!("{LEGACY_INSTALL_SCHEME}addon.example/manifest.json"),
            "https://addon.example/manifest.json",
            "stremiro://addon.example/a b/manifest.json",
            "stremiro://addon.example/\u{7}/manifest.json",
        ] {
            assert_eq!(parse_app_link(rejected), None, "{rejected}");
        }
        let oversized = format!("stremiro://addon.example/{}", "a".repeat(4_096));
        assert_eq!(parse_app_link(&oversized), None);
    }

    #[test]
    fn title_links_decode_and_validate_the_route() {
        assert_eq!(
            parse_app_link("stremiro://details/movie/tt0111161"),
            title("movie", "tt0111161")
        );
        assert_eq!(
            parse_app_link(" stremiro://Details/Series/tt0903747%3A1%3A2/ "),
            title("series", "tt0903747:1:2")
        );
        assert_eq!(
            parse_app_link("stremiro://details/series/kitsu%3A1"),
            title("anime", "kitsu:1")
        );
        let long_id = "a".repeat(257);
        for rejected in [
            "stremiro://details/movie",
            "stremiro://details/movie/",
            "stremiro://details/channel/tt1",
            "stremiro://details/movie/tt1/extra",
            "stremiro://details/movie/tt1?x=1",
            "stremiro://details/movie/null",
            "stremiro://details/movie/%0Att1",
            "stremiro://details/movie/%FF",
            &format!("stremiro://details/movie/{long_id}"),
        ] {
            assert_eq!(parse_app_link(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn episode_links_carry_series_coordinates_only() {
        assert_eq!(
            parse_app_link("stremiro://details/series/tt0903747/1/2"),
            Some(episode("series", "tt0903747", 1, 2))
        );
        assert_eq!(
            parse_app_link("stremiro://details/series/kitsu%3A1/0/3/"),
            Some(episode("anime", "kitsu:1", 0, 3))
        );
        assert_eq!(
            serde_json::to_value(episode("series", "tt1", 1, 2)).unwrap(),
            serde_json::json!({
                "kind": "title",
                "mediaType": "series",
                "mediaId": "tt1",
                "season": 1,
                "episode": 2,
            })
        );
        for rejected in [
            "stremiro://details/movie/tt1/1/2",
            "stremiro://details/series/tt1/1",
            "stremiro://details/series/tt1/1/x",
            "stremiro://details/series/tt1/+1/2",
            "stremiro://details/series/tt1/1/2/3",
            "stremiro://details/series/tt1/1/2?x=1",
            "stremiro://details/series/tt1/1/99999999999",
        ] {
            assert_eq!(parse_app_link(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn share_links_round_trip_or_fall_back() {
        for url in [
            "https://addon.example",
            "https://addon.example/abc%7Ctoken=1",
            "https://addon.example/abc?key=1",
            "https://addon.example/?key=1",
        ] {
            let link = addon_share_link(url).expect(url);
            assert!(link.starts_with("stremiro://addon.example/"), "{link}");
            assert_eq!(parse_app_link(&link), addon(url));
        }
        assert_eq!(
            addon_share_link("https://addon.example/abc").as_deref(),
            Some("stremiro://addon.example/abc/manifest.json")
        );
        assert_eq!(addon_share_link("http://addon.example"), None);
        assert_eq!(addon_share_link("https://127.0.0.1:7000"), None);
    }

    #[test]
    fn argv_picks_the_first_app_link() {
        let args = |values: &[&str]| {
            values
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            find_app_link(args(&["stremiro.exe", "stremiro://details/movie/tt1"])),
            title("movie", "tt1")
        );
        assert_eq!(find_app_link(args(&["stremiro.exe", "--autostart"])), None);
    }
}
