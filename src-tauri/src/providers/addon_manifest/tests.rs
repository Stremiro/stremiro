use super::*;

fn parse(json: &str) -> AddonManifest {
    parse_addon_manifest(json.as_bytes()).expect("valid manifest")
}

#[test]
fn configuration_required_blocks_only_new_installations_without_changing_snapshots() {
    let bytes = br#"{
        "name": "Needs setup",
        "resources": ["stream"],
        "types": ["movie"],
        "behaviorHints": {"configurationRequired": true, "configurable": true}
    }"#;
    assert_eq!(
        parse_addon_manifest_checked(bytes, true).unwrap_err(),
        ADDON_CONFIGURATION_REQUIRED_MESSAGE
    );
    let snapshot = parse_addon_manifest_checked(bytes, false).expect("installed addon refresh");
    assert!(snapshot_supports_request(
        &snapshot, "stream", "movie", "tt1"
    ));
    assert_eq!(
        serde_json::to_value(snapshot).unwrap(),
        serde_json::json!({
            "name": "Needs setup",
            "resources": [{"name": "stream", "types": ["movie"], "idPrefixes": []}],
            "catalogs": [],
            "configurable": true
        })
    );
}

#[test]
fn configurable_and_malformed_optional_hints_do_not_require_setup() {
    for hints in [
        None,
        Some(serde_json::Value::Null),
        Some(serde_json::json!(true)),
        Some(serde_json::json!([])),
        Some(serde_json::json!({"configurable": true})),
        Some(serde_json::json!({"configurationRequired": false, "configurable": true})),
        Some(serde_json::json!({"configurationRequired": null})),
        Some(serde_json::json!({"configurationRequired": "true"})),
        Some(serde_json::json!({"configurationRequired": 1})),
        Some(serde_json::json!({"configurationRequired": {}})),
    ] {
        let mut value = serde_json::json!({"name": "Ready", "resources": ["stream"]});
        if let Some(hints) = hints {
            value["behaviorHints"] = hints;
        }
        let bytes = serde_json::to_vec(&value).unwrap();
        let snapshot = parse_addon_manifest_checked(&bytes, true).expect("installable manifest");
        assert!(snapshot_is_classified(&snapshot));
    }
}

#[test]
fn repeated_resource_declarations_preserve_paired_scopes_and_dedupe_identical_rows() {
    let snapshot = parse(
        r#"{
            "name": "Scoped streams",
            "resources": [
                {"name":"stream","types":["movie"],"idPrefixes":["tt"]},
                {"name":"stream","types":["series"],"idPrefixes":["kitsu:"]},
                {"name":"stream","types":["movie"],"idPrefixes":["tt"]}
            ]
        }"#,
    );
    assert_eq!(snapshot.resources.len(), 2);
    for (media_type, media_id, allowed) in [
        ("movie", "tt123", true),
        ("series", "kitsu:42", true),
        ("movie", "kitsu:42", false),
        ("series", "tt123", false),
    ] {
        assert_eq!(
            snapshot_supports_request(&snapshot, "stream", media_type, media_id),
            allowed
        );
    }
    let stored = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(
        stored["resources"][1],
        serde_json::json!({"name":"stream","types":["series"],"idPrefixes":["kitsu:"]})
    );
    assert_eq!(
        serde_json::from_value::<AddonManifest>(stored).unwrap(),
        snapshot
    );
    let legacy: AddonManifest = serde_json::from_str(
        r#"{"name":"Legacy","resources":[{"name":"stream","types":["movie"],"idPrefixes":["tt"]}]}"#,
    )
    .unwrap();
    assert!(snapshot_supports_request(
        &legacy, "stream", "movie", "tt123"
    ));
}

#[test]
fn parse_cinemeta_like_manifest_classifies_catalog_and_meta() {
    let snapshot = parse(
        r#"{
                "id": "com.linvo.cinemeta",
                "name": "Cinemeta",
                "version": "3.0.14",
                "resources": ["catalog", "meta", "addon_catalog"],
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
                        ],
                        "extraSupported": ["search", "genre", "skip"]
                    },
                    {
                        "type": "movie",
                        "id": "year",
                        "name": "New",
                        "extra": [
                            {"name": "genre", "options": ["2026", "2025"], "isRequired": true},
                            {"name": "skip"}
                        ],
                        "extraRequired": ["genre"]
                    }
                ],
                "behaviorHints": {"newEpisodeNotifications": true, "configurable": false}
            }"#,
    );

    assert_eq!(snapshot.name, "Cinemeta");
    assert_eq!(
        snapshot
            .resources
            .iter()
            .map(|resource| resource.name.as_str())
            .collect::<Vec<_>>(),
        vec!["catalog", "meta", "addon_catalog"]
    );
    assert!(snapshot_supports_request(
        &snapshot,
        "meta",
        "movie",
        "tt0944947"
    ));
    assert!(!snapshot_supports_request(
        &snapshot,
        "stream",
        "movie",
        "tt0944947"
    ));
    assert!(snapshot_supports_request(
        &snapshot, "catalog", "movie", "ignored"
    ));
    assert!(!snapshot_supports_request(
        &snapshot, "meta", "movie", "kitsu:1"
    ));

    let year = snapshot
        .catalogs
        .iter()
        .find(|catalog| catalog.id == "year")
        .expect("year catalog");
    assert!(year
        .extras
        .iter()
        .any(|extra| extra.name == "genre" && extra.is_required));
    let top = snapshot
        .catalogs
        .iter()
        .find(|catalog| catalog.id == "top")
        .expect("top catalog");
    assert!(top
        .extras
        .iter()
        .any(|extra| extra.name == "search" && !extra.is_required));
}

#[test]
fn object_resource_unrestricted_prefixes_preserve_type_scope() {
    for (label, resource, inherited_types) in [
        (
            "absent",
            serde_json::json!({"name": "stream", "types": ["movie"]}),
            vec!["movie", "series"],
        ),
        (
            "null",
            serde_json::json!({"name": "stream", "types": null, "idPrefixes": null}),
            vec!["movie"],
        ),
        (
            "empty",
            serde_json::json!({"name": "stream", "types": ["movie"], "idPrefixes": []}),
            vec!["movie"],
        ),
    ] {
        let snapshot = parse(
            &serde_json::json!({
                "name": label, "resources": [resource], "types": inherited_types,
                "idPrefixes": ["tt"], "catalogs": []
            })
            .to_string(),
        );
        assert_eq!(snapshot.resources[0].types, ["movie"], "{label}");
        for (media_type, id, expected) in [
            ("movie", "tt0944947", true),
            ("movie", "kitsu:48316", true),
            ("movie", "file://movie", true),
            ("series", "tt0944947", false),
        ] {
            assert_eq!(
                snapshot_supports_request(&snapshot, "stream", media_type, id),
                expected,
                "{label}: {media_type}, {id}"
            );
        }
    }
}

#[test]
fn legacy_short_extras_are_expanded() {
    let snapshot = parse(
        r#"{
                "name": "Legacy",
                "resources": ["catalog"],
                "types": ["movie"],
                "catalogs": [
                    {
                        "type": "movie",
                        "id": "search",
                        "name": "Search",
                        "extraSupported": ["search"],
                        "extraRequired": ["search"]
                    }
                ]
            }"#,
    );

    let extras = &snapshot.catalogs[0].extras;
    assert_eq!(extras.len(), 1);
    assert_eq!(extras[0].name, "search");
    assert!(extras[0].is_required);
}

#[test]
fn mixed_extra_and_extra_supported_declarations_merge() {
    let snapshot = parse(
        r#"{
                "name": "Mixed",
                "resources": ["catalog"],
                "types": ["movie"],
                "catalogs": [
                    {
                        "type": "movie",
                        "id": "top",
                        "extra": [{"name": "genre", "options": ["Action"]}],
                        "extraSupported": ["genre", "search", "skip"]
                    }
                ]
            }"#,
    );

    let extras = &snapshot.catalogs[0].extras;
    // The object declaration wins the dedupe collision (options survive);
    // names only in `extraSupported` must not be dropped — `search` is the
    // hard capability gate for catalog fan-out.
    assert!(extras
        .iter()
        .any(|extra| extra.name == "genre" && extra.options == ["Action".to_string()]));
    assert!(extras.iter().any(|extra| extra.name == "search"));
    assert!(extras.iter().any(|extra| extra.name == "skip"));
    assert_eq!(extras.len(), 3);
}

#[test]
fn malformed_catalog_does_not_drop_valid_siblings() {
    let snapshot = parse(
        r#"{
                "name": "Partial",
                "resources": ["catalog"],
                "types": ["movie"],
                "catalogs": [
                    {"type": "movie"},
                    {"type": "movie", "id": "top", "name": "Popular"},
                    {"id": "missing-type", "name": "Broken"}
                ]
            }"#,
    );

    assert_eq!(snapshot.catalogs.len(), 1);
    assert_eq!(snapshot.catalogs[0].id, "top");
}

#[test]
fn malformed_resource_or_catalog_item_does_not_fail_manifest() {
    let snapshot = parse(
        r#"{
                "name": "Partial",
                "resources": ["catalog", {"bad": true}, "meta"],
                "types": ["movie", 12, "series"],
                "catalogs": [
                    {"type": "movie", "id": "top", "name": "Popular"},
                    "not-an-object",
                    {"type": "series", "id": "top", "name": "Popular Series"}
                ]
            }"#,
    );

    assert_eq!(
        snapshot
            .resources
            .iter()
            .map(|resource| resource.name.as_str())
            .collect::<Vec<_>>(),
        vec!["catalog", "meta"]
    );
    // Manifest-level `types` is an inheritance input: name-only resources
    // pick it up, and it is not retained on the snapshot.
    assert_eq!(snapshot.resources[0].types, vec!["movie", "series"]);
    assert_eq!(snapshot.catalogs.len(), 2);
}

#[test]
fn nameless_manifest_is_rejected() {
    let error =
        parse_addon_manifest(br#"{"resources":["catalog"]}"#).expect_err("nameless manifest");
    assert!(error.contains("Invalid addon manifest"));
}

#[test]
fn rejects_oversized_manifest() {
    let mut oversized = vec![b'{'; MANIFEST_MAX_BYTES + 1];
    oversized[0] = b'{';
    oversized[1] = b'}';
    let error = parse_addon_manifest(&oversized).expect_err("size limit");
    assert!(error.contains("512 KiB"));
}

#[test]
fn display_only_snapshot_without_resources_is_unclassified() {
    let snapshot = parse(r#"{"name": "Cinemeta"}"#);
    assert!(snapshot.resources.is_empty());
    assert!(!snapshot_is_classified(&snapshot));
}

#[test]
fn catalog_types_and_resource_matching_are_case_insensitive() {
    let snapshot = parse(
        r#"{
                "name": "Case",
                "resources": ["meta"],
                "types": ["movie"],
                "idPrefixes": ["tt"],
                "catalogs": [
                    {"type": "movie", "id": "top", "extra": [{"name": "Genre"}, {"name": "genre"}]},
                    {"type": "MOVIE", "id": "TOP", "extra": []}
                ]
            }"#,
    );

    assert_eq!(snapshot.catalogs.len(), 2);
    assert_eq!(snapshot.catalogs[0].extras.len(), 1);
    // ID prefix matches regardless of media-id casing.
    assert!(snapshot_supports_request(
        &snapshot,
        "meta",
        "MOVIE",
        "TT0944947"
    ));
}

#[test]
fn display_facts_are_bounded_sanitized_and_never_fail_the_manifest() {
    let long_description = "d".repeat(MAX_DESCRIPTION_CHARS + 20);
    for (fields, logo, version, description, configurable) in [
        (
            serde_json::json!({
                "logo": "https://addon.example/logo.png",
                "version": " 1.2.3 ",
                "description": "Streams from somewhere.",
                "behaviorHints": {"configurable": true}
            }),
            Some("https://addon.example/logo.png"),
            Some("1.2.3"),
            Some("Streams from somewhere."),
            true,
        ),
        (
            serde_json::json!({
                "logo": "javascript:alert(1)",
                "version": 3,
                "description": long_description,
                "behaviorHints": {"configurable": "yes"}
            }),
            None,
            None,
            Some(&long_description[..MAX_DESCRIPTION_CHARS]),
            false,
        ),
        (
            serde_json::json!({"logo": {"src": "x"}, "description": "  "}),
            None,
            None,
            None,
            false,
        ),
    ] {
        let mut value = serde_json::json!({"name": "Addon", "resources": ["stream"]});
        for (key, field) in fields.as_object().unwrap() {
            value[key] = field.clone();
        }
        let snapshot = parse(&value.to_string());
        assert_eq!(snapshot.logo.as_deref(), logo);
        assert_eq!(snapshot.version.as_deref(), version);
        assert_eq!(snapshot.description.as_deref(), description);
        assert_eq!(snapshot.configurable, configurable);
    }
}

#[test]
fn stored_snapshots_without_display_facts_still_decode() {
    let stored = serde_json::json!({
        "name": "Legacy",
        "resources": [{"name": "stream", "types": ["movie"], "idPrefixes": []}],
        "catalogs": []
    });
    let snapshot = AddonManifest::deserialize(&stored).expect("legacy snapshot");
    assert!(snapshot.logo.is_none() && !snapshot.configurable);
    assert_eq!(serde_json::to_value(&snapshot).unwrap(), stored);
}

#[test]
fn resource_kinds_follow_routing_rules() {
    use AddonResourceKind::{Catalog, Meta, Stream, Subtitles};
    for (json, expected) in [
        (
            crate::test_helpers::cinemeta_manifest_json(),
            vec![Catalog, Meta],
        ),
        (
            r#"{"name":"S","resources":["subtitles","stream"],"types":["movie"]}"#,
            vec![Stream, Subtitles],
        ),
        (r#"{"name":"Typeless","resources":["stream"]}"#, vec![]),
        (
            r#"{"name":"Catalogs","catalogs":[{"type":"movie","id":"top"}]}"#,
            vec![Catalog],
        ),
    ] {
        assert_eq!(snapshot_resource_kinds(&parse(json)), expected, "{json}");
    }
}

#[test]
fn configure_url_replaces_the_manifest_segment_and_keeps_the_query() {
    for (base, expected) in [
        ("https://addon.example", "https://addon.example/configure"),
        ("https://addon.example/", "https://addon.example/configure"),
        (
            "https://addon.example/abc%7C123",
            "https://addon.example/abc%7C123/configure",
        ),
        (
            "http://addon.example/abc?key=1",
            "http://addon.example/abc/configure?key=1",
        ),
        (
            "https://addon.example/abc/Manifest.json",
            "https://addon.example/abc/configure",
        ),
    ] {
        assert_eq!(build_configure_url(base).unwrap(), expected);
    }
    assert!(build_configure_url("not a url").is_err());
}
