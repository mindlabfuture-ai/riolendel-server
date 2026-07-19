/**
 * Video Scraper — admin-only tool for managing scraped video references.
 *
 * This does NOT auto-upload or auto-publish anything. The workflow is:
 *   1. Admin pastes a TikTok or Shopee video URL + metadata
 *   2. Video is saved as "draft" in the database
 *   3. Admin reviews, adds affiliate product links, sets status to "published"
 *   4. Published videos appear on the /shop page for visitors
 *
 * For actual video downloading/re-hosting, admin handles that externally
 * (e.g. SnapTik, SaveTT, or official TikTok download) and uploads the
 * thumbnail/clip to their own CDN or public/ folder, then pastes the
 * URL here.
 */

const db = require('./db');

// Validate and normalize a TikTok or Shopee video URL
function normalizeVideoUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  // TikTok patterns
  if (/tiktok\.com/i.test(trimmed)) return trimmed;
  if (/vm\.tiktok\.com/i.test(trimmed)) return trimmed;

  // Shopee patterns
  if (/shopee\.(ph|com|sg|co)/i.test(trimmed)) return trimmed;

  // YouTube (for review videos)
  if (/youtube\.com|youtu\.be/i.test(trimmed)) return trimmed;

  // Instagram reels
  if (/instagram\.com/i.test(trimmed)) return trimmed;

  // Generic URL — allow anything if it looks like a URL
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  return null;
}

// Extract platform from URL
function detectPlatform(url) {
  if (/tiktok\.com|vm\.tiktok/i.test(url)) return 'tiktok';
  if (/shopee\./i.test(url)) return 'shopee';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/instagram\.com/i.test(url)) return 'instagram';
  return 'other';
}

// Validate product link entries
function validateProductLinks(links) {
  if (!Array.isArray(links)) return [];
  return links
    .filter(l => l && l.url && typeof l.url === 'string')
    .map(l => ({
      url: l.url.trim(),
      platform: l.platform || detectPlatform(l.url),
      label: (l.label || '').trim().slice(0, 200),
      price: l.price || null,
    }));
}

async function addVideo({ videoUrl, thumbnailUrl, title, description, creator, tags, productLinks, notes }) {
  const normalizedUrl = normalizeVideoUrl(videoUrl);
  if (!normalizedUrl) {
    return { ok: false, error: 'Invalid video URL.' };
  }

  const platform = detectPlatform(normalizedUrl);
  const validatedLinks = validateProductLinks(productLinks);
  const tagList = Array.isArray(tags) ? tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20) : [];

  const result = await db.saveVideo({
    platform,
    videoUrl: normalizedUrl,
    thumbnailUrl: thumbnailUrl || null,
    title: title ? String(title).trim().slice(0, 500) : null,
    description: description ? String(description).trim().slice(0, 2000) : null,
    creator: creator ? String(creator).trim().slice(0, 200) : null,
    tags: tagList,
    productLinks: validatedLinks,
    notes: notes ? String(notes).trim().slice(0, 1000) : null,
  });

  return { ok: result.persisted, id: result.id, error: result.error };
}

async function listVideos({ status, platform, limit } = {}) {
  return db.getVideos({ status, platform, limit });
}

/**
 * Save a search-result recommendation as a "queued" video — i.e. a
 * candidate the admin has NOT yet reviewed or downloaded. This is what
 * /scrape populates. It never touches actual video bytes.
 */
async function queueRecommendation({ videoUrl, title, description, creator, platform, tags, searchKeyword }) {
  const normalizedUrl = normalizeVideoUrl(videoUrl);
  if (!normalizedUrl) return { ok: false, error: 'Invalid video URL.' };

  const result = await db.saveVideo({
    platform: platform || detectPlatform(normalizedUrl),
    videoUrl: normalizedUrl,
    thumbnailUrl: null,
    title: title ? String(title).trim().slice(0, 500) : null,
    description: description ? String(description).trim().slice(0, 2000) : null,
    creator: creator ? String(creator).trim().slice(0, 200) : null,
    tags: Array.isArray(tags) ? tags : [],
    productLinks: [],
    notes: searchKeyword ? `Found via /scrape "${searchKeyword}"` : 'Found via /scrape',
  });

  if (result.persisted && result.id) {
    await db.updateVideoStatus(result.id, 'queued');
  }
  return { ok: result.persisted, id: result.id, error: result.error };
}

async function setStatus(id, status) {
  const valid = ['queued', 'draft', 'published', 'archived'];
  if (!valid.includes(status)) {
    return { ok: false, error: `Status must be one of: ${valid.join(', ')}` };
  }
  const success = await db.updateVideoStatus(id, status);
  return { ok: success };
}

async function removeVideo(id) {
  const success = await db.deleteVideo(id);
  return { ok: success };
}

module.exports = { addVideo, listVideos, setStatus, removeVideo, detectPlatform, normalizeVideoUrl, queueRecommendation };
