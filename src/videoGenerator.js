/**
 * Video Generator — "Product Shot Video Builder": turns a single product
 * photo into a short showcase video via Runway's image-to-video API,
 * using prompt presets specifically engineered to keep the product
 * itself unchanged and only animate the camera/lighting around it.
 *
 * Why presets instead of freeform prompts: an earlier freeform-prompt
 * version of this feature produced videos where the jewelry itself came
 * out visibly altered (warped facets, shifted proportions, changed
 * color) — disqualifying for affiliate content, where the video has to
 * show the exact item being sold. AI video models are well documented
 * to struggle most with fine, reflective, or symmetrical detail — which
 * describes jewelry closely. These presets explicitly instruct the
 * model to lock the product and only move the camera, and default to
 * Runway's non-Turbo model (better fidelity, Turbo trades quality for
 * speed) with a short 4-second duration (less time for drift to creep in).
 *
 * THIS STILL ISN'T A GUARANTEE. AI generation can still alter details
 * even with a careful prompt — there's no way to mechanically enforce
 * "don't change the product" with this class of model. Always watch
 * the generated clip against the original photo before using it in a
 * campaign; if the product looks different, don't post it — that's
 * exactly the failure mode this was built to reduce, not eliminate.
 *
 * How it works (Runway's task-based async pattern):
 *   1. POST /v1/image_to_video with the product image (a public URL)
 *      and a locked-product motion prompt (see PRODUCT_SHOT_PRESETS)
 *   2. Poll GET /v1/tasks/{id} until status is SUCCEEDED or FAILED
 *   3. Download the resulting video file to public/uploads/videos,
 *      same as every other video source in this app
 *
 * Setup: sign up at runwayml.com, get an API key from Settings > API,
 * set RUNWAY_API_KEY. See .env.example for the rest of the knobs.
 *
 * IMPORTANT — Runway's exact request/response field names have shifted
 * between model generations (Gen-3 → Gen-4 → Gen-4.5) and this was
 * built without live access to test against their current API, so if
 * generation starts failing with a "invalid field" or schema-type
 * error, the fix is checking https://docs.dev.runwayml.com against the
 * request shape in generateVideoFromImage() below and adjusting field
 * names/enums to match — the polling/download logic around it doesn't
 * need to change.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const RUNWAY_API_BASE = 'https://api.dev.runwayml.com/v1';
const IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'images');
const VIDEO_DIR = path.join(__dirname, '..', 'public', 'uploads', 'videos');

// Every preset explicitly tells the model the product is fixed/locked
// and only the camera or lighting may move — this is the main lever
// available to reduce (not eliminate) product distortion.
const PRODUCT_SHOT_PRESETS = {
  orbit: {
    label: '360° Orbit (camera circles a fixed product)',
    prompt: 'Fixed, unmoving jewelry product in the exact center of frame — do not alter its shape, color, size, or design in any way. Only the camera slowly orbits around the static product in a smooth 360-degree circular path. Soft studio lighting, subtle realistic reflections, no warping, no morphing, photorealistic, product stays perfectly unchanged throughout.',
  },
  zoom: {
    label: 'Slow Zoom (camera pushes in on a fixed product)',
    prompt: 'Fixed, unmoving jewelry product — do not alter its shape, color, size, or design in any way. Only the camera slowly and smoothly zooms in toward the static product. Soft studio lighting, no warping, no morphing, photorealistic, product stays perfectly unchanged throughout.',
  },
  light_sweep: {
    label: 'Light Sweep (product fixed, light moves across it)',
    prompt: 'Fixed, unmoving jewelry product — do not alter its shape, color, size, or design in any way. The product does not move. A soft studio light source slowly sweeps across the piece, creating gentle changing highlights and sparkle on the metal and gemstones. Camera stays still. No warping, no morphing, photorealistic, product stays perfectly unchanged throughout.',
  },
  tilt: {
    label: 'Gentle Tilt (subtle camera angle shift on a fixed product)',
    prompt: 'Fixed, unmoving jewelry product in the center of frame — do not alter its shape, color, size, or design in any way. Only the camera performs a very subtle, slow tilt and slight vertical pan, keeping the product centered. Soft studio lighting, no warping, no morphing, photorealistic, product stays perfectly unchanged throughout.',
  },
};

function ensureDirs() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
}

function isConfigured() {
  return Boolean(process.env.RUNWAY_API_KEY);
}

function getConfig() {
  return {
    apiKey: process.env.RUNWAY_API_KEY,
    // Non-Turbo model by default — Turbo is faster/cheaper but trades
    // away fidelity, which is exactly what product-accuracy needs most.
    // Override with RUNWAY_MODEL=gen4_turbo if you want to trade back
    // toward speed/cost after confirming quality is acceptable.
    model: process.env.RUNWAY_MODEL || 'gen4',
    apiVersion: process.env.RUNWAY_API_VERSION || '2024-11-06',
    ratio: process.env.RUNWAY_RATIO || '1280:720',
    // Shorter than the earlier default (was 5s) — less time in the
    // generation for the model to drift away from the source image.
    duration: parseInt(process.env.RUNWAY_DURATION || '4', 10),
  };
}

function authHeaders() {
  const cfg = getConfig();
  return {
    'Authorization': `Bearer ${cfg.apiKey}`,
    'Content-Type': 'application/json',
    'X-Runway-Version': cfg.apiVersion,
  };
}

function getPresets() {
  return Object.entries(PRODUCT_SHOT_PRESETS).map(([key, v]) => ({ key, label: v.label }));
}

/**
 * Save an uploaded product image to public/uploads/images so it has a
 * public URL Runway can fetch from. Returns { filePath, publicUrl }.
 */
function saveImageFile(tempPath, originalName) {
  ensureDirs();
  const ext = path.extname(originalName || '.jpg') || '.jpg';
  const filename = `${uuidv4()}${ext}`;
  const destPath = path.join(IMAGE_DIR, filename);
  fs.copyFileSync(tempPath, destPath);
  return { filePath: destPath, publicUrl: `/uploads/images/${filename}` };
}

/**
 * Kick off a Runway image-to-video generation task. Returns
 * { ok, taskId, error }.
 */
async function createTask({ imagePublicUrl, shotType, customPrompt }) {
  const cfg = getConfig();
  if (!cfg.apiKey) return { ok: false, error: 'RUNWAY_API_KEY not set.' };

  const preset = PRODUCT_SHOT_PRESETS[shotType] || PRODUCT_SHOT_PRESETS.orbit;
  const promptText = customPrompt
    ? `${preset.prompt} ${customPrompt}` // append any extra admin notes to the locked-product base prompt, never replace it
    : preset.prompt;

  try {
    const res = await fetch(`${RUNWAY_API_BASE}/image_to_video`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: cfg.model,
        promptImage: imagePublicUrl,
        promptText,
        ratio: cfg.ratio,
        duration: cfg.duration,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.error || `Runway responded ${res.status}: ${JSON.stringify(data)}` };
    }
    return { ok: true, taskId: data.id };
  } catch (err) {
    return { ok: false, error: `Failed to create Runway task: ${err.message}` };
  }
}

/**
 * Poll a Runway task until it succeeds, fails, or times out.
 * Returns { ok, videoUrl, error }.
 */
async function pollTask(taskId, { maxWaitMs = 180000, intervalMs = 5000 } = {}) {
  const cfg = getConfig();
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, intervalMs));

    try {
      const res = await fetch(`${RUNWAY_API_BASE}/tasks/${taskId}`, {
        headers: authHeaders(),
      });
      const data = await res.json();

      if (data.status === 'SUCCEEDED') {
        const videoUrl = Array.isArray(data.output) ? data.output[0] : data.output;
        if (!videoUrl) return { ok: false, error: 'Task succeeded but no output video URL was returned.' };
        return { ok: true, videoUrl };
      }
      if (data.status === 'FAILED') {
        return { ok: false, error: data.failure || 'Runway task failed for an unspecified reason.' };
      }
      // PENDING / RUNNING — keep polling
    } catch (err) {
      console.warn(`[videoGenerator] Poll attempt failed (will retry): ${err.message}`);
    }
  }

  return { ok: false, error: `Timed out waiting for Runway after ${maxWaitMs / 1000}s. The task may still complete — check the Runway dashboard for task ${taskId}.` };
}

/** Download the generated video file to public/uploads/videos. */
async function downloadGeneratedVideo(videoUrl) {
  ensureDirs();
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) return { ok: false, error: `Failed to download generated video (${res.status}).` };

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
 * Full pipeline: product image file → generated showcase video, using
 * one of the locked-product presets above.
 * `tempImagePath`/`originalName` come from a multer upload, same
 * pattern as the manual video upload route.
 * Returns { ok, video: {url, filePath}, error }.
 */
async function generateVideoFromImage(tempImagePath, originalName, { shotType, customPrompt } = {}) {
  if (!isConfigured()) {
    return { ok: false, error: 'Runway isn\'t configured yet — set RUNWAY_API_KEY. See .env.example.' };
  }

  const saved = saveImageFile(tempImagePath, originalName);
  // Runway needs a URL it can fetch the image from. This works once
  // the app is deployed with a public domain (riolendel.com); it will
  // NOT work testing against localhost, since Runway's servers can't
  // reach your machine.
  const imagePublicUrl = `${process.env.SITE_URL || 'https://riolendel.com'}${saved.publicUrl}`;

  const task = await createTask({ imagePublicUrl, shotType, customPrompt });
  if (!task.ok) return { ok: false, error: task.error };

  const polled = await pollTask(task.taskId);
  if (!polled.ok) return { ok: false, error: polled.error };

  const downloaded = await downloadGeneratedVideo(polled.videoUrl);
  if (!downloaded.ok) return { ok: false, error: downloaded.error };

  return { ok: true, video: { url: downloaded.publicUrl, filePath: downloaded.filePath }, sourceImageUrl: imagePublicUrl };
}

module.exports = { isConfigured, generateVideoFromImage, saveImageFile, getPresets, getConfig };
