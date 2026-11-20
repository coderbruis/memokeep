//! Bounded, user-requested link metadata. Only the cache is kept between calls.
use std::{
    collections::BTreeMap,
    io::{Cursor, Read},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::Path,
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use dom_query::Document;
use encoding_rs::{Encoding, UTF_8};
use reqwest::{
    blocking::{Client, Response},
    dns::{Addrs, Name, Resolve, Resolving},
    header::{ACCEPT, ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_TYPE, LOCATION, USER_AGENT},
    redirect::Policy,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::{Host, Url};

const MAX_BODY: u64 = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 512 * 1024;
const MAX_IMAGE_PIXELS: u64 = 16_000_000;
const MAX_REDIRECTS: usize = 5;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CACHE_TTL: i64 = 60 * 60 * 1000;
const CACHE_ROWS: usize = 100;

// This is only an execution limit; URL content and cache state live in SQLite.
static REQUESTS: RequestGate = RequestGate {
    active: Mutex::new(0),
    ready: Condvar::new(),
};

struct RequestGate {
    active: Mutex<usize>,
    ready: Condvar,
}
struct RequestPermit<'a>(&'a RequestGate);

impl RequestGate {
    fn acquire(&self, budget: Duration) -> Result<RequestPermit<'_>, PreviewError> {
        let start = Instant::now();
        let mut active = self.active.lock().map_err(|_| PreviewError::Unavailable)?;
        while *active >= 4 {
            let remaining = budget
                .checked_sub(start.elapsed())
                .ok_or(PreviewError::Timeout)?;
            let (next, status) = self
                .ready
                .wait_timeout(active, remaining)
                .map_err(|_| PreviewError::Unavailable)?;
            active = next;
            if status.timed_out() && *active >= 4 {
                return Err(PreviewError::Timeout);
            }
        }
        *active += 1;
        Ok(RequestPermit(self))
    }
}

impl Drop for RequestPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = active.saturating_sub(1);
            self.0.ready.notify_one();
        }
    }
}

#[derive(Debug, Error)]
pub enum PreviewError {
    #[error("不支持此链接")]
    InvalidUrl,
    #[error("不支持访问本机、私有网络或保留地址")]
    PrivateAddress,
    #[error("读取网页超时")]
    Timeout,
    #[error("网页暂时无法读取")]
    Unavailable,
    #[error("链接封面不是受支持的图片")]
    InvalidImage,
    #[error("链接封面过大")]
    ImageTooLarge,
    #[error("重定向次数过多")]
    RedirectLimit,
    #[error("网页过大")]
    TooLarge,
    #[error("网页未按请求返回未压缩内容")]
    UnsupportedEncoding,
    #[error("无法连接网页：{0}")]
    Network(#[from] reqwest::Error),
    #[error("无法读取网页：{0}")]
    Io(#[from] std::io::Error),
    #[error("链接预览缓存无法读取：{0}")]
    Sql(#[from] rusqlite::Error),
    #[error("链接预览缓存格式错误：{0}")]
    Json(#[from] serde_json::Error),
    #[error("系统时钟无效")]
    Clock,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Preview {
    pub title: String,
    pub description: String,
    pub site: String,
    pub image: String,
}

fn v4_prefix(ip: Ipv4Addr, base: [u8; 4], bits: u32) -> bool {
    let mask = u32::MAX << (32 - bits);
    u32::from(ip) & mask == u32::from(Ipv4Addr::from(base)) & mask
}

fn v6_prefix(ip: Ipv6Addr, base: Ipv6Addr, bits: u32) -> bool {
    let mask = u128::MAX << (128 - bits);
    u128::from(ip) & mask == u128::from(base) & mask
}

/// Conservative Internet-only policy. Transition and special-use networks are
/// rejected as well, so an IPv4 target cannot be hidden inside IPv6 syntax.
pub fn is_public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ![
            ([0, 0, 0, 0], 8),
            ([10, 0, 0, 0], 8),
            ([100, 64, 0, 0], 10),
            ([127, 0, 0, 0], 8),
            ([169, 254, 0, 0], 16),
            ([172, 16, 0, 0], 12),
            ([192, 0, 0, 0], 24),
            ([192, 0, 2, 0], 24),
            ([192, 88, 99, 0], 24),
            ([192, 168, 0, 0], 16),
            ([198, 18, 0, 0], 15),
            ([198, 51, 100, 0], 24),
            ([203, 0, 113, 0], 24),
            ([224, 0, 0, 0], 3),
        ]
        .into_iter()
        .any(|(base, bits)| v4_prefix(ip, base, bits)),
        IpAddr::V6(ip) => {
            v6_prefix(ip, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3)
                && !v6_prefix(ip, Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23)
                && !v6_prefix(ip, Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32)
                && !v6_prefix(ip, Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16)
                && !v6_prefix(ip, Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20)
        }
    }
}

fn checked_url(input: &str, base: Option<&Url>) -> Result<Url, PreviewError> {
    if input.len() > 8192 {
        return Err(PreviewError::InvalidUrl);
    }
    let mut url = match base {
        Some(base) => base.join(input.trim()),
        None => Url::parse(input.trim()),
    }
    .map_err(|_| PreviewError::InvalidUrl)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port() == Some(0)
    {
        return Err(PreviewError::InvalidUrl);
    }
    match url.host().ok_or(PreviewError::InvalidUrl)? {
        Host::Ipv4(ip) if !is_public_address(ip.into()) => {
            return Err(PreviewError::PrivateAddress)
        }
        Host::Ipv6(ip) if !is_public_address(ip.into()) => {
            return Err(PreviewError::PrivateAddress)
        }
        Host::Domain(name)
            if name.trim_end_matches('.').eq_ignore_ascii_case("localhost")
                || name
                    .trim_end_matches('.')
                    .to_ascii_lowercase()
                    .ends_with(".localhost")
                || name
                    .trim_end_matches('.')
                    .to_ascii_lowercase()
                    .ends_with(".local") =>
        {
            return Err(PreviewError::PrivateAddress)
        }
        _ => {}
    }
    url.set_fragment(None);
    Ok(url)
}

struct PublicResolver;

fn checked_addresses(
    resolved: Vec<std::net::SocketAddr>,
) -> Result<Addrs, Box<dyn std::error::Error + Send + Sync>> {
    if resolved.is_empty() || resolved.iter().any(|addr| !is_public_address(addr.ip())) {
        return Err(Box::new(PreviewError::PrivateAddress));
    }
    Ok(Box::new(resolved.into_iter()))
}

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        // The future owns only the hostname until this one connection resolves.
        let hostname = name.as_str().to_owned();
        Box::pin(async move {
            let resolved = tokio::time::timeout(
                Duration::from_secs(3),
                tokio::net::lookup_host((hostname.as_str(), 0)),
            )
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "DNS timeout"))??
            .collect::<Vec<_>>();
            // Return these exact checked addresses to Hyper's connector. There
            // is no second name lookup between validation and socket connect.
            checked_addresses(resolved)
        })
    }
}

fn client<R: Resolve + 'static>(resolver: Arc<R>) -> Result<Client, PreviewError> {
    if rustls::crypto::CryptoProvider::get_default().is_none()
        && rustls::crypto::ring::default_provider()
            .install_default()
            .is_err()
        && rustls::crypto::CryptoProvider::get_default().is_none()
    {
        return Err(PreviewError::Unavailable);
    }
    Ok(Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(3))
        .timeout(REQUEST_TIMEOUT)
        .pool_max_idle_per_host(0)
        .http1_only()
        .dns_resolver(resolver)
        .build()?)
}

fn charset(content_type: &str) -> Option<&'static Encoding> {
    content_type.split(';').skip(1).find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        key.eq_ignore_ascii_case("charset")
            .then(|| Encoding::for_label(value.trim().trim_matches(['\'', '"']).as_bytes()))
            .flatten()
    })
}

fn decode(bytes: &[u8], content_type: &str) -> Result<String, PreviewError> {
    let sample = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
    let document = Document::from(sample.as_ref());
    let meta = document.select("meta[charset]").attr("charset");
    let http_equiv = document.select("meta[http-equiv]").iter().find_map(|node| {
        let key = node.attr("http-equiv")?;
        if !key.eq_ignore_ascii_case("content-type") {
            return None;
        }
        charset(node.attr("content")?.as_ref())
    });
    let encoding = Encoding::for_bom(bytes)
        .map(|(encoding, _)| encoding)
        .or_else(|| charset(content_type))
        .or_else(|| {
            meta.as_ref()
                .and_then(|value| Encoding::for_label(value.as_bytes()))
        })
        .or(http_equiv)
        .unwrap_or(UTF_8);
    let (text, _, _) = encoding.decode(bytes);
    if text.len() as u64 > MAX_BODY {
        return Err(PreviewError::TooLarge);
    }
    Ok(text.into_owned())
}

fn body(response: Response) -> Result<String, PreviewError> {
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    if !matches!(
        content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "text/html" | "application/xhtml+xml"
    ) {
        return Err(PreviewError::Unavailable);
    }
    let bytes = read_bytes(response, MAX_BODY)?;
    decode(&bytes, &content_type)
}

fn read_bytes(mut response: Response, limit: u64) -> Result<Vec<u8>, PreviewError> {
    if response
        .headers()
        .get_all(CONTENT_ENCODING)
        .iter()
        .any(|value| {
            value
                .to_str()
                .map_or(true, |value| !value.trim().eq_ignore_ascii_case("identity"))
        })
    {
        return Err(PreviewError::UnsupportedEncoding);
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(PreviewError::TooLarge);
    }
    let mut bytes = Vec::new();
    (&mut response).take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(PreviewError::TooLarge);
    }
    Ok(bytes)
}

#[cfg(test)]
fn read_page(client: &Client, url: Url) -> Result<Preview, PreviewError> {
    read_page_with_budget(client, url, REQUEST_TIMEOUT)
}

fn read_page_with_budget(
    client: &Client,
    url: Url,
    budget: Duration,
) -> Result<Preview, PreviewError> {
    let (response, final_url) =
        read_response(client, url, budget, "text/html,application/xhtml+xml")?;
    parse_html(&body(response)?, final_url.as_str())
}

fn read_response(
    client: &Client,
    mut url: Url,
    budget: Duration,
    accept: &str,
) -> Result<(Response, Url), PreviewError> {
    let start = Instant::now();
    for count in 0..=MAX_REDIRECTS {
        let remaining = budget
            .checked_sub(start.elapsed())
            .ok_or(PreviewError::Timeout)?;
        let response = client
            .get(url.as_str())
            .timeout(remaining)
            .header(
                USER_AGENT,
                "Mozilla/5.0 (compatible; MemoKeep/1.0; LinkPreview)",
            )
            .header(ACCEPT, accept)
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .map_err(|error| {
                if error.is_timeout() {
                    PreviewError::Timeout
                } else {
                    PreviewError::Network(error.without_url())
                }
            })?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            if count == MAX_REDIRECTS {
                return Err(PreviewError::RedirectLimit);
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(PreviewError::Unavailable)?;
            url = checked_url(location, Some(&url))?;
            continue;
        }
        if response.status().as_u16() != 200 {
            return Err(PreviewError::Unavailable);
        }
        return Ok((response, url));
    }
    Err(PreviewError::RedirectLimit)
}

fn clean(value: &str, max: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// Metadata parsing performs no network access and never executes page scripts.
pub fn parse_html(html: &str, address: &str) -> Result<Preview, PreviewError> {
    if html.len() as u64 > MAX_BODY {
        return Err(PreviewError::TooLarge);
    }
    let url = checked_url(address, None)?;
    let document = Document::from(html);
    let mut values = BTreeMap::new();
    for meta in document.select("meta").iter() {
        let key = meta
            .attr("property")
            .filter(|value| !value.is_empty())
            .or_else(|| meta.attr("name"));
        if let Some(key) = key {
            values.entry(key.to_ascii_lowercase()).or_insert_with(|| {
                meta.attr("content")
                    .map(|v| v.to_string())
                    .unwrap_or_default()
            });
        }
    }
    let field = |names: &[&str]| -> String {
        names
            .iter()
            .find_map(|name| values.get(*name).filter(|value| !value.is_empty()))
            .map(String::to_owned)
            .unwrap_or_default()
    };
    let icon = document.select("link[href]").iter().find_map(|node| {
        node.attr("rel")?
            .split_ascii_whitespace()
            .any(|rel| rel.eq_ignore_ascii_case("icon"))
            .then(|| node.attr("href").map(|v| v.to_string()))
            .flatten()
    });
    let image = field(&["og:image", "twitter:image"]);
    let raw_image = if image.is_empty() {
        icon.as_deref().unwrap_or("")
    } else {
        &image
    };
    let image = checked_url(raw_image, Some(&url))
        .ok()
        .filter(|_| !raw_image.is_empty())
        .map(|url| url.to_string())
        .unwrap_or_default();
    let title = field(&["og:title", "twitter:title"]);
    let title = if title.is_empty() {
        document.select_single("title").text().to_string()
    } else {
        title
    };
    let site = field(&["og:site_name"]);
    Ok(Preview {
        title: clean(&title, 300),
        description: clean(
            &field(&["og:description", "twitter:description", "description"]),
            600,
        ),
        site: clean(
            if site.is_empty() {
                url.host_str().unwrap_or("")
            } else {
                &site
            },
            100,
        ),
        image,
    })
}

fn cache(database: &Path) -> Result<Connection, PreviewError> {
    let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    connection.busy_timeout(Duration::from_secs(2))?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS desktop_link_preview_cache(url TEXT PRIMARY KEY,fetched_at INTEGER NOT NULL,payload TEXT NOT NULL)")?;
    Ok(connection)
}

fn cached(database: &Path, url: &str, now: i64) -> Result<Option<Preview>, PreviewError> {
    let database = cache(database)?;
    let row: Option<(i64, String)> = database
        .query_row(
            "SELECT fetched_at,payload FROM desktop_link_preview_cache WHERE url=?1",
            [url],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row
        .filter(|(at, _)| now >= *at && now.saturating_sub(*at) < CACHE_TTL)
        .and_then(|(_, value)| serde_json::from_str(&value).ok()))
}

fn save_cache(database: &Path, url: &str, preview: &Preview, now: i64) -> Result<(), PreviewError> {
    let mut database = cache(database)?;
    let tx = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute("INSERT INTO desktop_link_preview_cache VALUES(?1,?2,?3) ON CONFLICT(url) DO UPDATE SET fetched_at=excluded.fetched_at,payload=excluded.payload", params![url, now, serde_json::to_string(preview)?])?;
    tx.execute("DELETE FROM desktop_link_preview_cache WHERE url NOT IN (SELECT url FROM desktop_link_preview_cache ORDER BY fetched_at DESC,rowid DESC LIMIT ?1)", [CACHE_ROWS])?;
    tx.commit()?;
    Ok(())
}

/// Fetches one link only when explicitly requested by a permitted desktop view.
/// An explicit refresh bypasses the cache; errors are returned without a stale fallback.
pub fn fetch(database: &Path, input: &str, refresh: bool) -> Result<Preview, PreviewError> {
    fetch_with_client(database, input, refresh, || {
        client(Arc::new(PublicResolver))
    })
}

fn fetch_with_client(
    database: &Path,
    input: &str,
    refresh: bool,
    create_client: impl FnOnce() -> Result<Client, PreviewError>,
) -> Result<Preview, PreviewError> {
    let started = Instant::now();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| PreviewError::Clock)?
        .as_millis()
        .min(i64::MAX as u128) as i64;
    let url = checked_url(input, None)?;
    if !refresh {
        if let Some(value) = cached(database, url.as_str(), now)? {
            return Ok(value);
        }
    }
    let remaining = REQUEST_TIMEOUT
        .checked_sub(started.elapsed())
        .ok_or(PreviewError::Timeout)?;
    let _permit = REQUESTS.acquire(remaining)?;
    let client = create_client()?;
    let remaining = REQUEST_TIMEOUT
        .checked_sub(started.elapsed())
        .ok_or(PreviewError::Timeout)?;
    let preview = read_page_with_budget(&client, url, remaining)?;
    let key = checked_url(input, None)?;
    save_cache(database, key.as_str(), &preview, now)?;
    Ok(preview)
}

/// Fetch a cover through the same validated connector as its page. The original
/// URL stays in note data; the view receives only a bounded raster data URI.
pub fn fetch_image(input: &str) -> Result<String, PreviewError> {
    let started = Instant::now();
    let url = checked_url(input, None)?;
    let _permit = REQUESTS.acquire(REQUEST_TIMEOUT)?;
    let client = client(Arc::new(PublicResolver))?;
    let remaining = REQUEST_TIMEOUT
        .checked_sub(started.elapsed())
        .ok_or(PreviewError::Timeout)?;
    read_image(&client, url, remaining)
}

fn read_image(client: &Client, url: Url, budget: Duration) -> Result<String, PreviewError> {
    let (response, _) = read_response(
        client,
        url,
        budget,
        "image/png,image/jpeg,image/gif,image/webp",
    )?;
    let declared = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        declared.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Err(PreviewError::InvalidImage);
    }
    let bytes = read_bytes(response, MAX_IMAGE_BYTES).map_err(|error| {
        if matches!(error, PreviewError::TooLarge) {
            PreviewError::ImageTooLarge
        } else {
            error
        }
    })?;
    raster_data_uri(&bytes, &declared)
}

fn raster_data_uri(bytes: &[u8], declared: &str) -> Result<String, PreviewError> {
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(PreviewError::ImageTooLarge);
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| PreviewError::InvalidImage)?;
    let mime = match reader.format() {
        Some(image::ImageFormat::Png) => "image/png",
        Some(image::ImageFormat::Jpeg) => "image/jpeg",
        Some(image::ImageFormat::Gif) => "image/gif",
        Some(image::ImageFormat::WebP) => "image/webp",
        _ => return Err(PreviewError::InvalidImage),
    };
    if declared != mime {
        return Err(PreviewError::InvalidImage);
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(8 * 1024 * 1024);
    reader.limits(limits);
    let (width, height) = reader.into_dimensions().map_err(|error| {
        if matches!(error, image::ImageError::Limits(_)) {
            PreviewError::ImageTooLarge
        } else {
            PreviewError::InvalidImage
        }
    })?;
    if width == 0
        || height == 0
        || width > 4096
        || height > 4096
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return Err(PreviewError::ImageTooLarge);
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        error::Error,
        io::Write,
        net::{SocketAddr, TcpListener},
        thread::{self, JoinHandle},
    };

    type TestResult = Result<(), Box<dyn Error>>;
    type Server = JoinHandle<std::io::Result<Vec<String>>>;

    // This resolver is compiled only into unit tests; the product fetch entry
    // always constructs PublicResolver and cannot opt out of its policy.
    struct LocalFixture(SocketAddr);
    impl Resolve for LocalFixture {
        fn resolve(&self, _: Name) -> Resolving {
            let address = self.0;
            Box::pin(async move { Ok(Box::new(vec![address].into_iter()) as Addrs) })
        }
    }

    fn server(responses: Vec<Vec<u8>>, delay: Duration) -> std::io::Result<(SocketAddr, Server)> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let address = listener.local_addr()?;
        listener.set_nonblocking(true)?;
        let worker = thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let waiting = Instant::now();
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(stream) => break stream,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && waiting.elapsed() < Duration::from_secs(3) =>
                        {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(error) => return Err(error),
                    }
                };
                stream.set_nonblocking(false)?;
                stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                stream.set_write_timeout(Some(Duration::from_secs(2)))?;
                let mut request = Vec::new();
                loop {
                    let mut byte = [0];
                    if stream.read(&mut byte)? == 0 {
                        break;
                    }
                    request.push(byte[0]);
                    if request.ends_with(b"\r\n\r\n") || request.len() > 8192 {
                        break;
                    }
                }
                requests.push(String::from_utf8_lossy(&request).into_owned());
                thread::sleep(delay);
                // Closing a deliberately rejected response early is valid.
                if let Err(error) = stream.write_all(&response) {
                    if !matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                    ) {
                        return Err(error);
                    }
                }
            }
            Ok(requests)
        });
        Ok((address, worker))
    }

    fn response(status: &str, headers: &str, content: &[u8]) -> Vec<u8> {
        let mut output =
            format!("HTTP/1.1 {status}\r\nConnection: close\r\n{headers}\r\n").into_bytes();
        output.extend_from_slice(content);
        output
    }

    fn fixture_client(address: SocketAddr) -> Result<Client, PreviewError> {
        client(Arc::new(LocalFixture(address)))
    }

    fn join(worker: Server) -> Result<Vec<String>, Box<dyn Error>> {
        Ok(worker
            .join()
            .map_err(|_| std::io::Error::other("mock HTTP server panicked"))??)
    }

    #[test]
    fn real_http_follows_relative_redirects_with_explicit_bounded_headers() -> TestResult {
        let (address, worker) = server(
            vec![
                response(
                    "302 Found",
                    "Location: /final/page\r\nContent-Length: 0\r\n",
                    b"",
                ),
                response(
                    "200 OK",
                    "Content-Type: text/html; charset=utf-8\r\n",
                    b"<title>Real HTTP</title><meta property='og:image' content='cover.png'>",
                ),
            ],
            Duration::ZERO,
        )?;
        let url = checked_url(
            &format!("http://fixture.test:{}/start", address.port()),
            None,
        )?;
        let preview = read_page(&fixture_client(address)?, url)?;
        assert_eq!(preview.title, "Real HTTP");
        assert_eq!(
            preview.image,
            format!("http://fixture.test:{}/final/cover.png", address.port())
        );
        let requests = join(worker)?;
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET /start HTTP/1.1"));
        assert!(requests[1].starts_with("GET /final/page HTTP/1.1"));
        for request in requests {
            let lowercase = request.to_ascii_lowercase();
            assert!(lowercase.contains("accept-encoding: identity\r\n"));
            assert!(lowercase.contains("accept: text/html,application/xhtml+xml\r\n"));
            assert!(lowercase.contains("linkpreview)"));
            assert!(!lowercase.contains("authorization:"));
            assert!(!lowercase.contains("cookie:"));
        }
        Ok(())
    }

    #[test]
    fn redirect_cannot_switch_to_private_literal_or_credentialed_target() -> TestResult {
        for target in [
            "http://127.0.0.1/secrets",
            "http://[::ffff:127.0.0.1]/",
            "http://user:password@public.test/",
        ] {
            let headers = format!("Location: {target}\r\nContent-Length: 0\r\n");
            let (address, worker) =
                server(vec![response("302 Found", &headers, b"")], Duration::ZERO)?;
            assert!(read_page(
                &fixture_client(address)?,
                checked_url(&format!("http://fixture.test:{}", address.port()), None)?
            )
            .is_err());
            assert_eq!(join(worker)?.len(), 1);
        }
        Ok(())
    }

    #[test]
    fn redirects_have_one_total_deadline_and_a_finite_hop_budget() -> TestResult {
        let responses = (0..6)
            .map(|_| {
                response(
                    "302 Found",
                    "Location: /again\r\nContent-Length: 0\r\n",
                    b"",
                )
            })
            .collect();
        let (address, worker) = server(responses, Duration::ZERO)?;
        assert!(matches!(
            read_page(
                &fixture_client(address)?,
                checked_url(&format!("http://fixture.test:{}", address.port()), None)?
            ),
            Err(PreviewError::RedirectLimit)
        ));
        assert_eq!(join(worker)?.len(), 6);

        let (address, worker) = server(
            vec![response(
                "200 OK",
                "Content-Type: text/html\r\n",
                b"<title>too late</title>",
            )],
            Duration::from_millis(150),
        )?;
        let start = Instant::now();
        assert!(matches!(
            read_page_with_budget(
                &fixture_client(address)?,
                checked_url(&format!("http://fixture.test:{}", address.port()), None)?,
                Duration::from_millis(40)
            ),
            Err(PreviewError::Timeout)
        ));
        assert!(start.elapsed() < Duration::from_secs(2));
        join(worker)?;
        Ok(())
    }

    #[test]
    fn rejects_non_html_compression_and_oversized_declared_or_chunked_bodies() -> TestResult {
        let cases = [
            response("200 OK", "Content-Type: image/png\r\n", b"not HTML"),
            response(
                "200 OK",
                "Content-Type: text/html\r\nContent-Encoding: gzip\r\n",
                b"not decoded",
            ),
            response(
                "200 OK",
                &format!(
                    "Content-Type: text/html\r\nContent-Length: {}\r\n",
                    MAX_BODY + 1
                ),
                b"",
            ),
        ];
        for bytes in cases {
            let (address, worker) = server(vec![bytes], Duration::ZERO)?;
            assert!(read_page(
                &fixture_client(address)?,
                checked_url(&format!("http://fixture.test:{}", address.port()), None)?
            )
            .is_err());
            join(worker)?;
        }
        let mut chunk = format!("{:x}\r\n", MAX_BODY + 1).into_bytes();
        chunk.extend(std::iter::repeat_n(b'x', MAX_BODY as usize + 1));
        chunk.extend_from_slice(b"\r\n0\r\n\r\n");
        let (address, worker) = server(
            vec![response(
                "200 OK",
                "Content-Type: text/html\r\nTransfer-Encoding: chunked\r\n",
                &chunk,
            )],
            Duration::ZERO,
        )?;
        let result = read_page(
            &fixture_client(address)?,
            checked_url(&format!("http://fixture.test:{}", address.port()), None)?,
        );
        assert!(matches!(result, Err(PreviewError::TooLarge)), "{result:?}");
        join(worker)?;
        Ok(())
    }

    #[test]
    fn encoding_supports_header_and_html_charset_without_losing_chinese() -> TestResult {
        let bytes = b"<meta charset='gbk'><title>\xd6\xd0\xce\xc4</title>";
        assert_eq!(
            parse_html(&decode(bytes, "text/html")?, "https://example.com/")?.title,
            "中文"
        );
        let bytes = b"<title>\xd6\xd0\xce\xc4</title>";
        assert_eq!(
            parse_html(
                &decode(bytes, "text/html; charset=gbk")?,
                "https://example.com/"
            )?
            .title,
            "中文"
        );
        Ok(())
    }

    #[test]
    fn cache_is_durable_expires_after_one_hour_and_has_a_hard_row_bound() -> TestResult {
        let file = tempfile::NamedTempFile::new()?;
        let preview = parse_html("<title>缓存</title>", "https://example.com/")?;
        save_cache(file.path(), "https://example.com/", &preview, 100)?;
        assert_eq!(
            cached(file.path(), "https://example.com/", 100)?.as_ref(),
            Some(&preview)
        );
        assert!(cached(file.path(), "https://example.com/", 99)?.is_none());
        assert!(cached(file.path(), "https://example.com/", 100 + CACHE_TTL)?.is_none());
        for n in 0..=100 {
            save_cache(
                file.path(),
                &format!("https://example.com/{n}"),
                &preview,
                1000 + n,
            )?;
        }
        let count: usize = cache(file.path())?.query_row(
            "SELECT count(*) FROM desktop_link_preview_cache",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(count, CACHE_ROWS);
        assert!(cached(file.path(), "https://example.com/0", 1100)?.is_none());
        assert!(cached(file.path(), "https://example.com/100", 1100)?.is_some());
        Ok(())
    }

    #[test]
    fn explicit_refresh_bypasses_cache_and_propagates_network_failure() -> TestResult {
        let file = tempfile::NamedTempFile::new()?;
        let (address, worker) = server(
            vec![
                response(
                    "200 OK",
                    "Content-Type: text/html; charset=utf-8\r\n",
                    b"<title>Fresh page</title>",
                ),
                response("503 Service Unavailable", "Content-Length: 0\r\n", b""),
            ],
            Duration::ZERO,
        )?;
        let url = format!("http://fixture.test:{}/page", address.port());
        let original = parse_html("<title>Cached page</title>", &url)?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64;
        save_cache(file.path(), &url, &original, now)?;

        // A valid ordinary cache hit must not even construct a network client.
        assert_eq!(
            fetch_with_client(file.path(), &url, false, || Err(PreviewError::Unavailable))?,
            original
        );
        let fresh = fetch_with_client(file.path(), &url, true, || fixture_client(address))?;
        assert_eq!(fresh.title, "Fresh page");
        assert_eq!(
            cached(file.path(), &url, now + 1000)?.as_ref(),
            Some(&fresh)
        );

        let failed_refresh = fetch_with_client(file.path(), &url, true, || fixture_client(address));
        assert!(failed_refresh.is_err(), "{failed_refresh:?}");
        // The existing note/cache remains usable, but is never a successful refresh response.
        assert_eq!(
            fetch_with_client(file.path(), &url, false, || Err(PreviewError::Unavailable))?,
            fresh
        );
        assert_eq!(join(worker)?.len(), 2);
        Ok(())
    }

    #[test]
    fn every_resolved_address_must_pass_before_any_connector_can_use_it() -> TestResult {
        assert!(checked_addresses(Vec::new()).is_err());
        assert!(checked_addresses(vec!["8.8.8.8:0".parse()?, "127.0.0.1:0".parse()?]).is_err());
        assert!(checked_addresses(vec![
            "[2606:4700::1111]:0".parse()?,
            "[::ffff:127.0.0.1]:0".parse()?
        ])
        .is_err());
        assert_eq!(
            checked_addresses(vec!["8.8.8.8:0".parse()?, "1.1.1.1:0".parse()?])
                .map_err(std::io::Error::other)?
                .count(),
            2
        );
        Ok(())
    }

    #[test]
    fn concurrency_gate_is_finite_and_releases_slots_on_drop() -> TestResult {
        let gate = RequestGate {
            active: Mutex::new(0),
            ready: Condvar::new(),
        };
        let first = gate.acquire(Duration::from_millis(100))?;
        let _second = gate.acquire(Duration::from_millis(100))?;
        let _third = gate.acquire(Duration::from_millis(100))?;
        let _fourth = gate.acquire(Duration::from_millis(100))?;
        assert!(matches!(
            gate.acquire(Duration::from_millis(20)),
            Err(PreviewError::Timeout)
        ));
        drop(first);
        assert!(gate.acquire(Duration::from_millis(100)).is_ok());
        Ok(())
    }
    fn tiny_image(format: image::ImageFormat) -> Result<Vec<u8>, image::ImageError> {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1, 1).write_to(&mut bytes, format)?;
        Ok(bytes.into_inner())
    }

    #[test]
    fn raster_signature_and_dimensions_are_checked_before_returning_data_uris() -> TestResult {
        for (format, mime) in [
            (image::ImageFormat::Png, "image/png"),
            (image::ImageFormat::Jpeg, "image/jpeg"),
            (image::ImageFormat::Gif, "image/gif"),
            (image::ImageFormat::WebP, "image/webp"),
        ] {
            let bytes = tiny_image(format)?;
            let result = raster_data_uri(&bytes, mime)?;
            assert_eq!(
                result,
                format!("data:{mime};base64,{}", STANDARD.encode(&bytes))
            );
        }
        let png = tiny_image(image::ImageFormat::Png)?;
        assert!(matches!(
            raster_data_uri(&png, "image/jpeg"),
            Err(PreviewError::InvalidImage)
        ));
        for value in [
            b"<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>".as_slice(),
            b"<html>not image</html>",
            b"GIF89a",
        ] {
            assert!(raster_data_uri(value, "image/png").is_err());
        }
        let oversized = vec![0; MAX_IMAGE_BYTES as usize + 1];
        assert!(matches!(
            raster_data_uri(&oversized, "image/png"),
            Err(PreviewError::ImageTooLarge)
        ));
        Ok(())
    }

    fn png_dimensions(mut bytes: Vec<u8>, width: u32, height: u32) -> Vec<u8> {
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        let mut crc = u32::MAX;
        for byte in &bytes[12..29] {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xedb88320
                } else {
                    crc >> 1
                };
            }
        }
        bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
        bytes
    }

    #[test]
    fn small_compressed_images_cannot_claim_huge_pixel_buffers() -> TestResult {
        for (width, height) in [(5000, 1), (1, 5000), (4096, 4096)] {
            let bytes = png_dimensions(tiny_image(image::ImageFormat::Png)?, width, height);
            assert!(bytes.len() < 1024);
            let result = raster_data_uri(&bytes, "image/png");
            assert!(
                matches!(result, Err(PreviewError::ImageTooLarge)),
                "{width}x{height}: {result:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn real_image_fetch_uses_bounded_http_connector_and_rejects_private_redirects() -> TestResult {
        let png = tiny_image(image::ImageFormat::Png)?;
        let (address, worker) = server(
            vec![
                response(
                    "302 Found",
                    "Location: /cover.png\r\nContent-Length: 0\r\n",
                    b"",
                ),
                response("200 OK", "Content-Type: image/png\r\n", &png),
            ],
            Duration::ZERO,
        )?;
        let result = read_image(
            &fixture_client(address)?,
            checked_url(
                &format!("http://fixture.test:{}/image", address.port()),
                None,
            )?,
            REQUEST_TIMEOUT,
        )?;
        assert_eq!(
            result,
            format!("data:image/png;base64,{}", STANDARD.encode(&png))
        );
        let requests = join(worker)?;
        assert_eq!(requests.len(), 2);
        assert!(requests[1].starts_with("GET /cover.png HTTP/1.1"));
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("accept: image/png,image/jpeg,image/gif,image/webp\r\n"));

        let (address, worker) = server(
            vec![response(
                "302 Found",
                "Location: http://127.0.0.1/private.png\r\nContent-Length: 0\r\n",
                b"",
            )],
            Duration::ZERO,
        )?;
        assert!(matches!(
            read_image(
                &fixture_client(address)?,
                checked_url(&format!("http://fixture.test:{}", address.port()), None)?,
                REQUEST_TIMEOUT
            ),
            Err(PreviewError::PrivateAddress)
        ));
        assert_eq!(join(worker)?.len(), 1);
        Ok(())
    }

    #[test]
    fn image_download_rejects_oversized_svg_fake_mime_and_compression() -> TestResult {
        let cases = [
            response("200 OK", "Content-Type: image/svg+xml\r\n", b"<svg/>"),
            response(
                "200 OK",
                "Content-Type: image/png\r\n",
                b"<html>fake image</html>",
            ),
            response(
                "200 OK",
                "Content-Type: image/png\r\nContent-Encoding: gzip\r\n",
                b"no unchecked decompression",
            ),
            response(
                "200 OK",
                &format!(
                    "Content-Type: image/png\r\nContent-Length: {}\r\n",
                    MAX_IMAGE_BYTES + 1
                ),
                b"",
            ),
        ];
        for bytes in cases {
            let (address, worker) = server(vec![bytes], Duration::ZERO)?;
            assert!(read_image(
                &fixture_client(address)?,
                checked_url(&format!("http://fixture.test:{}", address.port()), None)?,
                REQUEST_TIMEOUT
            )
            .is_err());
            join(worker)?;
        }
        Ok(())
    }
}
