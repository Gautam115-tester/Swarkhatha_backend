/**
 * Per-IP rate limiting. Nothing in this backend was throttled before this
 * file existed — /login had no cap on attempts (bcrypt.compare()'s ~100ms
 * cost was the ONLY thing slowing a brute-force/credential-stuffing script
 * down), and the media-token endpoints had no cap either, so a single
 * misbehaving client (compromised device, scraper, or just a buggy retry
 * loop) could hammer Supabase/Drime hard enough to make the API feel slow
 * for every other real listener at the same time — a performance problem
 * and a security problem with the same fix.
 *
 * IMPORTANT: requires `app.set('trust proxy', 1)` in server.js — Render
 * sits behind a reverse proxy, so without that this would see every
 * request as coming from the same internal IP and either rate-limit
 * everyone together or nobody at all.
 *
 * Limits are deliberately generous for the media endpoints: real
 * listening sessions (many tracks, lots of seeking) and shared/carrier-
 * grade NAT IPs (common in India, where multiple real users can share one
 * public IP) both need headroom. The goal is catching obvious abuse
 * (thousands of requests/minute from one IP), not throttling normal use.
 */

const rateLimit = require('express-rate-limit');

function jsonHandler(req, res) {
  res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
}

// Login/signup: brute-force and credential-stuffing protection. 20
// attempts per 15 minutes per IP is well above what a real person
// fat-fingering their password needs, and well below what makes a
// password-guessing script worthwhile.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonHandler
});

// stream-url / download-url / stream / file: generous enough for genuine
// binge-listening + scrubbing (each seek can mean another request), tight
// enough to stop scripted enumeration or abuse from degrading the API for
// everyone else.
const mediaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonHandler
});

module.exports = { authLimiter, mediaLimiter };