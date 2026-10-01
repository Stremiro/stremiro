use std::net::IpAddr;

/// Max redirects per addon/stream fetch. Shared with the direct-stream
/// probe (`commands::stream_resolver`) so the two caps cannot drift.
pub(crate) const MAX_REDIRECT_HOPS: usize = 5;

/// True when `host` is an IP literal outside the globally routable range:
/// loopback, private, link-local, unspecified, multicast, broadcast,
/// documentation, benchmark, and other reserved ranges. DNS names return
/// false; name-based rebinding is out of scope for the sync redirect hook and
/// stays bounded by the hop cap plus per-call timeouts and size limits.
pub(crate) fn is_blocked_ip_literal(host: &str) -> bool {
    // Strip an IPv6 zone (`fe80::1%eth0`) so it cannot dodge the literal check.
    // A single trailing dot is a valid FQDN root marker that resolvers ignore
    // (`127.0.0.1.` still routes to loopback), so it is stripped as well;
    // stripping never changes the verdict for real DNS names.
    let bare = host.split('%').next().unwrap_or(host).trim_end_matches('.');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        // Unmap `::ffff:127.0.0.1`-style literals so IPv4 checks apply to them.
        let canonical = match ip {
            IpAddr::V4(_) => ip,
            IpAddr::V6(value) => value.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        };
        return is_non_routable_ip(&canonical);
    }
    // Non-standard numeric forms (`2130706433`, `0x7f.0.0.1`, `0177.0.0.1`,
    // `127.1`) never parse as `IpAddr` but the OS resolver still routes them
    // with `inet_aton` semantics, which would dodge the literal block above.
    // Hosts with a non-numeric label are DNS names and pass; all-numeric
    // hosts that fail to parse fail closed (an all-numeric TLD is invalid,
    // so they can never be legitimate DNS names).
    if !is_numeric_ip_candidate(bare) {
        return false;
    }
    match parse_numeric_ipv4(bare) {
        Some(ipv4) => is_non_routable_ip(&IpAddr::V4(ipv4)),
        None => true,
    }
}

/// True when every dot-separated label looks like a number (decimal, octal,
/// or `0x`-hex) rather than a DNS label. Labels with hyphens, underscores,
/// unprefixed letters beyond decimal digits, or colons are DNS names.
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

/// Parse one `inet_aton` numeric part: `0x`-hex, leading-zero octal, or plain
/// decimal. Returns `None` for malformed parts.
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

/// Parse `inet_aton`-style numeric IPv4 (`a`, `a.b`, `a.b.c`, `a.b.c.d`)
/// into an address. Returns `None` for out-of-range or malformed input.
fn parse_numeric_ipv4(host: &str) -> Option<std::net::Ipv4Addr> {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let mut values = Vec::with_capacity(parts.len());
    for part in &parts {
        values.push(parse_numeric_part(part)?);
    }
    let addr: u32 = match values.as_slice() {
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
            // Loopback 127.0.0.0/8, unspecified 0.0.0.0/8, link-local
            // 169.254.0.0/16, private 10/8, 172.16/12, 192.168/16, multicast
            // 224/4, broadcast 255.255.255.255, documentation and benchmark
            // ranges, plus other reserved IANA special-purpose blocks.
            octets[0] == 0
                || octets[0] == 10
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
            // Unspecified ::, loopback ::1, IPv4-mapped leftovers that parse
            // as non-global, link-local fe80::/10, unique-local fc00::/7,
            // documentation 2001:db8::/32, benchmark 2001:2::/48, multicast
            // ff00::/8, discard 100::/64, TEREDO/port-control leftovers.
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

/// True when a redirect target carries embedded credentials. Addon URLs are
/// opaque user data; a `user:pass@host` target would leak those secrets into
/// request lines, error strings, and logs, so it is rejected outright.
fn redirect_target_has_userinfo(next: &reqwest::Url) -> bool {
    !next.username().is_empty() || next.password().is_some()
}

/// True when a redirect from `initial` to `next` may be followed. Targets are
/// restricted to `http(s)` without embedded credentials; a hop onto a
/// non-routable IP literal is allowed only back to the same host *and* port,
/// which preserves the explicit local-addon policy (a user-configured
/// loopback addon keeps working within its own origin) while stopping a
/// public addon from redirecting fetches onto loopback, LAN, metadata IPs,
/// or sideways to another local port.
pub(crate) fn redirect_target_allowed(initial: &reqwest::Url, next: &reqwest::Url) -> bool {
    if !matches!(next.scheme(), "http" | "https") {
        return false;
    }
    if redirect_target_has_userinfo(next) {
        return false;
    }
    let blocked = next.host_str().is_some_and(is_blocked_ip_literal);
    if !blocked {
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

/// True when `initial` and `next` share one origin (scheme, host, and
/// effective port): proxy/secret headers addressed to the first hop stay on
/// that origin. A cross-origin hop must drop them, or a CDN `302` to an
/// attacker host exfiltrates the addon's bearer tokens with the probe.
pub(crate) fn same_origin_for_proxy_headers(initial: &reqwest::Url, next: &reqwest::Url) -> bool {
    initial.scheme().eq_ignore_ascii_case(next.scheme())
        && initial
            .host_str()
            .zip(next.host_str())
            .is_some_and(|(first, target)| first.eq_ignore_ascii_case(target))
        && initial.port_or_known_default() == next.port_or_known_default()
}

/// Shared redirect policy for every reqwest client that touches
/// addon-controlled URLs. Violations fail the request with a static,
/// credential-free message rather than surfacing a 3xx response as success.
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
