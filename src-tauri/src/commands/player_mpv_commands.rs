//! Webview-facing mpv surface behind allowlists — the plugin's raw IPC would let any
//! in-webview script issue the full mpv command language (`run`/`subprocess`,
//! `loadfile` of arbitrary targets, `screenshot-to-file` writes) and unconstrained
//! init options. These commands expose only the verbs/properties the player UI uses.

use super::config_store::{
    normalize_subtitle_delay, normalize_subtitle_pos, normalize_subtitle_scale, PLAYER_SPEED_MAX,
    PLAYER_SPEED_MIN, PLAYER_VOLUME_MAX,
};
use super::history_helpers::is_near_completion_watch_progress;
use super::language::build_mpv_language_selection_options;
use super::streaming_helpers::parse_playback_url;
use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, LazyLock};
use tauri::{command, AppHandle, Window};
use tauri_plugin_libmpv::{MpvConfig, MpvExt, VideoMarginRatio};

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

/// Properties writable via `set_property` or the `set` verb.
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
    "sub-visibility",
    "http-header-fields",
];

/// Properties the `cycle` verb may toggle; it carries no value, so numeric
/// bounds cannot be enforced for anything else.
const MPV_CYCLE_PROPERTIES: &[&str] = &["aid", "pause", "sub"];

/// Properties readable via `get_property`.
const MPV_READABLE_PROPERTIES: &[&str] = &[
    "time-pos",
    "demuxer-cache-duration",
    "track-list/count",
    "current-tracks/audio/id",
    "current-tracks/sub/id",
];

/// `get_property` formats the wrapper accepts.
const MPV_PROPERTY_FORMATS: &[&str] = &["flag", "int64", "double", "string", "none", "native"];

const MPV_COMMAND_MAX_ARGS: usize = 8;
const MPV_ARG_MAX_CHARS: usize = 4096;
static MPV_OP_GATE: LazyLock<Arc<tokio::sync::Mutex<()>>> =
    LazyLock::new(|| Arc::new(tokio::sync::Mutex::new(())));

pub(crate) async fn run_mpv_op<T, F>(label: &'static str, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let deadline = tokio::time::Instant::now() + super::BLOCKING_OP_TIMEOUT;
    let permit = tokio::time::timeout_at(deadline, Arc::clone(&MPV_OP_GATE).lock_owned())
        .await
        .map_err(|_| format!("mpv {label} timed out."))?;
    let mut task = tauri::async_runtime::spawn_blocking(move || {
        // A wedged native call retains the gate: later requests wait without
        // occupying more blocking threads, even after the caller times out.
        let _permit = permit;
        operation()
    });
    match tokio::time::timeout_at(deadline, &mut task).await {
        Ok(result) => result.map_err(|error| format!("mpv {label} failed: {error}"))?,
        Err(_) => {
            // Cancel queued work; running native work still owns the plugin
            // mutex until it finishes, just as with the bounded store path.
            task.abort();
            Err(format!("mpv {label} timed out."))
        }
    }
}

fn validate_video_margins(ratio: &VideoMarginRatio) -> Result<(), String> {
    if [ratio.left, ratio.right, ratio.top, ratio.bottom]
        .into_iter()
        .flatten()
        .any(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
    {
        return Err("mpv video margins must be finite ratios between 0 and 1".to_string());
    }
    Ok(())
}

#[command]
pub async fn player_mpv_destroy(app: AppHandle, window: Window) -> Result<(), String> {
    run_mpv_op("destroy", move || {
        app.mpv()
            .destroy(window.label())
            .map_err(|error| format!("mpv destroy failed: {error}"))
    })
    .await
}

#[command]
pub async fn player_mpv_set_video_margin_ratio(
    app: AppHandle,
    window: Window,
    ratio: VideoMarginRatio,
) -> Result<(), String> {
    validate_video_margins(&ratio)?;
    run_mpv_op("video margins", move || {
        app.mpv()
            .set_video_margin_ratio(ratio, window.label())
            .map_err(|error| format!("mpv video margins failed: {error}"))
    })
    .await
}

/// Every option must be verified against the bundled mpv build — the wrapper DLL
/// wedges instead of erroring on unknown options. Only verified names are safe to add.
fn build_player_mpv_config(
    initial_volume: f64,
    initial_muted: bool,
    start_paused: bool,
    preferred_audio_language: Option<&str>,
    preferred_subtitle_language: Option<&str>,
) -> MpvConfig {
    let mut config = MpvConfig {
        initial_options: [
            ("vo", "gpu-next"),
            ("hwdec", "auto-safe"),
            ("gpu-api", "d3d11"),
            ("gpu-context", "d3d11"),
            ("keep-open", "yes"),
            ("osc", "no"),
            ("osd-level", "0"),
            ("input-default-bindings", "no"),
            ("input-builtin-bindings", "no"),
            ("load-scripts", "no"),
            ("load-stats-overlay", "no"),
            ("load-console", "no"),
            ("load-commands", "no"),
            ("load-select", "no"),
            ("load-positioning", "no"),
            ("load-context-menu", "no"),
            ("load-auto-profiles", "no"),
            ("resume-playback", "no"),
            ("save-position-on-quit", "no"),
            ("ytdl", "no"),
            ("msg-level", "all=warn"),
            ("cache", "auto"),
            ("demuxer-max-bytes", "96MiB"),
            ("demuxer-max-back-bytes", "24MiB"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), Value::String(value.to_string())))
        .collect(),
        // Per-frame position/cache events stay off; the lifecycle polls them.
        observed_properties: [
            ("pause", "flag"),
            ("duration", "double"),
            ("volume", "double"),
            ("mute", "flag"),
            ("eof-reached", "flag"),
            ("idle-active", "flag"),
            ("speed", "double"),
            ("core-idle", "flag"),
            ("paused-for-cache", "flag"),
            ("current-tracks/audio/id", "int64"),
            ("current-tracks/sub/id", "int64"),
        ]
        .into_iter()
        .map(|(name, format)| (name.to_string(), format.to_string()))
        .collect(),
    };
    // Webview input: a non-finite or out-of-range level would fail init outright.
    let initial_volume = if initial_volume.is_finite() {
        initial_volume.clamp(0.0, 100.0)
    } else {
        100.0
    };
    config.initial_options.insert(
        "volume".to_string(),
        Value::String(initial_volume.to_string()),
    );
    config.initial_options.insert(
        "mute".to_string(),
        Value::String(if initial_muted { "yes" } else { "no" }.to_string()),
    );
    config.initial_options.insert(
        "pause".to_string(),
        Value::String(if start_paused { "yes" } else { "no" }.to_string()),
    );
    config
        .initial_options
        .insert("cache-secs".to_string(), Value::from(12));
    config.initial_options.extend(
        build_mpv_language_selection_options(preferred_audio_language, preferred_subtitle_language)
            .into_iter()
            .map(|(key, value)| (key, Value::String(value))),
    );
    config
}

fn is_scalar_arg(value: &Value) -> bool {
    match value {
        Value::Bool(_) | Value::Number(_) => true,
        Value::String(text) => text.len() <= MPV_ARG_MAX_CHARS,
        _ => false,
    }
}

fn is_mpv_property_value(name: &str, value: &Value) -> bool {
    if matches!(name, "volume" | "speed") {
        let number = match value {
            Value::Number(number) => number.as_f64(),
            Value::String(text) if text.len() <= MPV_ARG_MAX_CHARS => text.parse::<f64>().ok(),
            _ => None,
        };
        return number.is_some_and(|number| {
            number.is_finite()
                && if name == "volume" {
                    (0.0..=f64::from(PLAYER_VOLUME_MAX)).contains(&number)
                } else {
                    (PLAYER_SPEED_MIN..=PLAYER_SPEED_MAX).contains(&number)
                }
        });
    }
    if name == "http-header-fields" {
        // mpv escaping can double the bounded addon header blob's byte length.
        return value.as_str().is_some_and(|text| {
            text.len() <= 2 * crate::providers::addons::MAX_PROXY_HEADERS_BYTES
                && !text.contains(['\r', '\n'])
        });
    }
    is_scalar_arg(value)
}

fn validate_mpv_command(name: &str, args: &[Value]) -> Result<(), String> {
    if !MPV_COMMANDS.contains(&name) {
        return Err(format!("mpv command '{name}' is not allowed"));
    }
    let first = args.first().and_then(Value::as_str);
    if args.len() > MPV_COMMAND_MAX_ARGS
        || args.iter().enumerate().any(|(index, arg)| {
            if index == 0 && name == "loadfile" {
                !arg.is_string()
            } else if index == 1 && matches!(name, "set" | "cycle") {
                !is_mpv_property_value(first.unwrap_or_default(), arg)
            } else {
                !is_scalar_arg(arg)
            }
        })
    {
        return Err(format!(
            "mpv command '{name}' received unsupported arguments"
        ));
    }

    // Verbs whose first argument is a load target or property name need the
    // tighter checks; the rest take bounded scalars only.
    match name {
        "loadfile"
            if !matches!(args.len(), 1 | 2)
                || args
                    .get(1)
                    .is_some_and(|mode| mode.as_str() != Some("replace"))
                || first.and_then(parse_playback_url).is_none() =>
        {
            Err("mpv 'loadfile' requires an http(s) URL and optional 'replace' mode".to_string())
        }
        "sub-add"
            if !first.is_some_and(crate::providers::addon_resource::is_fetchable_http_url) =>
        {
            Err("mpv 'sub-add' requires a subtitle URL allowed by fetch policy".to_string())
        }
        "set" if !first.is_some_and(|p| MPV_SETTABLE_PROPERTIES.contains(&p)) => {
            Err(format!("mpv '{name}' property is not allowed"))
        }
        "cycle" if !first.is_some_and(|p| MPV_CYCLE_PROPERTIES.contains(&p)) => {
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
    mut args: Vec<Value>,
) -> Result<(), String> {
    validate_mpv_command(&name, &args)?;
    if name == "set" {
        let [property, value, ..] = args.as_mut_slice() else {
            return Err("mpv 'set' requires a property and value".to_string());
        };
        normalize_mpv_subtitle_property(property.as_str().unwrap_or_default(), value);
    }
    run_mpv_op("command", move || {
        app.mpv()
            .command(&name, &args, window.label())
            .map_err(|error| format!("mpv command '{name}' failed: {error}"))
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvSetError {
    message: String,
    subtitle_properties: Vec<(String, Value)>,
}

#[command]
pub async fn player_mpv_set_property(
    app: AppHandle,
    window: Window,
    name: String,
    value: Value,
) -> Result<Vec<(String, Value)>, MpvSetError> {
    player_mpv_set_properties(app, window, vec![(name, value)]).await
}

fn normalize_mpv_subtitle_property(name: &str, value: &mut Value) -> bool {
    let normalize = match name {
        "sub-delay" => normalize_subtitle_delay,
        "sub-pos" => normalize_subtitle_pos,
        "sub-scale" => normalize_subtitle_scale,
        _ => return false,
    };
    let number = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()));
    *value = Value::from(normalize(number));
    true
}

fn normalize_mpv_subtitle_properties(properties: &mut [(String, Value)]) -> Vec<(String, Value)> {
    let mut normalized = Vec::new();
    for (name, value) in properties {
        if normalize_mpv_subtitle_property(name, value) {
            normalized.push((name.clone(), value.clone()));
        }
    }
    normalized
}

fn validate_mpv_properties(properties: &[(String, Value)]) -> Result<(), String> {
    if properties.len() > MPV_SETTABLE_PROPERTIES.len() {
        return Err("mpv property batch is too large".to_string());
    }
    for (name, value) in properties {
        if !MPV_SETTABLE_PROPERTIES.contains(&name.as_str()) {
            return Err(format!("mpv property '{name}' is not writable"));
        }
        if !is_mpv_property_value(name, value) {
            return Err(format!(
                "mpv property '{name}' received an unsupported value"
            ));
        }
    }
    Ok(())
}

fn apply_mpv_properties(
    properties: &[(String, Value)],
    mut set_property: impl FnMut(&str, &Value) -> Result<(), String>,
) -> Result<(), String> {
    let mut first_error = None;
    // Independent display writes still run when one property is unsupported.
    for (name, value) in properties {
        let result = set_property(name, value);
        if first_error.is_none() {
            first_error = result.err();
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[command]
pub async fn player_mpv_set_properties(
    app: AppHandle,
    window: Window,
    mut properties: Vec<(String, Value)>,
) -> Result<Vec<(String, Value)>, MpvSetError> {
    validate_mpv_properties(&properties).map_err(|message| MpvSetError {
        message,
        subtitle_properties: Vec::new(),
    })?;
    let subtitle_properties = normalize_mpv_subtitle_properties(&mut properties);
    let result = run_mpv_op("set", move || {
        apply_mpv_properties(&properties, |name, value| {
            app.mpv()
                .set_property(name, value, window.label())
                .or_else(|_| {
                    // Some mpv builds reject set_property; keep compatibility inside
                    // the validated native command rather than retrying over IPC.
                    let text = value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string());
                    app.mpv().command(
                        "set",
                        &vec![Value::String(name.to_string()), Value::String(text)],
                        window.label(),
                    )
                })
                .map_err(|error| format!("mpv set '{name}' failed: {error}"))
        })
    })
    .await;
    match result {
        Ok(()) => Ok(subtitle_properties),
        Err(message) => Err(MpvSetError {
            message,
            subtitle_properties,
        }),
    }
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
    run_mpv_op("get", move || {
        app.mpv()
            .get_property(name, format, window.label())
            .map_err(|error| format!("mpv get failed: {error}"))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackPositionProbe {
    time_pos: Option<f64>,
    buffered_ahead: Option<f64>,
    near_completion: bool,
}

fn read_playback_position(
    duration_secs: f64,
    get_property: impl Fn(&str) -> Option<Value>,
) -> PlaybackPositionProbe {
    let time_pos = get_property("time-pos").and_then(|value| value.as_f64());
    PlaybackPositionProbe {
        time_pos,
        buffered_ahead: get_property("demuxer-cache-duration").and_then(|value| value.as_f64()),
        near_completion: time_pos
            .is_some_and(|position| is_near_completion_watch_progress(position, duration_secs)),
    }
}

#[command]
pub async fn player_mpv_get_playback_position(
    app: AppHandle,
    window: Window,
    duration_secs: f64,
) -> Result<PlaybackPositionProbe, String> {
    // One IPC per poll; synchronous native reads stay off the async executor.
    // A timeout releases IPC; an already-running native call cannot be stopped.
    run_mpv_op("position probe", move || {
        Ok(read_playback_position(duration_secs, |name| {
            app.mpv()
                .get_property(name.to_string(), "double".to_string(), window.label())
                .ok()
        }))
    })
    .await
}

#[command]
pub async fn player_mpv_init(
    app: AppHandle,
    window: Window,
    initial_volume: f64,
    initial_muted: bool,
    start_paused: bool,
    preferred_audio_language: Option<String>,
    preferred_subtitle_language: Option<String>,
) -> Result<String, String> {
    let mpv_config = build_player_mpv_config(
        initial_volume,
        initial_muted,
        start_paused,
        preferred_audio_language.as_deref(),
        preferred_subtitle_language.as_deref(),
    );
    run_mpv_op("init", move || {
        app.mpv()
            .init(mpv_config, window.label())
            .map_err(|error| format!("mpv init failed: {error}"))
    })
    .await
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[test]
fn numeric_property_ranges_apply_to_batches_and_set_commands() {
    for (name, valid, invalid) in [
        ("volume", [0.0, 75.5, 100.0], [-0.01, 100.01]),
        ("speed", [0.25, 1.0, 4.0], [0.24, 4.01]),
    ] {
        for number in valid {
            for value in [Value::from(number), Value::String(number.to_string())] {
                assert!(validate_mpv_properties(&[(name.to_string(), value.clone())]).is_ok());
                assert!(validate_mpv_command("set", &[Value::from(name), value]).is_ok());
            }
        }
        let invalid_values = invalid
            .into_iter()
            .flat_map(|number| [Value::from(number), Value::String(number.to_string())])
            .chain(["NaN", "inf", "-inf", "1e999", "yes", ""].map(Value::from))
            .chain([Value::Bool(true), Value::Null]);
        for value in invalid_values {
            assert!(validate_mpv_properties(&[(name.to_string(), value.clone())]).is_err());
            assert!(validate_mpv_command("set", &[Value::from(name), value]).is_err());
        }
    }
}
