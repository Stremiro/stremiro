use super::*;

fn url(value: &str) -> reqwest::Url {
    reqwest::Url::parse(value).expect("valid test url")
}

#[test]
fn blocked_ip_literals_cover_loopback_private_and_metadata_ranges() {
    for host in [
        "127.0.0.1",
        "10.0.0.8",
        "192.168.1.10",
        "172.16.4.2",
        "0.0.0.0",
        "169.254.169.254",
        "224.0.0.1",
        "::1",
        "::ffff:127.0.0.1",
    ] {
        assert!(is_blocked_ip_literal(host), "{host} must be blocked");
    }
}

#[test]
fn public_hosts_and_ips_are_not_blocked() {
    for host in [
        "v3-cinemeta.strem.io",
        "8.8.8.8",
        "1.1.1.1",
        "kitsu.io",
        "example-addon.test",
        // Non-standard numerics routing to public space must also pass.
        "134744072", // 8.8.8.8 as a single decimal
        "0x8080808", // 8.8.8.8 as a single hex
        "8.8.8",     // 8.8.0.8 abbreviated form
        "dead.beef", // hex-looking labels without numeric syntax are DNS
    ] {
        assert!(!is_blocked_ip_literal(host), "{host} must pass");
    }
}

#[test]
fn non_standard_loopback_and_private_numerics_are_blocked() {
    // Each form below routes to loopback, LAN, or link-local/metadata
    // space through `inet_aton` semantics despite never parsing as
    // `IpAddr`; all must hit the same block as their dotted-quad form.
    for host in [
        "2130706433",        // 127.0.0.1 decimal
        "3232235777",        // 192.168.1.1 decimal
        "2852039166",        // 169.254.169.254 decimal
        "0x7f000001",        // 127.0.0.1 hex
        "0x7f.0.0.1",        // mixed hex/dotted loopback
        "0xc0.0xa8.0x1.0x1", // 192.168.1.1 fully hex-dotted
        "0177.0.0.1",        // 127.0.0.1 octal
        "127.1",             // abbreviated loopback
        "10.1",              // abbreviated 10.0.0.1
        "0",                 // 0.0.0.0
        "256.1.1.1",         // all-numeric but unparseable: fail closed
    ] {
        assert!(is_blocked_ip_literal(host), "{host} must be blocked");
    }
}

#[test]
fn public_to_private_redirect_is_blocked() {
    let initial = url("https://evil-addon.test/manifest.json");
    assert!(!redirect_target_allowed(
        &initial,
        &url("http://127.0.0.1:11470/admin")
    ));
    assert!(!redirect_target_allowed(
        &initial,
        &url("http://169.254.169.254/latest/meta-data/")
    ));
    assert!(!redirect_target_allowed(
        &initial,
        &url("http://192.168.1.1/")
    ));
}

#[test]
fn url_parser_normalizes_routable_numerics_before_the_gate() {
    // WHATWG URL parsing canonicalizes legacy numeric hosts, so production
    // callers (which pass `host_str()`) usually meet the standard literal
    // path; the raw-string numeric layer stays as defense in depth. This
    // locks the end-to-end verdict whatever the parser does.
    for (raw, canonical) in [
        ("http://2130706433/", "127.0.0.1"),
        ("http://0x7f000001/", "127.0.0.1"),
        ("http://0x7f.0.0.1/", "127.0.0.1"),
        ("http://0177.0.0.1/", "127.0.0.1"),
        ("http://127.1/", "127.0.0.1"),
        ("http://10.1/", "10.0.0.1"),
    ] {
        let parsed = url(raw);
        assert_eq!(
            parsed.host_str().unwrap_or(""),
            canonical,
            "{raw} must normalize"
        );
        assert!(
            is_blocked_ip_literal(parsed.host_str().unwrap_or("")),
            "{raw} must be blocked"
        );
    }
}

#[test]
fn public_to_numeric_private_redirect_is_blocked() {
    let initial = url("https://evil-addon.test/manifest.json");
    // Dotted decimal, single-decimal, and hex/octal loopback forms must
    // hit the same block as their canonical literal.
    for target in [
        "http://2130706433/admin",
        "http://0x7f.0.0.1/admin",
        "http://0177.0.0.1/admin",
        "http://2852039166/latest/meta-data/",
    ] {
        assert!(
            !redirect_target_allowed(&initial, &url(target)),
            "{target} must be blocked"
        );
    }
}

#[test]
fn public_to_public_and_non_http_targets() {
    let initial = url("https://evil-addon.test/manifest.json");
    assert!(redirect_target_allowed(
        &initial,
        &url("https://cdn.test/streams.json")
    ));
    assert!(!redirect_target_allowed(
        &initial,
        &url("file:///etc/passwd")
    ));
}

#[test]
fn local_addon_same_host_redirect_stays_allowed() {
    let initial = url("http://127.0.0.1:11470/manifest.json");
    assert!(redirect_target_allowed(
        &initial,
        &url("http://127.0.0.1:11470/stream/movie/tt1234567.json")
    ));
    assert!(!redirect_target_allowed(
        &initial,
        &url("http://192.168.1.5/stream.json")
    ));
    // Same IP but a different local port is a different origin: a
    // redirecting payload must not port-scan sideways on loopback.
    assert!(!redirect_target_allowed(
        &initial,
        &url("http://127.0.0.1:9999/admin")
    ));
}

#[test]
fn redirect_targets_with_embedded_credentials_are_rejected() {
    let initial = url("https://cdn.test/manifest.json");
    assert!(!redirect_target_allowed(
        &initial,
        &url("https://user:pass@cdn.test/streams.json")
    ));
    let local = url("http://127.0.0.1:11470/manifest.json");
    assert!(!redirect_target_allowed(
        &local,
        &url("http://user:pass@127.0.0.1:11470/stream.json")
    ));
}
