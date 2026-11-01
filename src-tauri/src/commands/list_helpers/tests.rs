use super::{normalize_list_id, reorder_known_ids};

#[test]
fn list_id_gate_accepts_generated_shape_and_rejects_key_probes() {
    assert_eq!(
        normalize_list_id("list_0123456789abcdef0123456789abcdef").as_deref(),
        Some("list_0123456789abcdef0123456789abcdef")
    );
    // Store keys are `list:{id}` — separators or prefixes would probe or
    // collide onto another key namespace.
    for hostile in [
        "",
        "   ",
        "null",
        "list:other",
        "list_item:x:y",
        "../escape",
        &"a".repeat(65),
    ] {
        assert_eq!(normalize_list_id(hostile), None, "input: {hostile:?}");
    }
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn reorder_known_ids_keeps_requested_order_and_appends_omitted() {
    let current = ids(&["a", "b", "c"]);
    // Omitted ids keep their items, appended in current order — a stale
    // snapshot payload must not drop entries added after it was captured.
    assert_eq!(
        reorder_known_ids(&current, ids(&["c", "a"])),
        ids(&["c", "a", "b"])
    );
}

#[test]
fn reorder_known_ids_ignores_unknown_and_duplicate_requested_ids() {
    let current = ids(&["a", "b", "c"]);
    assert_eq!(
        reorder_known_ids(&current, ids(&["ghost", "b", "b", "a"])),
        ids(&["b", "a", "c"])
    );
}

#[test]
fn reorder_known_ids_empty_request_preserves_current_order() {
    let current = ids(&["a", "b"]);
    assert_eq!(reorder_known_ids(&current, Vec::new()), ids(&["a", "b"]));
}

#[test]
fn reorder_known_ids_dedupes_corrupt_repeated_current_ids() {
    let current = ids(&["a", "b", "a"]);
    assert_eq!(
        reorder_known_ids(&current, ids(&["b", "a"])),
        ids(&["b", "a"])
    );
    // Even an empty request cannot resurrect the corrupt duplicate.
    assert_eq!(reorder_known_ids(&current, Vec::new()), ids(&["a", "b"]));
}
