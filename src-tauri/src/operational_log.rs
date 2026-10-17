pub(crate) fn field(name: &'static str, value: impl ToString) -> (&'static str, String) {
    (name, value.to_string())
}

fn normalize_field_value(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_control() || character.is_whitespace() {
            pending_space = !normalized.is_empty();
            continue;
        }
        if pending_space {
            normalized.push(' ');
            pending_space = false;
        }
        if character == '\\' || character == '"' {
            normalized.push('\\');
        }
        normalized.push(character);
    }
    normalized
}

pub(crate) fn log_warn(component: &str, action: &str, outcome: &str, fields: &[(&str, String)]) {
    let mut line = format!(
        "[operational] level=warn component={} action={} outcome={}",
        component, action, outcome
    );

    for (key, value) in fields {
        let normalized = normalize_field_value(value);
        if normalized.is_empty() {
            continue;
        }

        line.push(' ');
        line.push_str(key);
        line.push_str("=\"");
        line.push_str(&normalized);
        line.push('"');
    }

    eprintln!("{}", line);
}

#[cfg(test)]
mod tests {
    use super::normalize_field_value;

    #[test]
    fn normalize_field_value_collapses_controls_whitespace_and_escapes() {
        let cases: &[(&str, &str)] = &[
            ("", ""),
            ("  \t \n  ", ""),
            ("ordinary multiword value", "ordinary multiword value"),
            ("a\n\nb\tc\0d\u{7f}e", "a b c d e"),
            ("x\u{a0}y\u{2003}z", "x y z"),
            ("say \"hi\" \\ done", "say \\\"hi\\\" \\\\ done"),
            ("caf\u{e9} na\u{ef}ve", "caf\u{e9} na\u{ef}ve"),
        ];

        for (input, expected) in cases {
            assert_eq!(&normalize_field_value(input), expected, "input {input:?}");
        }
    }
}
