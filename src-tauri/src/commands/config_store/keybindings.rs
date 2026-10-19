use std::collections::{BTreeMap, HashSet};

/// Rebindable actions and default keys, in conflict-priority order.
pub(super) const PLAYER_KEYBINDING_ACTIONS: [(&str, &[&str]); 22] = [
    ("togglePlay", &[" ", "k"]),
    ("seekBackward", &["arrowleft", "j"]),
    ("seekForward", &["arrowright", "l"]),
    ("volumeUp", &["arrowup"]),
    ("volumeDown", &["arrowdown"]),
    ("toggleMute", &["m"]),
    ("toggleFullscreen", &["f"]),
    ("frameBackward", &[","]),
    ("frameForward", &["."]),
    ("speedDown", &["["]),
    ("speedUp", &["]"]),
    ("speedReset", &["\\"]),
    ("cycleSubtitles", &["c"]),
    ("cycleAudio", &["a"]),
    ("subtitleEarlier", &["z"]),
    ("subtitleLater", &["x"]),
    ("skipSegment", &["s", "enter"]),
    ("nextEpisode", &["n"]),
    ("episodes", &["e"]),
    ("streamSelector", &["q"]),
    ("dock", &["i"]),
    ("shortcuts", &["?"]),
];
const PLAYER_KEYBINDING_MAX_KEYS: usize = 2;
const PLAYER_KEYBINDING_KEY_MAX_CHARS: usize = 16;
/// Reserve navigation, modifier/lock and IME keys; digits retain percent seek.
const PLAYER_KEYBINDING_RESERVED_KEYS: [&str; 13] = [
    "escape",
    "tab",
    "shift",
    "control",
    "alt",
    "altgraph",
    "meta",
    "os",
    "capslock",
    "numlock",
    "dead",
    "process",
    "unidentified",
];
/// Keys are lowercased `KeyboardEvent.key` values; `" "` is Space.
pub(crate) fn normalize_player_binding_key(key: &str) -> Result<String, String> {
    if key == " " {
        return Ok(key.to_string());
    }
    if key.chars().nth(PLAYER_KEYBINDING_KEY_MAX_CHARS).is_some() {
        return Err("This key can’t be assigned.".to_string());
    }
    let key = key.to_lowercase();
    let length = key.chars().count();
    if length == 1 && key.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("Number keys are reserved for seeking to a percentage.".to_string());
    }
    if length == 0
        || length > PLAYER_KEYBINDING_KEY_MAX_CHARS
        || key.chars().any(|ch| ch.is_whitespace() || ch.is_control())
        || PLAYER_KEYBINDING_RESERVED_KEYS.contains(&key.as_str())
    {
        return Err("This key can’t be assigned.".to_string());
    }
    Ok(key)
}

/// Unknown actions drop; a key claimed by an earlier action loses in later ones.
pub(super) fn normalize_player_keybindings(
    mut bindings: BTreeMap<String, Vec<String>>,
) -> BTreeMap<String, Vec<String>> {
    let mut claimed = HashSet::new();
    let mut normalized = BTreeMap::new();
    for (action, _) in PLAYER_KEYBINDING_ACTIONS {
        let Some(keys) = bindings.remove(action) else {
            continue;
        };
        let keys: Vec<String> = keys
            .iter()
            .filter_map(|key| normalize_player_binding_key(key).ok())
            .filter(|key| claimed.insert(key.clone()))
            .take(PLAYER_KEYBINDING_MAX_KEYS)
            .collect();
        normalized.insert(action.to_string(), keys);
    }
    normalized
}

pub(super) fn resolve_player_keybindings(
    overrides: &BTreeMap<String, Vec<String>>,
) -> BTreeMap<String, Vec<String>> {
    let mut claimed = HashSet::new();
    let mut effective = BTreeMap::new();
    for (action, _) in PLAYER_KEYBINDING_ACTIONS {
        if let Some(keys) = overrides.get(action) {
            effective.insert(
                action.to_string(),
                keys.iter()
                    .filter(|key| claimed.insert(key.as_str()))
                    .cloned()
                    .collect(),
            );
        }
    }
    for (action, keys) in PLAYER_KEYBINDING_ACTIONS {
        if !overrides.contains_key(action) {
            effective.insert(
                action.to_string(),
                keys.iter()
                    .filter(|key| claimed.insert(**key))
                    .map(|key| key.to_string())
                    .collect(),
            );
        }
    }
    effective
}

pub(crate) fn bind_player_key(
    mut overrides: BTreeMap<String, Vec<String>>,
    action: &str,
    slot: usize,
    key: Option<&str>,
) -> Result<BTreeMap<String, Vec<String>>, String> {
    let &(_, defaults) = PLAYER_KEYBINDING_ACTIONS
        .iter()
        .find(|(id, _)| *id == action)
        .ok_or_else(|| "Unknown player action.".to_string())?;
    if slot >= PLAYER_KEYBINDING_MAX_KEYS {
        return Err("Invalid shortcut slot.".to_string());
    }
    if overrides.len() > PLAYER_KEYBINDING_ACTIONS.len() {
        return Err("Too many player shortcuts.".to_string());
    }
    for (action, keys) in &mut overrides {
        if !PLAYER_KEYBINDING_ACTIONS
            .iter()
            .any(|(id, _)| *id == action)
        {
            return Err("Unknown player action.".to_string());
        }
        if keys.len() > PLAYER_KEYBINDING_MAX_KEYS {
            return Err("Too many keys for player action.".to_string());
        }
        for key in keys {
            *key = normalize_player_binding_key(key)?;
        }
    }
    let key = key.map(normalize_player_binding_key).transpose()?;
    let mut updated = resolve_player_keybindings(&overrides)
        .remove(action)
        .unwrap_or_default();
    if let Some(key) = &key {
        if slot < updated.len() {
            updated[slot] = key.clone();
        } else {
            updated.push(key.clone());
        }
        for keys in overrides.values_mut() {
            keys.retain(|existing| existing != key);
        }
    } else if slot < updated.len() {
        updated.remove(slot);
    }
    let mut seen = HashSet::new();
    updated.retain(|key| seen.insert(key.clone()));
    updated.truncate(PLAYER_KEYBINDING_MAX_KEYS);
    if updated
        .iter()
        .map(String::as_str)
        .eq(defaults.iter().copied())
    {
        overrides.remove(action);
    } else {
        overrides.insert(action.to_string(), updated);
    }
    Ok(overrides)
}
