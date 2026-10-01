use super::*;

fn parse(json: &str) -> AddonManifest {
    parse_addon_manifest(json.as_bytes()).expect("valid manifest")
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
fn object_resource_without_prefixes_inherits_manifest_prefixes() {
    let snapshot = parse(
        r#"{
                "name": "Streams",
                "resources": [
                    {"name": "stream", "types": ["movie"]}
                ],
                "types": ["movie", "series"],
                "idPrefixes": ["tt"],
                "catalogs": []
            }"#,
    );

    assert!(snapshot_supports_request(
        &snapshot,
        "stream",
        "movie",
        "tt0944947"
    ));
    assert!(!snapshot_supports_request(
        &snapshot,
        "stream",
        "movie",
        "kitsu:48316"
    ));
    assert!(!snapshot_supports_request(
        &snapshot,
        "stream",
        "series",
        "tt0944947"
    ));
}

#[test]
fn object_resource_explicit_empty_prefixes_matches_all_ids() {
    let snapshot = parse(
        r#"{
                "name": "Local",
                "resources": [
                    {"name": "stream", "types": ["movie"], "idPrefixes": []}
                ],
                "types": ["movie"],
                "idPrefixes": ["tt"],
                "catalogs": []
            }"#,
    );

    assert!(snapshot_supports_request(
        &snapshot,
        "stream",
        "movie",
        "file://movie"
    ));
    assert!(snapshot_supports_request(
        &snapshot,
        "stream",
        "movie",
        "kitsu:48316"
    ));
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
fn catalog_matching_is_case_insensitive() {
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

    // Duplicate catalog collapses case-insensitively; extras dedupe too.
    assert_eq!(snapshot.catalogs.len(), 1);
    assert_eq!(snapshot.catalogs[0].extras.len(), 1);
    // ID prefix matches regardless of media-id casing.
    assert!(snapshot_supports_request(
        &snapshot,
        "meta",
        "MOVIE",
        "TT0944947"
    ));
}
