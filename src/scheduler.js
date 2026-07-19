/**
 * Scheduler — runs staggered "warm up then convert" posting campaigns.
 *
 * The problem this solves: Shopee/TikTok Shop affiliate links carry
 * session-timed tracking tokens. If you post the real video with the
 * live affiliate link right away, by the time the algorithm actually
 * pushes it to more feeds the link may have expired. The fix is a
 * two-phase campaign:
 *
 *   Phase 1 (day 0 / immediately)   — post 2-4 still JPEG frames from
 *                                      the video, NO affiliate link (or
 *                                      a generic non-expiring one like
 *                                      your /shop/ page). This "warms up"
 *                                      the account/post with normal
 *                                      engagement before anything time-
 *                                      sensitive is attached.
 *   Phase 2 (day 1-2, scheduled)    — post the actual video WITH a
 *                                      freshly-generated affiliate link,
 *                                      timed close to when you expect
 *                                      real engagement/clicks.
 *
 * Nothing here auto-generates the affiliate link itself — admin pastes
 * the fresh link when creating the campaign or right before Phase 2
 * fires (there's an "update link" endpoint for last-minute swaps).
 *
 * This module owns the `scheduled_posts` table and a cron tick that
 * finds due posts and fires them through socialPoster.
 */

const cron = require('node-cron');
const db = require('./db');
const socialPoster = require('./socialPoster');

let cronTask = null;

// ---------- Campaign creation ----------

/**
 * Create a full warm-up campaign:
 *  - immediate (or near-immediate) post of still frames, no link
 *  - a scheduled follow-up post of the real video + affiliate link,
 *    `delayHours` later (default 36h ~ "a day or two")
 */
async function createWarmupCampaign({
  message,
  warmupImages,      // array of public image URLs (the extracted JPEGs)
  videoUrl,          // public URL of the real video, for phase 2
  affiliateLink,     // the session-timed affiliate link, used only in phase 2
  platforms,         // array like ['facebook','instagram','tiktok']
  delayHours = 36,
  sourceVideoId = null,
}) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    return { ok: false, error: 'Select at least one platform.' };
  }
  if (!Array.isArray(warmupImages) || warmupImages.length === 0) {
    return { ok: false, error: 'At least one warm-up image is required.' };
  }

  const now = new Date();
  const phase2Time = new Date(now.getTime() + delayHours * 60 * 60 * 1000);

  // Phase 1: schedule "now" (next cron tick will pick it up within minutes)
  const phase1 = await db.saveScheduledPost({
    message: message || '',
    link: null, // no affiliate link yet — this is the warm-up
    imageUrls: warmupImages,
    videoUrl: null,
    platforms,
    scheduledFor: now,
    phase: 1,
    sourceVideoId,
  });

  // Phase 2: the real video + live affiliate link, `delayHours` later
  const phase2 = await db.saveScheduledPost({
    message: message || '',
    link: affiliateLink || null,
    imageUrls: [],
    videoUrl: videoUrl || null,
    platforms,
    scheduledFor: phase2Time,
    phase: 2,
    sourceVideoId,
  });

  return {
    ok: true,
    phase1Id: phase1.id,
    phase2Id: phase2.id,
    phase1ScheduledFor: now.toISOString(),
    phase2ScheduledFor: phase2Time.toISOString(),
  };
}

/** Create a single one-off scheduled post (no warm-up phases). */
async function scheduleSinglePost({ message, link, imageUrls, videoUrl, platforms, scheduledFor, sourceVideoId }) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    return { ok: false, error: 'Select at least one platform.' };
  }
  const when = scheduledFor ? new Date(scheduledFor) : new Date();
  const result = await db.saveScheduledPost({
    message, link, imageUrls: imageUrls || [], videoUrl, platforms,
    scheduledFor: when, phase: null, sourceVideoId,
  });
  return { ok: result.persisted, id: result.id, scheduledFor: when.toISOString() };
}

/** Update the affiliate link on a not-yet-fired scheduled post (e.g. re-generate before it fires). */
async function updateScheduledLink(id, newLink) {
  return db.updateScheduledPostLink(id, newLink);
}

async function cancelScheduledPost(id) {
  return db.cancelScheduledPost(id);
}

async function listScheduled({ status, limit } = {}) {
  return db.getScheduledPosts({ status, limit });
}

// ---------- Execution ----------

/** Post a single JPEG (or the first of a batch) as an image post; extra images noted in message. */
async function executePost(post) {
  const platforms = post.platforms || [];
  const results = {};

  for (const platform of platforms) {
    const payload = {
      message: post.message || '',
      caption: post.message || '',
      title: (post.message || '').slice(0, 150),
      link: post.link || null,
      // Use the first warm-up image for single-image platforms; IG/FB take one image per call.
      imageUrl: (post.image_urls && post.image_urls[0]) || null,
      videoUrl: post.video_url || null,
      productUrl: post.link || null,
    };
    const result = await socialPoster.postTo(platform, payload);
    results[platform] = result;
  }

  return results;
}

/** Called by cron: find due posts, execute them, mark completed/failed. */
async function runDueSchedule() {
  const due = await db.getDuePosts();
  if (due.length === 0) return { checked: 0, executed: 0 };

  let executed = 0;
  for (const post of due) {
    try {
      const results = await executePost(post);
      const allOk = Object.values(results).every(r => r.ok);
      await db.completeScheduledPost(post.id, results, allOk ? 'completed' : 'partial_failure');
      executed++;
      console.log(`[scheduler] Executed scheduled post #${post.id} (phase ${post.phase || '—'}): ${allOk ? 'ok' : 'partial failure'}`);
    } catch (err) {
      console.error(`[scheduler] Failed to execute scheduled post #${post.id}:`, err.message);
      await db.completeScheduledPost(post.id, { error: err.message }, 'failed');
    }
  }
  return { checked: due.length, executed };
}

// ---------- Cron wiring ----------

/** Start the recurring check. Runs every 5 minutes by default. */
function start(cronExpression = '*/5 * * * *') {
  if (cronTask) return; // already running
  cronTask = cron.schedule(cronExpression, () => {
    runDueSchedule().catch(err => console.error('[scheduler] Tick failed:', err.message));
  });
  console.log(`[scheduler] Started — checking for due posts on schedule "${cronExpression}".`);
}

function stop() {
  if (cronTask) { cronTask.stop(); cronTask = null; }
}

module.exports = {
  createWarmupCampaign,
  scheduleSinglePost,
  updateScheduledLink,
  cancelScheduledPost,
  listScheduled,
  runDueSchedule,
  start,
  stop,
};
