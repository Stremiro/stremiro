use super::*;
use serde_json::json;

#[tokio::test]
async fn cancelled_native_waiter_does_not_run_or_release_running_operation() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(run_mpv_op("running operation", move || {
        started_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        finished_tx.send(()).unwrap();
        Ok(())
    }));
    started_rx.await.unwrap();
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());

    let called = Arc::new(AtomicBool::new(false));
    let cancelled_call = Arc::clone(&called);
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(20),
        run_mpv_op("cancelled waiter", move || {
            cancelled_call.store(true, Ordering::SeqCst);
            Ok(())
        })
    )
    .await
    .is_err());
    assert!(!called.load(Ordering::SeqCst));

    release_tx.send(()).unwrap();
    finished_rx.await.unwrap();
    run_mpv_op("subsequent operation", || Ok(())).await.unwrap();
    assert!(!called.load(Ordering::SeqCst));
}

#[test]
fn video_margins_accept_only_finite_unit_ratios() {
    for value in [None, Some(0.0), Some(0.5), Some(1.0)] {
        assert!(validate_video_margins(&VideoMarginRatio {
            left: value,
            right: value,
            top: value,
            bottom: value,
        })
        .is_ok());
    }
    for value in [-0.01, 1.01, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for position in 0..4 {
            let mut sides = [None; 4];
            sides[position] = Some(value);
            assert!(validate_video_margins(&VideoMarginRatio {
                left: sides[0],
                right: sides[1],
                top: sides[2],
                bottom: sides[3],
            })
            .is_err());
        }
    }
}

#[test]
fn playback_position_probe_preserves_partial_results_and_frontend_shape() {
    use std::cell::RefCell;

    for (duration_secs, time_pos, buffered_ahead, near_completion) in [
        (120.0, Some(json!(12.5)), Some(json!(30)), false),
        (120.0, None, Some(json!(0)), false),
        (120.0, Some(json!(0)), None, false),
        (120.0, Some(Value::Null), Some(json!("unavailable")), false),
        (120.0, Some(json!(89.9)), None, false),
        (120.0, Some(json!(90)), None, true),
        (10000.0, Some(json!(9700)), None, true),
        (59.0, Some(json!(59)), None, false),
        (0.0, Some(json!(120)), None, false),
        (f64::NAN, Some(json!(120)), None, false),
    ] {
        let calls = RefCell::new(Vec::new());
        let probe = read_playback_position(duration_secs, |name| {
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
                "nearCompletion": near_completion,
            })
        );
    }
}

#[test]
fn mpv_config_keeps_native_options_and_observers_fixed() {
    for (volume, paused) in [(0.0, false), (78.5, true)] {
        let config = build_player_mpv_config(volume, paused, paused, Some("en"), Some("off"));
        for (name, value) in [
            ("volume", json!(volume.to_string())),
            ("mute", json!(if paused { "yes" } else { "no" })),
            ("pause", json!(if paused { "yes" } else { "no" })),
            ("vo", json!("gpu-next")),
            ("hwdec", json!("auto-safe")),
            ("gpu-api", json!("d3d11")),
            ("gpu-context", json!("d3d11")),
            ("cache", json!("auto")),
            ("cache-secs", json!(12)),
            ("demuxer-max-bytes", json!("96MiB")),
            ("demuxer-max-back-bytes", json!("24MiB")),
            ("load-scripts", json!("no")),
            ("resume-playback", json!("no")),
            ("save-position-on-quit", json!("no")),
            ("sid", json!("no")),
        ] {
            assert_eq!(config.initial_options.get(name), Some(&value), "{name}");
        }
        assert!(config.initial_options.contains_key("alang"));
        assert!(!config.initial_options.contains_key("wid"));
        assert_eq!(config.observed_properties.len(), 11);
        assert_eq!(config.observed_properties["duration"], "double");
        assert_eq!(
            config.observed_properties["current-tracks/audio/id"],
            "int64"
        );
        assert!(!config.observed_properties.contains_key("time-pos"));
        assert!(!config
            .observed_properties
            .contains_key("demuxer-cache-time"));
        // The wrapper wedges on malformed init payloads instead of erroring —
        // the built config must always pass the plugin's pre-FFI validator.
        tauri_plugin_libmpv::validate_mpv_config(&config).unwrap();
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
