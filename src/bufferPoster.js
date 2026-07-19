/**
 * Buffer Poster — publishes to Facebook, Instagram, and TikTok through
 * Buffer's unified GraphQL API instead of three separate raw platform
 * integrations. Buffer is an official API partner for these networks,
 * so this skips Meta App Review and TikTok Developer approval entirely
 * — you just connect your accounts once in the Buffer dashboard and
 * use a personal API key.
 *
 * Shopee still has no posting API anywhere, on Buffer or otherwise —
 * that stays manual/copy-paste regardless of which path this module
 * takes (see socialPoster.js).
 *
 * Setup:
 *   1. Sign up at buffer.com, connect your Facebook Page, Instagram
 *      Business account, and TikTok account as "channels".
 *   2. Buffer dashboard → Settings → API → generate a personal API key
 *      (must be an organization owner).
 *   3. Call GET /api/admin/buffer/channels?token=YOUR_ADMIN_TOKEN once
 *      deployed — it lists your organizationId and each channel's id
 *      so you can fill in the env vars below.
 *   4. Set BUFFER_API_KEY, BUFFER_ORGANIZATION_ID, and one
 *      BUFFER_CHANNEL_<PLATFORM> id per platform you connected.
 *
 * Schema note: Buffer's GraphQL schema has shifted before (see their
 * public changelog — CreatePostInput.assets moved from an object to a
 * typed list mid-2026). If a post starts failing with a schema/field
 * error, re-check https://developers.buffer.com/reference.html or run
 * an introspection query against api.buffer.com and adjust the
 * `assets` shape in buildAssets() below to match.
 */

const BUFFER_ENDPOINT = 'https://api.buffer.com';

function getConfig() {
  return {
    apiKey: process.env.BUFFER_API_KEY,
    organizationId: process.env.BUFFER_ORGANIZATION_ID,
    channels: {
      facebook: process.env.BUFFER_CHANNEL_FACEBOOK,
      instagram: process.env.BUFFER_CHANNEL_INSTAGRAM,
      tiktok: process.env.BUFFER_CHANNEL_TIKTOK,
    },
  };
}

function isConfigured() {
  const cfg = getConfig();
  return Boolean(cfg.apiKey);
}

function isChannelConfigured(platform) {
  const cfg = getConfig();
  return Boolean(cfg.apiKey && cfg.channels[platform]);
}

async function graphqlRequest(query, variables = {}) {
  const cfg = getConfig();
  if (!cfg.apiKey) return { ok: false, error: 'BUFFER_API_KEY not set.' };

  try {
    const res = await fetch(BUFFER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    const data = await res.json();
    if (data.errors && data.errors.length) {
      return { ok: false, error: data.errors.map(e => e.message).join('; ') };
    }
    return { ok: true, data: data.data };
  } catch (err) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

/**
 * Build the `assets` array for createPost. Photo posts get a single
 * image asset; video posts get a single video asset with an optional
 * thumbnail. Text-only posts (link posts) get an empty array.
 */
function buildAssets({ imageUrl, videoUrl, thumbnailUrl }) {
  if (videoUrl) {
    return [{ videos: [{ url: videoUrl, thumbnailUrl: thumbnailUrl || undefined }] }];
  }
  if (imageUrl) {
    return [{ photos: [{ url: imageUrl }] }];
  }
  return [];
}

/**
 * Post to a single platform via Buffer. `dueAt` (ISO string) schedules
 * for later; omitting it posts via Buffer's queue (addToQueue), which
 * publishes at the next open queue slot — pass `immediate: true` to
 * force `schedulingType: automatic, mode: addToQueue` for "as soon as
 * possible" instead of a specific slot.
 */
async function postToChannel(platform, { text, link, imageUrl, videoUrl, thumbnailUrl, dueAt }) {
  const cfg = getConfig();
  const channelId = cfg.channels[platform];
  if (!channelId) {
    return { ok: false, error: `No Buffer channel configured for "${platform}" (set BUFFER_CHANNEL_${platform.toUpperCase()}).` };
  }

  const fullText = text + (link ? '\n\n' + link : '');
  const assets = buildAssets({ imageUrl, videoUrl, thumbnailUrl });

  const input = {
    text: fullText,
    channelId,
    schedulingType: 'automatic',
    mode: dueAt ? 'customScheduled' : 'addToQueue',
    assets,
  };
  if (dueAt) input.dueAt = dueAt;

  const query = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post { id text dueAt }
        }
        ... on MutationError {
          message
        }
      }
    }
  `;

  const result = await graphqlRequest(query, { input });
  if (!result.ok) return { ok: false, error: result.error, platform };

  const payload = result.data?.createPost;
  if (payload?.message) return { ok: false, error: payload.message, platform };
  if (payload?.post) return { ok: true, postId: payload.post.id, dueAt: payload.post.dueAt, platform, via: 'buffer' };

  return { ok: false, error: 'Unexpected response from Buffer.', platform };
}

/** List organizations + channels — handy one-time call to find your channel IDs. */
async function listChannels() {
  const query = `
    query GetOrgsAndChannels {
      organizations {
        id
        name
        channels {
          id
          service
          serviceUsername
          displayName
        }
      }
    }
  `;
  const result = await graphqlRequest(query);
  if (!result.ok) return result;
  return { ok: true, organizations: result.data?.organizations || [] };
}

module.exports = { isConfigured, isChannelConfigured, postToChannel, listChannels, getConfig };
