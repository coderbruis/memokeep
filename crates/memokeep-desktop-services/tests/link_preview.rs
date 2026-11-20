use memokeep_desktop_services::link_preview::{fetch, fetch_image, is_public_address, parse_html};
use std::{error::Error, net::IpAddr};

#[test]
fn address_policy_blocks_private_reserved_and_encoded_transition_networks(
) -> Result<(), Box<dyn Error>> {
    for value in [
        "0.1.2.3",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.31.1.1",
        "192.0.0.9",
        "192.0.2.1",
        "192.168.1.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "::ffff:8.8.8.8",
        "::ffff:127.0.0.1",
        "64:ff9b::7f00:1",
        "64:ff9b:1::a00:1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "2001:db8::1",
        "2001::1",
        "2002:7f00:1::",
        "3fff::1",
    ] {
        assert!(
            !is_public_address(value.parse::<IpAddr>()?),
            "accepted {value}"
        );
    }
    for value in [
        "1.1.1.1",
        "8.8.8.8",
        "93.184.216.34",
        "2606:4700:4700::1111",
        "2001:4860:4860::8888",
    ] {
        assert!(
            is_public_address(value.parse::<IpAddr>()?),
            "rejected {value}"
        );
    }
    Ok(())
}

#[test]
fn malformed_or_private_urls_fail_before_any_cache_or_network_access() {
    let impossible_database = std::path::Path::new("/does-not-exist/link-cache.sqlite3");
    for value in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,x",
        "https://user:password@example.com/",
        "http://localhost/",
        "http://localhost./",
        "http://sub.localhost/",
        "http://device.local/",
        "http://2130706433/",
        "http://0x7f000001/",
        "http://127.1/",
        "http://[::ffff:7f00:1]/",
        "http://example.com:0/",
    ] {
        for refresh in [false, true] {
            let error = fetch(impossible_database, value, refresh)
                .err()
                .map(|error| error.to_string());
            assert!(
                error
                    .as_deref()
                    .is_some_and(|error| error.contains("不支持")),
                "{value} (refresh={refresh}): {error:?}"
            );
        }
    }
}

#[test]
fn metadata_preserves_legacy_priority_entities_limits_and_relative_images(
) -> Result<(), Box<dyn Error>> {
    let result = parse_html("<title>fallback</title><meta property='og:title' content='  中文 &amp; title\n '><meta property='og:title' content='ignored'><meta name='twitter:title' content='twitter'><meta name='description' content='fallback desc'><meta property='og:description' content='preferred desc'><meta property='og:site_name' content='站点'><meta property='og:image' content='../cover.png'>", "https://example.com/final/page")?;
    assert_eq!(result.title, "中文 & title");
    assert_eq!(result.description, "preferred desc");
    assert_eq!(result.site, "站点");
    assert_eq!(result.image, "https://example.com/cover.png");
    let result = parse_html(
        &format!(
            "<title>{}</title><meta name='description' content='{}'>",
            "文".repeat(400),
            "😀".repeat(800)
        ),
        "https://example.com/",
    )?;
    assert_eq!(result.title.chars().count(), 300);
    assert_eq!(result.description.chars().count(), 600);
    Ok(())
}

#[test]
fn images_never_return_executable_or_private_literal_urls() -> Result<(), Box<dyn Error>> {
    for image in [
        "javascript:alert(1)",
        "data:image/png,x",
        "file:///secret",
        "http://127.0.0.1/private",
        "http://[::ffff:127.0.0.1]/private",
        "https://user:password@example.com/",
    ] {
        let result = parse_html(
            &format!("<title>page</title><meta property='og:image' content='{image}'>"),
            "https://example.com/",
        )?;
        assert!(result.image.is_empty(), "accepted {image}");
    }
    let result = parse_html("<link rel='shortcut icon' href='/favicon.ico'><title>&lt;script&gt;literal&lt;/script&gt;</title>", "https://example.com/path/")?;
    assert_eq!(result.title, "<script>literal</script>");
    assert_eq!(result.site, "example.com");
    assert_eq!(result.image, "https://example.com/favicon.ico");
    Ok(())
}

#[test]
fn production_cover_fetch_never_has_a_private_network_exception() {
    for address in [
        "http://127.0.0.1/test.png",
        "http://[::1]/test.png",
        "http://[::ffff:7f00:1]/test.png",
        "http://localhost/test.png",
        "file:///tmp/cover.png",
        "data:image/png;base64,x",
    ] {
        assert!(fetch_image(address).is_err(), "accepted {address}");
    }
}
