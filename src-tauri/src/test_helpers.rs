//! Shared `#[cfg(test)]` fixtures with canonical defaults.
//! Tests override only the fields they assert on via struct
//! update syntax (`AddonStream { url: ..., ..test_stream() }`).

use crate::commands::config_store::AddonConfig;
use crate::commands::WatchProgress;
use crate::providers::addon_manifest::{parse_addon_manifest, AddonManifest};
use crate::providers::addons::AddonStream;
use crate::providers::{Episode, MediaDetails, MediaItem};

/// Canonical Cinemeta endpoint — the pinned default browsing addon.
pub(crate) const CINEMETA_URL: &str = "https://v3-cinemeta.strem.io";

pub(crate) fn test_stream() -> AddonStream {
    AddonStream::default()
}

pub(crate) fn test_progress() -> WatchProgress {
    WatchProgress {
        id: "tt123".to_string(),
        type_: "movie".to_string(),
        title: "Test".to_string(),
        ..WatchProgress::default()
    }
}

/// Generic addon config: `url` follows the `{id}/manifest.json` convention
/// stream-fetch tests rely on. Tests needing a specific URL override it via
/// struct update.
pub(crate) fn test_addon(id: &str, name: &str) -> AddonConfig {
    AddonConfig {
        id: id.to_string(),
        url: format!("{id}/manifest.json"),
        name: name.to_string(),
        enabled: true,
        capabilities: None,
    }
}

pub(crate) fn test_media_item(id: &str, type_: &str) -> MediaItem {
    MediaItem {
        id: id.to_string(),
        title: id.to_string(),
        type_: type_.to_string(),
        ..MediaItem::default()
    }
}

pub(crate) fn test_details(id: &str, type_: &str) -> MediaDetails {
    MediaDetails {
        id: id.to_string(),
        type_: type_.to_string(),
        ..MediaDetails::default()
    }
}

pub(crate) fn test_episode(id: &str, season: u32, episode: u32) -> Episode {
    Episode {
        id: id.to_string(),
        season,
        episode,
        ..Episode::default()
    }
}

/// Isolated durable store fixture; never touches the application's user data.
pub(crate) struct TestStore {
    pub store: crate::commands::DurableStore,
    pub path: std::path::PathBuf,
}

pub(crate) fn test_store() -> TestStore {
    let path = std::env::temp_dir().join(format!("stremiro-bulk-{}.json", uuid::Uuid::new_v4()));
    let store = crate::commands::DurableStoreRegistry::default()
        .open_path(path.clone())
        .expect("open isolated store");
    TestStore { store, path }
}

impl Drop for TestStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Ordered loopback responses; keep recording requests after the script runs out.
/// One scripted response: status, body, arbitrary headers.
pub(crate) type ScriptedResponse = (u16, &'static str, Vec<(&'static str, &'static str)>);

pub(crate) struct TestHttpServer {
    pub url: String,
    stop: std::sync::mpsc::Sender<()>,
    server: Option<std::thread::JoinHandle<Vec<String>>>,
}

impl TestHttpServer {
    pub(crate) fn new(responses: Vec<(u16, &'static str, Option<&'static str>)>) -> Self {
        Self::with_headers(
            responses
                .into_iter()
                .map(|(status, body, location)| {
                    (
                        status,
                        body,
                        location
                            .map(|url| vec![("Location", url)])
                            .unwrap_or_default(),
                    )
                })
                .collect(),
        )
    }

    /// Same ordered script with arbitrary response headers (Location included).
    pub(crate) fn with_headers(responses: Vec<ScriptedResponse>) -> Self {
        use std::io::{BufRead, BufReader, Write};
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let (stop, stopped) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut paths = Vec::new();
            let started = Instant::now();
            while matches!(stopped.try_recv(), Err(mpsc::TryRecvError::Empty))
                && started.elapsed() < Duration::from_secs(10)
            {
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut line = String::new();
                let mut reader = BufReader::new(&mut socket);
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                        break;
                    }
                }
                let (status, body, headers) =
                    responses
                        .get(paths.len())
                        .cloned()
                        .unwrap_or((404, "{}", Vec::new()));
                paths.push(line.split_whitespace().nth(1).unwrap_or("/").to_string());
                let headers = headers
                    .iter()
                    .map(|(name, value)| format!("{name}: {value}\r\n"))
                    .collect::<String>();
                write!(
                    socket,
                    "HTTP/1.1 {status} Test\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
            paths
        });
        Self {
            url,
            stop,
            server: Some(server),
        }
    }

    pub(crate) fn finish(mut self) -> Vec<String> {
        let _ = self.stop.send(());
        self.server.take().unwrap().join().unwrap()
    }
}

impl Drop for TestHttpServer {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(server) = self.server.take() {
            let _ = server.join();
        }
    }
}

/// Canonical Cinemeta-shaped manifest: `catalog` + `meta` resources with the
/// `top` (search/genre/skip extras) and `imdbRating` movie catalogs. Single
/// source so parse, URL-build, and registry tests cannot drift apart. The
/// deliberately-maximal manifest-parse edge cases stay inline in
/// `addon_manifest/tests.rs`.
pub(crate) fn cinemeta_manifest_json() -> &'static str {
    r#"{
        "name": "Cinemeta",
        "resources": ["catalog", "meta"],
        "types": ["movie", "series"],
        "idPrefixes": ["tt"],
        "catalogs": [
            {
                "type": "movie",
                "id": "top",
                "name": "Popular",
                "extra": [
                    {"name": "genre", "options": ["Action", "Animation"]},
                    {"name": "search"},
                    {"name": "skip"}
                ]
            },
            {
                "type": "movie",
                "id": "imdbRating",
                "name": "Featured",
                "extra": [
                    {"name": "genre"},
                    {"name": "skip"}
                ]
            }
        ]
    }"#
}

pub(crate) fn cinemeta_manifest() -> AddonManifest {
    parse_addon_manifest(cinemeta_manifest_json().as_bytes()).expect("valid Cinemeta fixture")
}

/// Stored Cinemeta config before capability classification.
pub(crate) fn cinemeta_addon() -> AddonConfig {
    AddonConfig {
        id: CINEMETA_URL.to_string(),
        url: CINEMETA_URL.to_string(),
        name: "Cinemeta".to_string(),
        enabled: true,
        capabilities: None,
    }
}

/// Cinemeta config carrying the canonical manifest capability snapshot.
pub(crate) fn classified_cinemeta_addon() -> AddonConfig {
    AddonConfig {
        capabilities: Some(cinemeta_manifest()),
        ..cinemeta_addon()
    }
}
