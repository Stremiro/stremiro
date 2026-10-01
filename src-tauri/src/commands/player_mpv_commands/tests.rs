use super::*;
use serde_json::json;

#[test]
fn playback_position_probe_preserves_partial_results_and_frontend_shape() {
    use std::cell::RefCell;

    for (time_pos, buffered_ahead) in [
        (Some(json!(12.5)), Some(json!(30))),
        (None, Some(json!(0))),
        (Some(json!(0)), None),
        (Some(Value::Null), Some(json!("unavailable"))),
    ] {
        let calls = RefCell::new(Vec::new());
        let probe = read_playback_position(|name| {
            calls.borrow_mut().push(name.to_string());
            match name {
                "time-pos" => time_pos.clone(),
                "demuxer-cache-time" => buffered_ahead.clone(),
                _ => panic!("unexpected native property {name}"),
            }
        });
        assert_eq!(*calls.borrow(), ["time-pos", "demuxer-cache-time"]);
        assert_eq!(
            serde_json::to_value(probe).unwrap(),
            json!({
                "timePos": time_pos.and_then(|value| value.as_f64()),
                "bufferedAhead": buffered_ahead.and_then(|value| value.as_f64()),
            })
        );
    }
}

#[test]
fn mpv_command_allowlist_admits_only_player_verbs() {
    for verb in [
        "seek",
        "cycle",
        "loadfile",
        "sub-add",
        "set",
        "frame-step",
        "frame-back-step",
    ] {
        // Property/URL checks still apply; pick args that satisfy them.
        let args = match verb {
            "loadfile" | "sub-add" => vec![json!("https://example.com/x")],
            "set" | "cycle" => vec![json!("pause")],
            _ => vec![json!("0")],
        };
        assert!(validate_mpv_command(verb, &args).is_ok(), "{verb} rejected");
    }

    for verb in [
        "run",
        "subprocess",
        "screenshot",
        "screenshot-to-file",
        "write-watch-later-config",
        "load-script",
    ] {
        assert!(
            validate_mpv_command(verb, &[json!("x")]).is_err(),
            "{verb} allowed"
        );
    }
}

#[test]
fn mpv_command_targets_are_gated() {
    // loadfile/sub-add only take http(s) — file:// and schemeless strings fail.
    assert!(validate_mpv_command("loadfile", &[json!("file:///C:/x.lua")]).is_err());
    assert!(validate_mpv_command("sub-add", &[json!("\\\\nas\\share\\s.srt")]).is_err());
    assert!(validate_mpv_command("loadfile", &[json!("magnet:?xt=urn:btih:x")]).is_err());

    // set/cycle only reach allowlisted properties (`sub` is mpv's sid alias —
    // the subtitle cycle hotkey depends on it).
    assert!(validate_mpv_command("set", &[json!("script"), json!("evil.lua")]).is_err());
    assert!(validate_mpv_command("cycle", &[json!("watch-later-directory")]).is_err());
    assert!(validate_mpv_command("set", &[json!("screenshot-directory"), json!("C:\\")]).is_err());
    assert!(validate_mpv_command("set", &[json!("volume"), json!("80")]).is_ok());
    assert!(validate_mpv_command("cycle", &[json!("sub")]).is_ok());
}

#[test]
fn mpv_command_rejects_non_scalar_or_oversized_args() {
    assert!(validate_mpv_command("seek", &[json!(["nested"])]).is_err());
    assert!(validate_mpv_command("seek", &[json!("x".repeat(MPV_ARG_MAX_CHARS + 1))]).is_err());
    let too_many = vec![json!("0"); MPV_COMMAND_MAX_ARGS + 1];
    assert!(validate_mpv_command("seek", &too_many).is_err());
}
