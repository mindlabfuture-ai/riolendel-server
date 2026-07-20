/**
 * Shopee Video Downloader — takes ONE Shopee product/video URL that
 * the admin explicitly pastes in, fetches the page, extracts the
 * underlying video file, and downloads it. This is the same action as
 * pasting a link into SnapTik/SSSTik manually — just built into this
 * dashboard instead of a third-party site. It is NOT a crawler: it
 * only ever touches the one URL you give it, on demand, one at a time.
 *
 * How it works: Shopee has no public "get video URL" API, so this
 * fetches the product page's HTML and pattern-matches for the embedded
 * video file (Shopee typically serves these from a *.shopeemobile.com
 * or *.shopeevideo.com CDN as an .mp4). This is inherently a bit
 * fragile — Shopee can change their page markup without notice, which
 * would break the regex patterns below. When that happens, the
 * function returns a clear error rather than silently failing, and the
 * admin can fall back to a manual downloader tool for that one video.
 *
 * Nothing here bypasses login walls, paywalls, or private content —
 * it only reads what's already publicly rendered on the product page.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const VIDEO_DIR = path.join(__dirname, '..', 'public', 'uploads', 'videos');

function ensureDir() {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
}

function isShopeeUrl(url) {
  return /shopee\.(ph|com|sg|co|com\.my|com\.vn|com\.br|co\.id|tw)/i.test(String(url || ''));
}

/**
 * Best-effort extraction of a direct video file URL from a Shopee
 * product page's HTML. Tries several known patterns since Shopee's
 * page structure varies by region/product type and can change.
 */
function extractVideoUrlFromHtml(html) {
  const patterns = [
    // Common Shopee video CDN hosts, referenced as a full URL in embedded JSON
    /"(https?:\/\/[^"]*\.(?:shopeemobile|shopeevideo|shopeesz)\.com\/[^"]*\.mp4[^"]*)"/i,
    // Generic "video_url" / "videoUrl" JSON keys
    /"video_?[Uu]rl"\s*:\s*"([^"]+\.mp4[^"]*)"/,
    // Any quoted .mp4 URL as a last resort
    /"(https?:\/\/[^"]+\.mp4[^"]*)"/i,
  ];

  for (const re of patterns) {
    const match = html.match(re);
    if (match && match[1]) {
      // Unescape any \/ sequences from embedded JSON
      return match[1].replace(/\\\//g, '/');
    }
  }
  return null;
}

/**
 * Fetch a Shopee page and pull out the video URL. Returns
 * { ok, videoUrl, error }.
 */
async function findVideoUrl(pageUrl) {
  if (!isShopeeUrl(pageUrl)) {
    return { ok: false, error: 'That doesn\'t look like a Shopee URL.' };
  }

  try {
    const res = await fetch(pageUrl, {
      headers: {
        // A normal browser UA — Shopee's page may serve different
        // markup (or block the request) without one.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
    if (!res.ok) {
      return { ok: false, error: `Shopee page returned ${res.status} — the link may be invalid, region-locked, or removed.` };
    }
    const html = await res.text();
    const videoUrl = extractVideoUrlFromHtml(html);
    if (!videoUrl) {
      return {
        ok: false,
        error: 'Could not find a video on that page. Either this product has no video, or Shopee changed their page markup since this was built. Try a manual downloader (e.g. a browser "save video" extension) for this one instead.',
      };
    }
    return { ok: true, videoUrl };
  } catch (err) {
    return { ok: false, error: `Failed to fetch the Shopee page: ${err.message}` };
  }
}

/** Download a direct video file URL to public/uploads/videos. Returns { ok, filePath, publicUrl }. */
async function downloadVideoFile(videoUrl) {
  ensureDir();
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) return { ok: false, error: `Video file request failed (${res.status}).` };

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 200 * 1024 * 1024) {
      return { ok: false, error: 'Video file is over 200MB — too large to download automatically.' };
    }

    const filename = `${uuidv4()}.mp4`;
    const destPath = path.join(VIDEO_DIR, filename);
    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer));

    return { ok: true, filePath: destPath, publicUrl: `/uploads/videos/${filename}` };
  } catch (err) {
    return { ok: false, error: `Download failed: ${err.message}` };
  }
}

/**
 * Full pipeline: given a Shopee product/video page URL, find and
 * download the video. Returns { ok, video: {url, filePath}, error }.
 * Does NOT extract frames — call videoProcessor.extractFrames on the
 * result separately, same as the manual-upload path does, so both
 * paths share one frame-extraction implementation.
 */
async function downloadFromShopeeUrl(pageUrl) {
  const found = await findVideoUrl(pageUrl);
  if (!found.ok) return { ok: false, error: found.error };

  const downloaded = await downloadVideoFile(found.videoUrl);
  if (!downloaded.ok) return { ok: false, error: downloaded.error };

  return { ok: true, video: { url: downloaded.publicUrl, filePath: downloaded.filePath } };
}

module.exports = { isShopeeUrl, findVideoUrl, downloadVideoFile, downloadFromShopeeUrl };
