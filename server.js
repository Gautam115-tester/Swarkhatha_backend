require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const storageRoutes = require('./routes/storage');
const mediaRoutes = require('./routes/media');
const labelsRoutes = require('./routes/labels');
const usersRoutes = require('./routes/users');
const aiAccountsRoutes = require('./routes/aiAccounts');
const transcriptsRoutes = require('./routes/transcripts');
const followsRoutes = require('./routes/follows');
const ratingsRoutes = require('./routes/ratings');
const statsRoutes = require('./routes/stats');
const lyricsRoutes = require('./routes/lyrics');
const playlistsRoutes = require('./routes/playlists');
const subscriptionsRoutes = require('./routes/subscriptions');
const devicesRoutes = require('./routes/devices');
const adminUsersRoutes = require('./routes/adminUsers');
const classificationRoutes = require('./routes/classification');
const { deviceGate } = require('./middleware/entitlement');

const app = express();
// Render sits behind its own reverse proxy — without this, every request
// looks like it comes from the same internal IP to Express (and to
// express-rate-limit in middleware/rateLimit.js), which would make
// per-IP rate limiting either useless or wrongly punish everyone at once.
app.set('trust proxy', 1);
app.use(cors());
// gzip JSON (the catalog is large). Optional: skipped if the package is missing.
try { app.use(require('compression')()); } catch (_) { /* npm i compression */ }
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, service: 'swarkatha-backend' }));

app.use('/api/auth', authRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/admin', adminUsersRoutes);
app.use('/api/users', usersRoutes);

// deviceGate: a listener token must belong to a registered, un-blocked device
// within the user's limit (middleware/entitlement.js). Admin tokens and
// requests with no/invalid token pass through to each route's own auth.
app.use('/api/storage', deviceGate, storageRoutes);
app.use('/api/media', deviceGate, mediaRoutes);
app.use('/api/labels', deviceGate, labelsRoutes);
app.use('/api/ai-accounts', aiAccountsRoutes);
app.use('/api/transcripts', deviceGate, transcriptsRoutes);
app.use('/api/follows', deviceGate, followsRoutes);
app.use('/api/ratings', deviceGate, ratingsRoutes);
app.use('/api/stats', deviceGate, statsRoutes);
app.use('/api/lyrics', deviceGate, lyricsRoutes);
app.use('/api/playlists', deviceGate, playlistsRoutes);
app.use('/api/subscriptions', deviceGate, subscriptionsRoutes);
// Automatic music classification (lib/classification, CLASSIFICATION.md). The cron route uses a shared
// secret instead of a JWT, so it sits outside the device gate; every other route is gated like the rest.
app.use('/api/classification/cron', classificationRoutes.cron);
app.use('/api/classification', deviceGate, classificationRoutes);

// --- JSON 404 handler ---------------------------------------------------
// Any request that doesn't match a route above used to fall through to
// Express's default HTML 404 page (starts with "<!DOCTYPE html>"), which
// broke jsonDecode() on the Flutter side (FormatException at character 1).
// Every unmatched route now gets a proper JSON body instead.
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// --- JSON error handler ---------------------------------------------------
// Catches: malformed JSON in the request body (express.json() throws a
// SyntaxError), and any error passed via next(err) or thrown synchronously
// in a route. Without this, Express's default handler renders an HTML
// error page for these too — same "<!DOCTYPE html>" symptom as the 404
// above, just triggered by a bad/broken request instead of a wrong URL.
// This must be defined last, after all routes, with all 4 params.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed JSON in request body' });
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`SwarKatha backend running on port ${PORT}`);
  // Drime storage-usage checks (lib/liveAccountsMonitor.js): every 30 s
  // while an admin app is connected, every 25 min otherwise. init()
  // loads the last known numbers from Supabase and arms the background
  // timer. On Render's free tier the instance sleeps, so also set up
  // an external scheduler for POST /api/storage/accounts/background-check.
  require('./lib/liveAccountsMonitor').init().catch((e) => console.error('[liveMonitor] init failed:', e.message));
  // Subscription expiry reminders (7 / 3 / 1 days before, and on expiry):
  // an hourly sweep while this instance is awake. Reminders are ALSO created
  // when a listener opens the app and by POST /api/subscriptions/cron/run, so
  // a sleeping Render instance can't cause a missed notification.
  require('./lib/subscriptionNotifier').startScheduler();
  // Music classification worker (durable Postgres queue; see CLASSIFICATION.md). Off with
  // CLASSIFICATION_ENABLED=off or CLASSIFICATION_WORKER_ENABLED=off (e.g. when a separate
  // `node scripts/classification-cli.js worker` process does the work).
  if (require('./lib/classification/hooks').isEnabled()) {
    try {
      const classification = require('./lib/classification/service').getService();
      classification.startWorker();
      const shutdown = () => classification.stopWorker().finally(() => process.exit(0));
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    } catch (e) { console.error('[classification] worker failed to start (uploads are unaffected):', e.message); }
  }
});