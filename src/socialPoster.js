/**
 * Social Poster — cross-platform posting to FB, Instagram, TikTok, Shopee.
 *
 * Two ways each platform (except Shopee) can be posted to. Buffer is
 * tried first per-platform if configured; the raw platform API is the
 * fallback if Buffer isn't set up for that specific channel:
 *
 *   BUFFER    — one GraphQL API, official partner for FB/IG/TikTok, so
 *               no Meta App Review or TikTok Developer approval needed.
 *               Needs: BUFFER_API_KEY + a BUFFER_CHANNEL_<PLATFORM> id
 *               per channel you connect in the Buffer dashboard.
 *               See src/bufferPoster.js for details.
 *
 *   FACEBOOK  — (fallback) Graph API. Needs FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN.
 *   INSTAGRAM — (fallback) Graph API, needs Meta App Review approval.
 *   TIKTOK    — (fallback) Content Posting API, needs TikTok dev approval.
 *
 *   SHOPEE    — No public social posting API anywhere, Buffer included.
 *               Status: "copy + open Shopee" only, always.
 *
 * All posts are saved to the social_posts table with per-platform status.
 * Nothing auto-posts — admin clicks "Post" for each platform.
 */

const bufferPoster = require('./bufferPoster');

const GRAPH_API = 'https://graph.facebook.com/v20.0';
const TIKTOK_API = 'https://open.tiktokapis.com/v2';

// Platform configs from env
function getConfig() {
  return {
    facebook: {
      enabled: Boolean(process.env.FB_PAGE_ID && process.env.FB_PAGE_ACCESS_TOKEN),
      pageId: process.env.FB_PAGE_ID,
      accessToken: process.env.FB_PAGE_ACCESS_TOKEN,
    },
    instagram: {
      enabled: Boolean(process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN),
      userId: process.env.IG_USER_ID,
      accessToken: process.env.IG_ACCESS_TOKEN,
    },
    tiktok: {
      enabled: Boolean(process.env.TIKTOK_ACCESS_TOKEN),
      accessToken: process.env.TIKTOK_ACCESS_TOKEN,
    },
    shopee: {
      enabled: false, // No API — always manual
    },
  };
}

// ============================================================
// FACEBOOK — Post to Page feed
// ============================================================
async function postToFacebook({ message, link, imageUrl }) {
  const cfg = getConfig().facebook;
  if (!cfg.enabled) return { ok: false, error: 'Facebook not configured. Set FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN.' };

  try {
    // If we have an image, post as photo with caption
    if (imageUrl) {
      const res = await fetch(`${GRAPH_API}/${cfg.pageId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: imageUrl,
          message: message + (link ? '\n\n' + link : ''),
          access_token: cfg.accessToken,
        }),
      });
      const data = await res.json();
      if (data.error) return { ok: false, error: data.error.message, code: data.error.code };
      return { ok: true, postId: data.id || data.post_id, platform: 'facebook' };
    }

    // Text + link post
    const body = { message, access_token: cfg.accessToken };
    if (link) body.link = link;

    const res = await fetch(`${GRAPH_API}/${cfg.pageId}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) return { ok: false, error: data.error.message, code: data.error.code };
    return { ok: true, postId: data.id, platform: 'facebook' };
  } catch (err) {
    return { ok: false, error: err.message, platform: 'facebook' };
  }
}

// ============================================================
// INSTAGRAM — Two-step container publish
// ============================================================
async function postToInstagram({ caption, imageUrl, link }) {
  const cfg = getConfig().instagram;
  if (!cfg.enabled) return { ok: false, error: 'Instagram not configured. Set IG_USER_ID and IG_ACCESS_TOKEN.' };
  if (!imageUrl) return { ok: false, error: 'Instagram requires an image URL (must be publicly accessible).' };

  const fullCaption = caption + (link ? '\n\n' + link : '');

  try {
    // Step 1: Create media container
    const containerRes = await fetch(`${GRAPH_API}/${cfg.userId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: imageUrl,
        caption: fullCaption,
        access_token: cfg.accessToken,
      }),
    });
    const containerData = await containerRes.json();
    if (containerData.error) return { ok: false, error: containerData.error.message };
    const containerId = containerData.id;

    // Step 2: Wait for container to be ready (IG processes the image)
    // Poll status for up to 30 seconds
    let ready = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const statusRes = await fetch(`${GRAPH_API}/${containerId}?fields=status_code&access_token=${cfg.accessToken}`);
      const statusData = await statusRes.json();
      if (statusData.status_code === 'FINISHED') { ready = true; break; }
      if (statusData.status_code === 'ERROR') return { ok: false, error: 'Instagram rejected the media. Check image URL and format.' };
    }
    if (!ready) return { ok: false, error: 'Instagram media processing timed out. Try again.' };

    // Step 3: Publish
    const publishRes = await fetch(`${GRAPH_API}/${cfg.userId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: cfg.accessToken,
      }),
    });
    const publishData = await publishRes.json();
    if (publishData.error) return { ok: false, error: publishData.error.message };
    return { ok: true, postId: publishData.id, platform: 'instagram' };
  } catch (err) {
    return { ok: false, error: err.message, platform: 'instagram' };
  }
}

// ============================================================
// INSTAGRAM REEL — Video posting
// ============================================================
async function postReelToInstagram({ caption, videoUrl, link }) {
  const cfg = getConfig().instagram;
  if (!cfg.enabled) return { ok: false, error: 'Instagram not configured.' };
  if (!videoUrl) return { ok: false, error: 'Instagram Reel requires a video URL.' };

  const fullCaption = caption + (link ? '\n\n' + link : '');

  try {
    // Step 1: Create reel container
    const containerRes = await fetch(`${GRAPH_API}/${cfg.userId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'REELS',
        video_url: videoUrl,
        caption: fullCaption,
        access_token: cfg.accessToken,
      }),
    });
    const containerData = await containerRes.json();
    if (containerData.error) return { ok: false, error: containerData.error.message };
    const containerId = containerData.id;

    // Poll for processing (videos take longer)
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`${GRAPH_API}/${containerId}?fields=status_code&access_token=${cfg.accessToken}`);
      const statusData = await statusRes.json();
      if (statusData.status_code === 'FINISHED') { ready = true; break; }
      if (statusData.status_code === 'ERROR') return { ok: false, error: 'Instagram rejected the video.' };
    }
    if (!ready) return { ok: false, error: 'Video processing timed out (max 100s). Try a shorter/smaller video.' };

    // Publish
    const publishRes = await fetch(`${GRAPH_API}/${cfg.userId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: containerId, access_token: cfg.accessToken }),
    });
    const publishData = await publishRes.json();
    if (publishData.error) return { ok: false, error: publishData.error.message };
    return { ok: true, postId: publishData.id, platform: 'instagram' };
  } catch (err) {
    return { ok: false, error: err.message, platform: 'instagram' };
  }
}

// ============================================================
// TIKTOK — Content Posting API (Direct Post)
// ============================================================
async function postToTikTok({ title, videoUrl, privacyLevel }) {
  const cfg = getConfig().tiktok;
  if (!cfg.enabled) return { ok: false, error: 'TikTok not configured. Set TIKTOK_ACCESS_TOKEN (requires TikTok developer app approval).' };
  if (!videoUrl) return { ok: false, error: 'TikTok API only supports video posts.' };

  try {
    // Step 1: Initialize upload
    const initRes = await fetch(`${TIKTOK_API}/post/publish/video/init/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        post_info: {
          title: (title || '').slice(0, 150),
          privacy_level: privacyLevel || 'SELF_ONLY', // SELF_ONLY, MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR, PUBLIC_TO_EVERYONE
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: videoUrl,
        },
      }),
    });
    const initData = await initRes.json();
    if (initData.error && initData.error.code !== 'ok') {
      return { ok: false, error: initData.error.message || JSON.stringify(initData.error) };
    }
    return { ok: true, publishId: initData.data?.publish_id, platform: 'tiktok', note: 'Video submitted to TikTok. Processing may take a few minutes.' };
  } catch (err) {
    return { ok: false, error: err.message, platform: 'tiktok' };
  }
}

// ============================================================
// SHOPEE — Manual only (no API)
// ============================================================
function generateShopeePost({ message, productUrl }) {
  // No API — return formatted text for manual copy-paste
  return {
    ok: true,
    platform: 'shopee',
    manual: true,
    copyText: message + (productUrl ? '\n\n' + productUrl : ''),
    note: 'Shopee has no public social posting API. Copy this text and paste it into Shopee Feed or your product description manually.',
  };
}

// ============================================================
// Unified post function — Buffer first (per-channel), raw API fallback
// ============================================================
async function postTo(platform, payload) {
  // Shopee never has an API path — always manual, regardless of Buffer.
  if (platform === 'shopee') return generateShopeePost(payload);

  // If this specific channel is wired up in Buffer, prefer it — one
  // unified call, no platform-specific approval needed.
  if (['facebook', 'instagram', 'tiktok'].includes(platform) && bufferPoster.isChannelConfigured(platform)) {
    const result = await bufferPoster.postToChannel(platform, {
      text: payload.message || payload.caption || '',
      link: payload.link,
      imageUrl: payload.imageUrl,
      videoUrl: payload.videoUrl,
      thumbnailUrl: payload.thumbnailUrl,
      dueAt: payload.dueAt,
    });
    if (result.ok) return result;
    // Fall through to the raw API path below if Buffer's call itself
    // failed (e.g. channel disconnected) — don't silently drop the post.
    console.warn(`[socialPoster] Buffer post to ${platform} failed, falling back to raw API:`, result.error);
  }

  switch (platform) {
    case 'facebook':
      return postToFacebook(payload);
    case 'instagram':
      if (payload.videoUrl) return postReelToInstagram(payload);
      return postToInstagram(payload);
    case 'tiktok':
      return postToTikTok(payload);
    default:
      return { ok: false, error: `Unknown platform: ${platform}` };
  }
}

// Get which platforms are configured — reports Buffer vs raw-API vs none
function getPlatformStatus() {
  const cfg = getConfig();

  function statusFor(platform, rawEnabled) {
    if (bufferPoster.isChannelConfigured(platform)) return { enabled: true, mode: 'api', via: 'buffer' };
    if (rawEnabled) return { enabled: true, mode: 'api', via: 'raw' };
    return { enabled: false, mode: platform === 'tiktok' ? 'manual' : 'not_configured', via: null };
  }

  return {
    facebook: statusFor('facebook', cfg.facebook.enabled),
    instagram: statusFor('instagram', cfg.instagram.enabled),
    tiktok: statusFor('tiktok', cfg.tiktok.enabled),
    shopee: { enabled: false, mode: 'manual', via: null },
  };
}

module.exports = { postTo, getPlatformStatus, getConfig };
