/**
 * Video Processor — converts an uploaded video into 2-4 still JPEG frames.
 *
 * Why: affiliate links (Shopee/TikTok Shop) carry session-timed tracking
 * tokens that expire, so posting the raw video immediately often means
 * the link is dead by the time it gets engagement. The workaround is to
 * "warm up" the account first — post still frames from the video (no
 * link, or a non-expiring link) a day or two ahead of the real video +
 * fresh affiliate link. This module handles the frame extraction half
 * of that; src/scheduler.js handles the staggered posting half.
 *
 * Requires ffmpeg on PATH (already present in this container; on
 * Railway/most hosts you'll need a buildpack or Docker image with
 * ffmpeg installed — see README for notes).
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');

const execFileAsync = promisify(execFile);

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'frames');
const VIDEO_DIR = path.join(__dirname, '..', 'public', 'uploads', 'videos');

function ensureDirs() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
}

// Get video duration in seconds using ffprobe
async function getDuration(videoPath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? null : duration;
  } catch (err) {
    console.error('[videoProcessor] ffprobe failed:', err.message);
    return null;
  }
}

/**
 * Extract N evenly-spaced JPEG frames from a video file.
 * Returns array of { filename, publicUrl, filePath }.
 */
async function extractFrames(videoPath, { count = 3, prefix } = {}) {
  ensureDirs();
  const frameCount = Math.max(2, Math.min(4, count));
  const id = prefix || uuidv4().slice(0, 8);

  const duration = await getDuration(videoPath);
  // Fallback: if duration unknown, just grab frames at fixed byte-ish offsets via -ss with rough guesses
  const totalDuration = duration || 12; // assume a 12s short-form video if unknown

  // Space frames from 5% to 90% of duration — avoids pure black frame at 0:00 and end
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const fraction = 0.05 + (i / (frameCount - 1 || 1)) * 0.85;
    const timestamp = Math.max(0.1, totalDuration * fraction);
    const filename = `${id}-${i + 1}.jpg`;
    const outputPath = path.join(UPLOAD_DIR, filename);

    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss', timestamp.toFixed(2),
        '-i', videoPath,
        '-frames:v', '1',
        '-q:v', '2', // high quality JPEG
        '-vf', 'scale=1080:-2', // resize to 1080 width, preserve aspect ratio (IG/FB-friendly)
        outputPath,
      ]);
      frames.push({
        filename,
        publicUrl: `/uploads/frames/${filename}`,
        filePath: outputPath,
        timestamp: Number(timestamp.toFixed(2)),
      });
    } catch (err) {
      console.error(`[videoProcessor] Failed to extract frame ${i + 1}:`, err.message);
    }
  }

  return frames;
}

/**
 * Save an uploaded video buffer/file to disk under a stable name.
 * Returns { filePath, publicUrl }.
 */
function saveVideoFile(tempPath, originalName) {
  ensureDirs();
  const ext = path.extname(originalName || '.mp4') || '.mp4';
  const filename = `${uuidv4()}${ext}`;
  const destPath = path.join(VIDEO_DIR, filename);
  fs.copyFileSync(tempPath, destPath);
  return {
    filePath: destPath,
    publicUrl: `/uploads/videos/${filename}`,
  };
}

/**
 * Full pipeline: save uploaded video, extract N frames, return everything
 * needed to create a warm-up schedule.
 */
async function processUploadedVideo(tempPath, originalName, { frameCount = 3 } = {}) {
  const saved = saveVideoFile(tempPath, originalName);
  const frames = await extractFrames(saved.filePath, { count: frameCount });
  return {
    video: saved,
    frames,
  };
}

/**
 * Ken Burns-style video from one or more STILL product photos — slow
 * zoom and/or crossfade between images, generated entirely with ffmpeg.
 * No AI model touches the pixels, so the product looks exactly like the
 * photo you uploaded. Built as the AI video generator's replacement
 * after AI-generated jewelry videos came back with the product itself
 * subtly altered (warped facets, shifted proportions, changed color) —
 * unacceptable for affiliate content, where the video has to show the
 * real item being sold, not an AI's reinterpretation of it.
 *
 * Single image: smooth zoom-in over the still.
 * Multiple images: each gets a zoom, with a crossfade dissolve between
 * consecutive images (up to 4, matching the same frame-count convention
 * used elsewhere in this app).
 */
async function generateKenBurnsVideo(imagePaths, { durationPerImage = 3, outputWidth = 1080, outputHeight = 1080 } = {}) {
  ensureDirs();
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    throw new Error('generateKenBurnsVideo requires at least one image path.');
  }

  const images = imagePaths.slice(0, 4); // cap at 4, same as the frame-count convention
  const filename = `${uuidv4()}.mp4`;
  const outputPath = path.join(VIDEO_DIR, filename);
  const fps = 30;
  const framesPerImage = Math.round(durationPerImage * fps);

  if (images.length === 1) {
    // Single image: -loop 1 + zoompan filter, a classic slow zoom-in.
    await execFileAsync('ffmpeg', [
      '-y',
      '-loop', '1',
      '-i', images[0],
      '-vf',
      `scale=${outputWidth * 2}:${outputHeight * 2},` +
      `zoompan=z='min(zoom+0.0015,1.3)':d=${framesPerImage}:s=${outputWidth}x${outputHeight}:fps=${fps},` +
      `format=yuv420p`,
      '-t', String(durationPerImage),
      '-pix_fmt', 'yuv420p',
      outputPath,
    ]);
  } else {
    // Multiple images: build one zoompan clip per image, then
    // concatenate with a short crossfade between each pair using
    // ffmpeg's xfade filter, chained via a filter_complex graph.
    const inputArgs = [];
    images.forEach(img => { inputArgs.push('-loop', '1', '-t', String(durationPerImage + 1), '-i', img); });

    const xfadeDuration = 0.6;
    let filterParts = [];
    images.forEach((_, i) => {
      filterParts.push(
        `[${i}:v]scale=${outputWidth * 2}:${outputHeight * 2},` +
        `zoompan=z='min(zoom+0.0015,1.3)':d=${framesPerImage}:s=${outputWidth}x${outputHeight}:fps=${fps},` +
        `format=yuv420p[v${i}]`
      );
    });

    let chain = 'v0';
    for (let i = 1; i < images.length; i++) {
      const offset = i * durationPerImage - xfadeDuration * i;
      const outLabel = i === images.length - 1 ? 'vout' : `vc${i}`;
      filterParts.push(`[${chain}][v${i}]xfade=transition=fade:duration=${xfadeDuration}:offset=${offset.toFixed(2)}[${outLabel}]`);
      chain = outLabel;
    }

    await execFileAsync('ffmpeg', [
      '-y',
      ...inputArgs,
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]',
      '-pix_fmt', 'yuv420p',
      outputPath,
    ]);
  }

  return { filePath: outputPath, publicUrl: `/uploads/videos/${filename}` };
}

module.exports = { extractFrames, saveVideoFile, processUploadedVideo, generateKenBurnsVideo, getDuration, UPLOAD_DIR, VIDEO_DIR };
