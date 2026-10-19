use super::*;
use crate::commands::streaming_helpers::PLAYBACK_URL_MAX_BYTES;
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
                "demuxer-cache-duration" => buffered_ahead.clone(),
                _ => panic!("unexpected native property {name}"),
            }
        });
        assert_eq!(*calls.borrow(), ["time-pos", "demuxer-cache-duration"]);
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
            .contains_key("demuxer-cache-duration"));
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
    for target in [
        "file:///C:/x.lua",
        "magnet:?xt=urn:btih:x",
        "example.com/video",
        "https://",
        "http://?video",
        "https://bad host/video",
        "https://example.com:invalid/video",
        "http://[::1/video",
    ] {
        assert!(
            validate_mpv_command("loadfile", &[json!(target)]).is_err(),
            "{target}"
        );
    }
    for target in [
        "https://example.com/video",
        "http://127.0.0.1:11470/video",
        "http://localhost:11470/video",
        "http://[::1]:11470/video",
    ] {
        assert!(
            validate_mpv_command("loadfile", &[json!(target)]).is_ok(),
            "{target}"
        );
        assert!(
            validate_mpv_command("loadfile", &[json!(target), json!("replace")]).is_ok(),
            "{target}"
        );
    }
    for args in [
        vec![],
        vec![json!(true)],
        vec![json!(42)],
        vec![json!("https://example.com/video"), json!(true)],
        vec![json!("https://example.com/video"), json!(42)],
        vec![json!("https://example.com/video"), json!("append")],
        vec![json!("https://example.com/video"), json!("--pause")],
        vec![
            json!("https://example.com/video"),
            json!("replace"),
            json!(0),
        ],
        vec![
            json!("https://example.com/video"),
            json!("replace"),
            json!("pause=yes"),
        ],
    ] {
        assert!(validate_mpv_command("loadfile", &args).is_err(), "{args:?}");
    }
    assert!(validate_mpv_command("sub-add", &[json!("\\\\nas\\share\\s.srt")]).is_err());

    // Direct IPC must enforce the same subtitle policy as addon ingestion.
    for target in [
        "https://",
        "https://user:pass@cdn.example/sub.srt",
        "http://127.0.0.1/sub.srt",
        "http://2130706433/sub.srt",
        "http://192.168.1.1/sub.srt",
        "http://169.254.169.254/sub.srt",
        "http://[::1]/sub.srt",
    ] {
        assert!(
            validate_mpv_command("sub-add", &[json!(target)]).is_err(),
            "{target}"
        );
    }
    assert!(
        validate_mpv_command("sub-add", &[json!("https://cdn.example/sub.srt?token=x")]).is_ok()
    );
    // set/cycle only reach allowlisted properties (`sub` is mpv's sid alias —
    // the subtitle cycle hotkey depends on it).
    assert!(validate_mpv_command("set", &[json!("script"), json!("evil.lua")]).is_err());
    assert!(validate_mpv_command("cycle", &[json!("watch-later-directory")]).is_err());
    assert!(validate_mpv_command("set", &[json!("screenshot-directory"), json!("C:\\")]).is_err());
    assert!(validate_mpv_command("set", &[json!("volume"), json!("80")]).is_ok());
    assert!(validate_mpv_command("cycle", &[json!("sub")]).is_ok());
    assert!(validate_mpv_command("cycle", &[json!("volume")]).is_err());
}

#[test]
fn mpv_command_rejects_non_scalar_or_oversized_args() {
    assert!(validate_mpv_command("seek", &[json!(["nested"])]).is_err());
    assert!(validate_mpv_command("seek", &[json!("x".repeat(MPV_ARG_MAX_CHARS + 1))]).is_err());
    let too_many = vec![json!("0"); MPV_COMMAND_MAX_ARGS + 1];
    assert!(validate_mpv_command("seek", &too_many).is_err());
    let prefix = "https://example.com/";
    let mut target = format!(
        "{prefix}{}",
        "x".repeat(PLAYBACK_URL_MAX_BYTES - prefix.len())
    );
    assert!(validate_mpv_command("loadfile", &[json!(target), json!("replace")]).is_ok());
    target.push('x');
    assert!(validate_mpv_command("loadfile", &[json!(target)]).is_err());
}

#[test]
fn loadfile_accepts_percent_encoded_ingress_urls_without_widening_other_args() {
    let prefix = "https://example.com/";
    let fragment = "#file=Episode%201.mkv&hint=%2f%2F+opaque";
    for character in ["漢", "\u{10000}"] {
        let raw = format!(
            "{prefix}{}{fragment}",
            character.repeat(2_048 - prefix.len() - fragment.len())
        );
        assert_eq!(raw.chars().count(), 2_048);
        let canonical = reqwest::Url::parse(&raw).unwrap().to_string();
        assert!(canonical.len() > MPV_ARG_MAX_CHARS);
        assert!(canonical.len() <= PLAYBACK_URL_MAX_BYTES);
        for target in [raw, canonical] {
            assert!(validate_mpv_command("loadfile", &[json!(target), json!("replace")]).is_ok());
            assert!(validate_mpv_command("seek", &[json!(target)]).is_err());
            assert!(validate_mpv_command("sub-add", &[json!(target), json!("select")]).is_err());
        }
    }
}

#[test]
fn loadfile_rejects_urls_whose_canonical_encoding_exceeds_the_playback_bound() {
    let raw = format!(
        "https://example.com/{}",
        "\u{10000}".repeat(PLAYBACK_URL_MAX_BYTES / 12 + 1)
    );
    assert!(raw.len() <= PLAYBACK_URL_MAX_BYTES);
    let canonical = reqwest::Url::parse(&raw).unwrap().to_string();
    assert!(canonical.len() > PLAYBACK_URL_MAX_BYTES);
    for target in [raw, canonical] {
        assert!(validate_mpv_command("loadfile", &[json!(target)]).is_err());
    }
}

#[test]
fn property_batches_validate_every_entry_and_bound_native_work() {
    let properties: Vec<(String, Value)> = serde_json::from_value(json!([
        ["sub-delay", 0.2],
        ["sub-pos", 90],
        ["sub-scale", 1.1],
        ["sub-visibility", false],
        ["sub-visibility", true],
        ["http-header-fields", ""]
    ]))
    .unwrap();
    assert!(validate_mpv_properties(&properties).is_ok());
    assert!(validate_mpv_properties(&[]).is_ok());
    for invalid in [
        ("script", json!("evil.lua")),
        ("volume", json!({"nested": 80})),
        ("sub-delay", Value::Null),
        ("aid", json!("x".repeat(MPV_ARG_MAX_CHARS + 1))),
    ] {
        let mut batch = properties.clone();
        batch.push((invalid.0.to_string(), invalid.1));
        assert!(validate_mpv_properties(&batch).is_err());
    }
    assert!(validate_mpv_properties(&vec![
        ("volume".to_string(), json!(80));
        MPV_SETTABLE_PROPERTIES.len() + 1
    ])
    .is_err());
}

#[test]
fn subtitle_property_values_use_persisted_normalization_and_survive_native_failure() {
    for (delay, pos, scale, expected) in [
        (-0.15, 120.0, 0.0, [-0.2, 100.0, 1.0]),
        (-8.0, -5.0, -1.0, [-5.0, 0.0, 1.0]),
        (8.0, 42.5, 0.275, [5.0, 42.5, 0.3]),
        (0.0, 100.0, 4.0, [0.0, 100.0, 3.0]),
    ] {
        let mut properties = vec![
            ("sub-delay".to_string(), json!(delay)),
            ("sub-pos".to_string(), json!(pos)),
            ("sub-scale".to_string(), json!(scale.to_string())),
            ("pause".to_string(), json!(false)),
        ];
        validate_mpv_properties(&properties).unwrap();
        let subtitle_properties = normalize_mpv_subtitle_properties(&mut properties);
        assert_eq!(
            subtitle_properties,
            ["sub-delay", "sub-pos", "sub-scale"]
                .into_iter()
                .zip(expected)
                .map(|(name, value)| (name.to_string(), json!(value)))
                .collect::<Vec<_>>()
        );
        let mut calls = Vec::new();
        let message = apply_mpv_properties(&properties, |name, value| {
            calls.push((name.to_string(), value.clone()));
            Err("mpv unavailable".to_string())
        })
        .unwrap_err();
        assert_eq!(calls, properties);
        assert_eq!(
            serde_json::to_value(MpvSetError {
                message,
                subtitle_properties: subtitle_properties.clone(),
            })
            .unwrap(),
            json!({
                "message": "mpv unavailable",
                "subtitleProperties": subtitle_properties,
            })
        );
    }
}

#[test]
fn property_batch_preserves_order_and_continues_after_native_failure() {
    let properties = vec![
        ("sub-delay".to_string(), json!(0.2)),
        ("sub-pos".to_string(), json!(90)),
        ("http-header-fields".to_string(), json!("")),
    ];
    for fail in [false, true] {
        let mut calls = Vec::new();
        let result = apply_mpv_properties(&properties, |name, value| {
            calls.push((name.to_string(), value.clone()));
            if fail && name != "http-header-fields" {
                Err(name.to_string())
            } else {
                Ok(())
            }
        });
        assert_eq!(calls, properties);
        assert_eq!(
            result,
            if fail {
                Err("sub-delay".to_string())
            } else {
                Ok(())
            }
        );
    }
}

#[test]
fn encoded_addon_headers_fit_property_writes_without_widening_other_arguments() {
    use crate::providers::addons::BehaviorHints;

    let hints = BehaviorHints {
        proxy_headers: Some(json!({"request": {
            "Authorization": "a".repeat(3000),
            "Cookie": "b".repeat(2000),
        }})),
        ..Default::default()
    };
    let fields = hints
        .proxy_request_headers()
        .into_iter()
        .map(|(name, value)| format!("{name}: {value}"))
        .collect::<Vec<_>>()
        .join(",");
    assert!(fields.len() > MPV_ARG_MAX_CHARS);
    for value in [json!(fields), json!("")] {
        assert!(
            validate_mpv_properties(&[("http-header-fields".to_string(), value.clone())]).is_ok()
        );
        assert!(validate_mpv_command("set", &[json!("http-header-fields"), value.clone()]).is_ok());
        assert!(
            validate_mpv_command("cycle", &[json!("http-header-fields"), value.clone()]).is_err()
        );
    }
    for value in [
        json!("x".repeat(2 * crate::providers::addons::MAX_PROXY_HEADERS_BYTES + 1)),
        json!("Authorization: secret\r\nX-Injected: value"),
        json!("Cookie: secret\nX-Injected: value"),
        json!(80),
    ] {
        assert!(
            validate_mpv_properties(&[("http-header-fields".to_string(), value.clone())]).is_err()
        );
        for verb in ["set", "cycle"] {
            assert!(
                validate_mpv_command(verb, &[json!("http-header-fields"), value.clone()]).is_err()
            );
        }
    }
    assert!(validate_mpv_command("seek", &[json!(fields)]).is_err());
}
