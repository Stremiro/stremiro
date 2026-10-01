//! Webview-facing mpv surface behind allowlists. The plugin's raw IPC would
//! let any in-webview script issue the full mpv command language (`run`/`subprocess`,
//! `screenshot`/`screenshot-to-file` file writes, `loadfile` of arbitrary targets) and init mpv with
//! unconstrained options (`script`, `include`, `wid`). These commands expose
//! only the verbs, properties, and init-option keys the player UI uses;
//! destroy and video-margin stay on the plugin's permissions since they
//! carry no OS-level surface.

use serde::Serialize;
use serde_json::Value;
use tauri::{command, AppHandle, Window};
use tauri_plugin_libmpv::{MpvConfig, MpvExt};

/// mpv verbs the UI is allowed to issue.
const MPV_COMMANDS: &[&str] = &[
    "cycle",
    "frame-back-step",
    "frame-step",
    "loadfile",
    "seek",
    "set",
    "sub-add",
];

/// Properties writable via `set_property` or the `set`/`cycle` verbs.
const MPV_SETTABLE_PROPERTIES: &[&str] = &[
    "aid",
    "sid",
    "sub",
    "pause",
    "volume",
    "mute",
    "speed",
    "sub-delay",
    "sub-pos",
    "sub-scale",
    "http-header-fields",
];

/// Properties readable via `get_property`.
const MPV_READABLE_PROPERTIES: &[&str] = &[
    "time-pos",
    "demuxer-cache-time",
    "track-list/count",
    "current-tracks/audio/id",
    "current-tracks/sub/id",
];

/// `get_property` formats the wrapper accepts.
const MPV_PROPERTY_FORMATS: &[&str] = &["flag", "int64", "double", "string", "none", "native"];

/// `initial_options` keys accepted at init — the set `buildPlayerMpvConfig`
/// emits (player, cache, and language-selection options). An allowlist, not a
/// denylist: `script`, `include`, or a caller-supplied `wid` must never cross
/// from the webview.
const MPV_INIT_OPTION_KEYS: &[&str] = &[
    "vo",
    "hwdec",
    "gpu-api",
    "gpu-context",
    "keep-open",
    "volume",
    "pause",
    "osc",
    "osd-level",
    "input-default-bindings",
    "input-builtin-bindings",
    "load-scripts",
    "load-stats-overlay",
    "load-console",
    "load-commands",
    "load-select",
    "load-positioning",
    "load-context-menu",
    "load-auto-profiles",
    "resume-playback",
    "save-position-on-quit",
    "ytdl",
    "msg-level",
    "cache",
    "cache-secs",
    "demuxer-max-bytes",
    "demuxer-max-back-bytes",
    "track-auto-selection",
    "aid",
    "alang",
    "sid",
    "slang",
    "subs-fallback",
];

const MPV_COMMAND_MAX_ARGS: usize = 8;
const MPV_ARG_MAX_CHARS: usize = 4096;
const MPV_OBSERVED_PROPERTIES_MAX: usize = 64;

fn is_scalar_arg(value: &Value) -> bool {
    match value {
        Value::Bool(_) | Value::Number(_) => true,
        Value::String(text) => text.len() <= MPV_ARG_MAX_CHARS,
        _ => false,
    }
}

fn is_http_url(value: Option<&str>) -> bool {
    value.is_some_and(|url| url.starts_with("https://") || url.starts_with("http://"))
}

fn validate_mpv_command(name: &str, args: &[Value]) -> Result<(), String> {
    if !MPV_COMMANDS.contains(&name) {
        return Err(format!("mpv command '{name}' is not allowed"));
    }
    if args.len() > MPV_COMMAND_MAX_ARGS || args.iter().any(|arg| !is_scalar_arg(arg)) {
        return Err(format!(
            "mpv command '{name}' received unsupported arguments"
        ));
    }

    // Verbs whose first argument is a load target or property name need the
    // tighter checks; the rest take bounded scalars only.
    let first = args.first().and_then(Value::as_str);
    match name {
        "loadfile" | "sub-add" if !is_http_url(first) => {
            Err(format!("mpv '{name}' requires an http(s) url"))
        }
        "set" | "cycle" if !first.is_some_and(|p| MPV_SETTABLE_PROPERTIES.contains(&p)) => {
            Err(format!("mpv '{name}' property is not allowed"))
        }
        _ => Ok(()),
    }
}

#[command]
pub async fn player_mpv_command(
    app: AppHandle,
    window: Window,
    name: String,
    args: Vec<Value>,
) -> Result<(), String> {
    validate_mpv_command(&name, &args)?;
    if name == "set" && args.len() < 2 {
        return Err("mpv 'set' requires a property and value".to_string());
    }
    app.mpv()
        .command(&name, &args, window.label())
        .map_err(|error| format!("mpv command '{name}' failed: {error}"))
}

#[command]
pub async fn player_mpv_set_property(
    app: AppHandle,
    window: Window,
    name: String,
    value: Value,
) -> Result<(), String> {
    if !MPV_SETTABLE_PROPERTIES.contains(&name.as_str()) {
        return Err(format!("mpv property '{name}' is not writable"));
    }
    if !is_scalar_arg(&value) {
        return Err(format!(
            "mpv property '{name}' received an unsupported value"
        ));
    }
    app.mpv()
        .set_property(&name, &value, window.label())
        .map_err(|error| format!("mpv set '{name}' failed: {error}"))
}

#[command]
pub async fn player_mpv_get_property(
    app: AppHandle,
    window: Window,
    name: String,
    format: String,
) -> Result<Value, String> {
    if !MPV_READABLE_PROPERTIES.contains(&name.as_str())
        || !MPV_PROPERTY_FORMATS.contains(&format.as_str())
    {
        return Err(format!("mpv property '{name}' is not readable"));
    }
    app.mpv()
        .get_property(name, format, window.label())
        .map_err(|error| format!("mpv get failed: {error}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackPositionProbe {
    time_pos: Option<f64>,
    buffered_ahead: Option<f64>,
}

fn read_playback_position(get_property: impl Fn(&str) -> Option<Value>) -> PlaybackPositionProbe {
    PlaybackPositionProbe {
        time_pos: get_property("time-pos").and_then(|value| value.as_f64()),
        buffered_ahead: get_property("demuxer-cache-time").and_then(|value| value.as_f64()),
    }
}

#[command]
pub async fn player_mpv_get_playback_position(
    app: AppHandle,
    window: Window,
) -> Result<PlaybackPositionProbe, String> {
    // One IPC per poll; synchronous native reads stay off the async executor.
    // The timeout keeps a wedged plugin from pinning this polling IPC (and a
    // blocking-pool thread) forever.
    tokio::time::timeout(
        super::BLOCKING_OP_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || {
            read_playback_position(|name| {
                app.mpv()
                    .get_property(name.to_string(), "double".to_string(), window.label())
                    .ok()
            })
        }),
    )
    .await
    .map_err(|_| "mpv position probe timed out.".to_string())?
    .map_err(|error| format!("mpv position probe failed: {error}"))
}

#[command]
pub async fn player_mpv_init(
    app: AppHandle,
    window: Window,
    mpv_config: MpvConfig,
) -> Result<String, String> {
    if let Some(key) = mpv_config
        .initial_options
        .keys()
        .find(|key| !MPV_INIT_OPTION_KEYS.contains(&key.as_str()))
    {
        return Err(format!("mpv init option '{key}' is not allowed"));
    }
    if mpv_config
        .initial_options
        .values()
        .any(|value| !is_scalar_arg(value))
    {
        return Err("mpv init options must be scalar values".to_string());
    }
    if mpv_config.observed_properties.len() > MPV_OBSERVED_PROPERTIES_MAX
        || mpv_config.observed_properties.iter().any(|(name, format)| {
            name.len() > 256 || !MPV_PROPERTY_FORMATS.contains(&format.as_str())
        })
    {
        return Err("mpv observed properties are not allowed".to_string());
    }
    app.mpv()
        .init(mpv_config, window.label())
        .map_err(|error| format!("mpv init failed: {error}"))
}

#[cfg(test)]
mod tests;
