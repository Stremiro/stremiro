use super::*;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

const SRT: &[u8] = b"1\n00:00:00,000 --> 00:00:05,000\nSubtitle\n";

fn listener() -> (TcpListener, Url) {
    crate::providers::ensure_rustls_crypto_provider();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = Url::parse(&format!(
        "http://127.0.0.1:{}/sub.srt",
        listener.local_addr().unwrap().port()
    ))
    .unwrap();
    (listener, url)
}

fn accept(listener: &TcpListener) -> TcpStream {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                return stream;
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(2))
            }
            Err(error) => panic!("fixture connection failed: {error}"),
        }
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 16 * 1024);
    }
    String::from_utf8(bytes).unwrap()
}

fn client() -> Client {
    crate::providers::ensure_rustls_crypto_provider();
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

#[tokio::test]
async fn stalled_download_leaves_native_controls_free_and_cancels_on_playback_change() {
    let (listener, url) = listener();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let mut stream = accept(&listener);
        read_request(&mut stream);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1024\r\nConnection: close\r\n\r\n1\n")
            .unwrap();
        started_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(2));
    });
    let session = Arc::new(SubtitleSession::new());
    let mut request = session.begin();
    let pending = tokio::spawn(async move {
        request
            .download_with(&client(), url, HeaderMap::new(), Duration::from_secs(2))
            .await
    });
    started_rx.await.unwrap();
    tokio::time::timeout(
        Duration::from_secs(1),
        super::super::run_mpv_op("subtitle control regression", || Ok(())),
    )
    .await
    .expect("a subtitle download must not own the native gate")
    .unwrap();
    session.cancel();
    let result = tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap_err(), CANCELLED);
    release_tx.send(()).unwrap();
    server.join().unwrap();
}

#[tokio::test]
async fn trickling_body_obeys_one_total_deadline() {
    let (listener, url) = listener();
    let server = std::thread::spawn(move || {
        let mut stream = accept(&listener);
        read_request(&mut stream);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1024\r\nConnection: close\r\n\r\n")
            .unwrap();
        for _ in 0..20 {
            if stream.write_all(b"x").is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let session = SubtitleSession::new();
    let error = session
        .begin()
        .download_with(&client(), url, HeaderMap::new(), Duration::from_millis(100))
        .await
        .map(|bytes| bytes.len())
        .expect_err("the fixture must be rejected");
    assert_eq!(error, "Subtitle download timed out.");
    server.join().unwrap();
}

#[tokio::test]
async fn subtitle_body_limit_applies_with_and_without_content_length() {
    for declared in [false, true] {
        let (listener, url) = listener();
        let server = std::thread::spawn(move || {
            let mut stream = accept(&listener);
            read_request(&mut stream);
            let length = if declared {
                format!("Content-Length: {}\r\n", MAX_SUBTITLE_BYTES + 1)
            } else {
                String::new()
            };
            write!(
                stream,
                "HTTP/1.1 200 OK\r\n{length}Connection: close\r\n\r\n"
            )
            .unwrap();
            let block = vec![b'x'; 64 * 1024];
            for _ in 0..=MAX_SUBTITLE_BYTES / block.len() {
                if stream.write_all(&block).is_err() {
                    break;
                }
            }
        });
        let session = SubtitleSession::new();
        let error = session
            .begin()
            .download_with(&client(), url, HeaderMap::new(), Duration::from_secs(2))
            .await
            .map(|bytes| bytes.len())
            .expect_err("the fixture must be rejected");
        assert!(error.contains("8 MiB"), "declared={declared}: {error}");
        server.join().unwrap();
    }
}

#[tokio::test]
async fn redirects_preserve_same_origin_headers_and_strip_them_on_cross_origin() {
    let (first, url) = listener();
    let (second, _) = listener();
    let address = second.local_addr().unwrap();
    let first_server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for location in [
            "/next".to_string(),
            format!("http://other.test:{}/sub.srt", address.port()),
        ] {
            let mut stream = accept(&first);
            requests.push(read_request(&mut stream));
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        }
        requests
    });
    let second_server = std::thread::spawn(move || {
        let mut stream = accept(&second);
        let request = read_request(&mut stream);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            SRT.len()
        )
        .unwrap();
        stream.write_all(SRT).unwrap();
        request
    });
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve("other.test", address)
        .build()
        .unwrap();
    let headers = request_headers(r"Authorization: fixture\,token,X-Custom: a\\b");
    let bytes = SubtitleSession::new()
        .begin()
        .download_with(&client, url, headers, Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(bytes, SRT);
    for request in first_server.join().unwrap() {
        assert!(request.contains("authorization: fixture,token"));
        assert!(request.contains("x-custom: a\\b"));
    }
    let cross_origin = second_server.join().unwrap();
    assert!(!cross_origin.contains("authorization:"));
    assert!(!cross_origin.contains("x-custom:"));
}

#[tokio::test]
async fn blocked_redirects_never_reach_the_target() {
    let (first, url) = listener();
    let (blocked, target) = listener();
    let server = std::thread::spawn(move || {
        let mut stream = accept(&first);
        read_request(&mut stream);
        write!(stream, "HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    // A different loopback port is outside the initial trusted local origin.
    let error = SubtitleSession::new()
        .begin()
        .download_with(&client(), url, HeaderMap::new(), Duration::from_secs(2))
        .await
        .map(|bytes| bytes.len())
        .expect_err("the fixture must be rejected");
    assert!(error.contains("blocked"));
    blocked.set_nonblocking(true).unwrap();
    assert_eq!(
        blocked.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    server.join().unwrap();
}

#[test]
fn replacement_invalidates_old_requests_even_when_the_same_stream_returns() {
    let session = SubtitleSession::new();
    let first = session.begin();
    session.cancel();
    let second = session.begin();
    assert!(first.ensure_current().is_err());
    assert!(second.ensure_current().is_ok());
    session.cancel();
    assert!(second.ensure_current().is_err());
}

#[test]
fn staged_subtitle_preserves_encoding_identity_and_native_lifetime() {
    let mut utf16 = vec![0xff, 0xfe];
    for unit in String::from_utf8_lossy(SRT).encode_utf16() {
        utf16.extend(unit.to_le_bytes());
    }
    for bytes in [
        SRT.to_vec(),
        utf16,
        b"\xef\xbb\xbfWEBVTT\n\n00:00.000 --> 00:05.000\nCue\n".to_vec(),
        b"1\n00:00:00,000 --> 00:00:05,000\nSubtitle \xff\n".to_vec(),
        b"WEBVTT\n\n00:00.000 --> 00:05.000\nCue\n".to_vec(),
        b"WEBVTT\tcomment\n\n00:00.000 --> 00:05.000\nCue\n".to_vec(),
        b"[Script Info]\nTitle: Fixture\n[Events]\n".to_vec(),
    ] {
        let session = SubtitleSession::new();
        let input = SubtitleInput::create(&bytes).unwrap();
        let path = input.path.clone();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let url = "https://subs.example/sub.srt?token=fixture";
        let native_path = session.register(url.to_string(), &input);
        assert_eq!(session.original_url(native_path), url);
        session.cancel();
        assert!(
            path.exists(),
            "cancelling must not remove a native input still in use"
        );
        session.clear_tracks();
        assert!(path.exists());
        drop(input);
        assert!(!path.exists());
    }
    for bytes in [
        b"".as_slice(),
        b"<html>Server error</html>",
        b"#EXTM3U\nhttp://localhost/stall",
        b"PK\x03\x04archive",
        b"[Reference]\nRef1=http://localhost/stall",
    ] {
        assert!(SubtitleInput::create(bytes).is_err());
    }
}
