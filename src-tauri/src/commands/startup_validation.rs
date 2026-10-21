use super::{
    LIBRARY_STORE_FILE, LISTS_STORE_FILE, PROFILE_AVATAR_STORE_FILE, SETTINGS_STORE_FILE,
    WATCH_STATUS_STORE_FILE,
};
use serde::{
    de::{MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use std::fs;
use std::io::BufReader;
use tauri::AppHandle;

/// Quarantined `*.corrupt-*` siblings kept per store: a crash loop must not
/// fill AppData, but the newest few stay for forensics.
const MAX_QUARANTINED_STORE_FILES: usize = 3;

struct Discard;

impl<'de> Deserialize<'de> for Discard {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(Self)
    }
}

impl<'de> Visitor<'de> for Discard {
    type Value = Self;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E>(self, _: bool) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_i64<E>(self, _: i64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_u64<E>(self, _: u64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_f64<E>(self, _: f64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_str<E>(self, _: &str) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_unit<E>(self) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self, A::Error> {
        while seq.next_element::<Self>()?.is_some() {}
        Ok(self)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self, A::Error> {
        while map.next_entry::<Self, Self>()?.is_some() {}
        Ok(self)
    }
}

struct JsonObject;

impl<'de> Deserialize<'de> for JsonObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(Self)
    }
}

impl<'de> Visitor<'de> for JsonObject {
    type Value = Self;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a JSON object")
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self, A::Error> {
        Discard.visit_map(map)?;
        Ok(self)
    }
}

fn validate_json_object(reader: impl std::io::Read) -> serde_json::Result<()> {
    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    JsonObject::deserialize(&mut deserializer).and_then(|_| deserializer.end())
}

/// One-time-per-launch store integrity check: an unparseable store file is renamed
/// aside (recoverable) instead of loading as an empty domain and being overwritten
/// on next save; stale `.partial-*` temp siblings are removed. Best-effort.
pub(crate) fn validate_startup_stores(app: &AppHandle) {
    let mut stores = [
        SETTINGS_STORE_FILE,
        PROFILE_AVATAR_STORE_FILE,
        LIBRARY_STORE_FILE,
        LISTS_STORE_FILE,
        WATCH_STATUS_STORE_FILE,
        super::playback_state::PLAYBACK_STATE_STORE_FILE,
    ]
    .into_iter()
    .filter_map(|file| {
        let path = super::resolve_store_path(app, file).ok()?;
        let file_name = path.file_name()?.to_str()?;
        let partial_prefix = format!("{file_name}.partial-");
        let corrupt_prefix = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(|stem| format!("{stem}.corrupt-"));
        Some((file, path, partial_prefix, corrupt_prefix, Vec::new()))
    })
    .collect::<Vec<_>>();

    // All stores share AppData; sweep temp siblings in one directory pass.
    let entries = stores
        .first()
        .and_then(|(_, path, ..)| path.parent())
        .and_then(|parent| fs::read_dir(parent).ok());
    if let Some(entries) = entries {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            for (_, _, partial_prefix, corrupt_prefix, quarantined) in &mut stores {
                if name.starts_with(partial_prefix.as_str()) {
                    let _ = fs::remove_file(entry.path());
                } else if corrupt_prefix
                    .as_deref()
                    .is_some_and(|prefix| name.starts_with(prefix))
                {
                    quarantined.push(entry.path());
                }
            }
        }
    }

    for (file, path, _, _, mut quarantined) in stores {
        // Millisecond suffixes sort chronologically.
        quarantined.sort();
        for stale in quarantined.iter().take(
            quarantined
                .len()
                .saturating_sub(MAX_QUARANTINED_STORE_FILES),
        ) {
            let _ = fs::remove_file(stale);
        }
        let Ok(store_file) = fs::File::open(&path) else {
            continue; // absent or unreadable — the store layer reports the latter.
        };
        if validate_json_object(BufReader::new(store_file)).is_err_and(|error| !error.is_io()) {
            let quarantined = path.with_extension(format!("corrupt-{}", super::now_unix_millis()));
            if fs::rename(&path, &quarantined).is_ok() {
                crate::operational_log::log_warn(
                    "startup",
                    "store-file-validate",
                    "quarantined",
                    &[crate::operational_log::field("file", file)],
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::validate_json_object;

    #[test]
    fn object_validation_matches_value_tree() {
        let deeply_nested = format!("{{\"a\":{}{}}}", "[".repeat(200), "]".repeat(200));
        let cases: &[(&[u8], bool)] = &[
            (b"{}", true),
            (br#"{"a":[1,{"b":null}]}"#, true),
            (
                br#"{"a":[true,false,-1,18446744073709551615,1.5,"x","\uD83D\uDE00"]}"#,
                true,
            ),
            (b"[]", false),
            (b"null", false),
            (b"1", false),
            (br#"{"a":1} x"#, false),
            (br#"{"a":"#, false),
            (b"{\"a\":\"\xff\"}", false),
            (br#"{"a":1e400}"#, false),
            (br#"{"a":"\uD800"}"#, false),
            (deeply_nested.as_bytes(), false),
        ];
        for &(bytes, expected) in cases {
            let valid = validate_json_object(bytes).is_ok();
            assert_eq!(valid, expected, "case: {bytes:?}");
            assert_eq!(
                valid,
                serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(bytes).is_ok(),
                "case: {bytes:?}"
            );
        }
    }
}
