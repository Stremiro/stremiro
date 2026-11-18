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
fn reorder_known_ids_orders_requests_and_heals_corrupt_lists() {
    for (current, request, expected) in [
        // Omitted ids keep their items, appended in current order — a stale
        // snapshot payload must not drop entries added after it was captured.
        (
            ids(&["a", "b", "c"]),
            ids(&["c", "a"]),
            ids(&["c", "a", "b"]),
        ),
        // Unknown and duplicate requested ids are ignored.
        (
            ids(&["a", "b", "c"]),
            ids(&["ghost", "b", "b", "a"]),
            ids(&["b", "a", "c"]),
        ),
        // An empty request preserves current order.
        (ids(&["a", "b"]), Vec::new(), ids(&["a", "b"])),
        // Corrupt repeated current ids dedupe; an empty request cannot resurrect one.
        (ids(&["a", "b", "a"]), ids(&["b", "a"]), ids(&["b", "a"])),
        (ids(&["a", "b", "a"]), Vec::new(), ids(&["a", "b"])),
    ] {
        assert_eq!(reorder_known_ids(&current, request), expected);
    }
}
