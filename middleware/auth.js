const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

/* ------------------------------------------------------------------
 * Short-lived, single-purpose "media tokens".
 *
 * Drime's file-bytes endpoint requires the storage account's Bearer
 * access token on every request, so that token can never be handed to
 * the Flutter app directly. Instead, GET /api/storage/stream-url/:id and
 * /download-url/:id (which DO require a normal listener JWT via
 * requireAuth) mint one of these — scoped to exactly one mediaItemId
 * and one purpose ('stream' or 'download'), expiring in a few minutes —
 * and hand back a URL carrying it as ?token=. The app can then pass
 * that URL straight to a player/downloader with no extra headers, and
 * requireMediaAccess() below accepts it in place of a normal Bearer
 * token when it checks out.
 * ------------------------------------------------------------------ */
function signMediaToken(mediaItemId, purpose, ttlSeconds = 900) {
  return jwt.sign({ mid: String(mediaItemId), purpose }, process.env.JWT_SECRET, { expiresIn: ttlSeconds });
}

// Gates the actual byte-streaming routes. Accepts EITHER:
//  - a normal listener Bearer JWT (same as requireAuth), or
//  - a ?token= query param minted by signMediaToken() for this exact
//    mediaItemId + purpose.
// so the proxy routes work both for players that attach headers and
// for ones that only take a bare URL.
function requireMediaAccess(purpose) {
  return (req, res, next) => {
    const { token } = req.query;
    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        if (payload.purpose === purpose && payload.mid === String(req.params.mediaItemId)) {
          req.user = payload;
          return next();
        }
      } catch (e) {
        // fall through to a normal Authorization header check below
      }
    }
    return requireAuth(req, res, next);
  };
}

module.exports = { requireAuth, requireAdmin, signMediaToken, requireMediaAccess };
