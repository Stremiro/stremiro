pub(crate) fn field(name: &'static str, value: impl ToString) -> (&'static str, String) {
    (name, value.to_string())
}

fn normalize_field_value(value: &str) -> String {
    let collapsed = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();

    collapsed
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
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
