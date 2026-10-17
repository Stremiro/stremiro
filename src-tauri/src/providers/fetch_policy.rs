use std::net::IpAddr;

/// Max redirects per addon/stream fetch — shared with the direct-stream probe (`commands::stream_resolver`).
pub(crate) const MAX_REDIRECT_HOPS: usize = 5;

/// True for an IP literal outside the globally routable range (loopback,
/// private, link-local, reserved). DNS names pass — rebinding is out of scope.
pub(crate) fn is_blocked_ip_literal(host: &str) -> bool {
    // URL host_str() retains brackets around IPv6 literals.
    let host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    // Strip IPv6 zones (`fe80::1%eth0`) and FQDN root dots (`127.0.0.1.` still routes to loopback).
    let bare = host.split('%').next().unwrap_or(host).trim_end_matches('.');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        // Unmap `::ffff:127.0.0.1`-style literals so IPv4 checks apply to them.
        let canonical = match ip {
            IpAddr::V4(_) => ip,
            IpAddr::V6(value) => value.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        };
        return is_non_routable_ip(&canonical);
    }
    // Numeric forms (`2130706433`, `0x7f.0.0.1`, `127.1`) route via `inet_aton`
    // without parsing as `IpAddr`; all-numeric hosts that fail to parse fail closed.
    if !is_numeric_ip_candidate(bare) {
        return false;
    }
    match parse_numeric_ipv4(bare) {
        Some(ipv4) => is_non_routable_ip(&IpAddr::V4(ipv4)),
        None => true,
    }
}

/// True when every dot-separated label looks numeric (decimal/octal/`0x`-hex).
/// Looser than `parse_numeric_part` on purpose: an over-large numeric part
/// fails closed at the caller; hyphen/underscore/colon labels are DNS names.
fn is_numeric_ip_candidate(host: &str) -> bool {
    if host.is_empty() || host.contains(':') {
        return false;
    }
    host.split('.').all(|part| {
        if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
            !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit())
        } else if part.len() > 1 && part.starts_with('0') {
            // Leading-zero `inet_aton` parts are octal; `8`/`9` cannot appear.
            part.chars().all(|c| matches!(c, '0'..='7'))
        } else {
            !part.is_empty() && part.chars().all(|c| c.is_ascii_digit())
        }
    })
}

/// One `inet_aton` part: `0x`-hex, leading-zero octal, or decimal; `None` on malformed.
fn parse_numeric_part(part: &str) -> Option<u32> {
    if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
        if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        u32::from_str_radix(hex, 16).ok()
    } else if part.len() > 1 && part.starts_with('0') {
        if !part.chars().all(|c| matches!(c, '0'..='7')) {
            return None;
        }
        u32::from_str_radix(part, 8).ok()
    } else {
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse::<u32>().ok()
    }
}

/// `inet_aton`-style numeric IPv4 (`a`, `a.b`, `a.b.c`, `a.b.c.d`); `None` on out-of-range/malformed.
fn parse_numeric_ipv4(host: &str) -> Option<std::net::Ipv4Addr> {
    let mut values = [0_u32; 4];
    let mut count = 0;
    for part in host.split('.') {
        if count == values.len() {
            return None;
        }
        values[count] = parse_numeric_part(part)?;
        count += 1;
    }
    let addr: u32 = match &values[..count] {
        [a] => *a,
        [a, b] if *a <= 0xFF && *b <= 0xFF_FFFF => (a << 24) | b,
        [a, b, c] if *a <= 0xFF && *b <= 0xFF && *c <= 0xFFFF => (a << 24) | (b << 16) | c,
        [a, b, c, d] if *a <= 0xFF && *b <= 0xFF && *c <= 0xFF && *d <= 0xFF => {
            (a << 24) | (b << 16) | (c << 8) | d
        }
        _ => return None,
    };
    Some(std::net::Ipv4Addr::from(addr))
}

fn is_non_routable_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => {
            let octets = value.octets();
            // Loopback, unspecified, link-local, private, multicast, shared
            // 100.64/10, broadcast, documentation/benchmark, reserved IANA blocks.
            octets[0] == 0
                || octets[0] == 10
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || octets[0] == 127
                || (octets[0] == 169 && octets[1] == 254)
                || (octets[0] == 172 && (16..=31).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 168)
                || octets[0] >= 224
                || (octets[0] == 192 && octets[1] == 0 && (octets[2] == 0 || octets[2] == 2))
                || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99)
                || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
                || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
                || *value == std::net::Ipv4Addr::BROADCAST
        }
        IpAddr::V6(value) => {
            let segments = value.segments();
            // Unspecified, loopback, link-local fe80::/10, ULA fc00::/7,
            // doc 2001:db8::/32, benchmark 2001:2::/48, multicast, discard
            // 100::/64, TEREDO/port-control leftovers.
            value.is_unspecified()
                || value.is_loopback()
                || value.is_multicast()
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] == 0x2001 && segments[1] == 0x0002)
                || (segments[0] == 0x0064 && segments[1] == 0xff9b)
                || (segments[0] == 0x0100 && segments[1] == 0)
        }
    }
}

/// A `user:pass@host` target would leak secrets into request lines and logs.
fn redirect_target_has_userinfo(next: &reqwest::Url) -> bool {
    !next.username().is_empty() || next.password().is_some()
}

/// http(s) scheme with no embedded credentials — the shared gate for privileged fetch/redirect targets.
pub(crate) fn is_plain_http_url(parsed: &reqwest::Url) -> bool {
    matches!(parsed.scheme(), "http" | "https") && !redirect_target_has_userinfo(parsed)
}

/// True when the redirect may be followed: http(s), no credentials; a hop onto
/// a non-routable IP literal is allowed only back to the same host+port — a
/// loopback addon keeps working, a public addon can't redirect onto LAN/metadata IPs.
pub(crate) fn redirect_target_allowed(initial: &reqwest::Url, next: &reqwest::Url) -> bool {
    if !is_plain_http_url(next) {
        return false;
    }
    if !next.host_str().is_some_and(is_blocked_ip_literal) {
        return true;
    }
    match (initial.host_str(), next.host_str()) {
        (Some(first), Some(target)) => {
            first.eq_ignore_ascii_case(target)
                && initial.port_or_known_default() == next.port_or_known_default()
        }
        _ => false,
    }
}

/// True on same origin (scheme, host, effective port) — cross-origin hops must
/// drop secret headers or a CDN `302` exfiltrates tokens to an attacker host.
pub(crate) fn same_origin_for_proxy_headers(initial: &reqwest::Url, next: &reqwest::Url) -> bool {
    initial.scheme().eq_ignore_ascii_case(next.scheme())
        && initial
            .host_str()
            .zip(next.host_str())
            .is_some_and(|(first, target)| first.eq_ignore_ascii_case(target))
        && initial.port_or_known_default() == next.port_or_known_default()
}

/// Redirect policy for every client touching addon-controlled URLs — violations
/// fail the request with a static, credential-free message.
pub(crate) fn ssrf_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt: reqwest::redirect::Attempt| {
        if attempt.previous().len() > MAX_REDIRECT_HOPS {
            return attempt.error("too many redirects");
        }
        let allowed = attempt
            .previous()
            .first()
            .is_none_or(|initial| redirect_target_allowed(initial, attempt.url()));
        if allowed {
            attempt.follow()
        } else {
            attempt.error("redirect target blocked by fetch policy")
        }
    })
}

#[cfg(test)]
mod tests;
