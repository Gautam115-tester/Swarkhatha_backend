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

const app = express();
// Render sits behind its own reverse proxy — without this, every request
// looks like it comes from the same internal IP to Express (and to
// express-rate-limit in middleware/rateLimit.js), which would make
// per-IP rate limiting either useless or wrongly punish everyone at once.
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, service: 'swarkatha-backend' }));

app.use('/api/auth', authRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/labels', labelsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/ai-accounts', aiAccountsRoutes);
app.use('/api/transcripts', transcriptsRoutes);

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
  // The 8s Drime storage-usage poll (lib/liveAccountsMonitor.js)
  // is intentionally NOT started here. It starts itself the moment the
  // first admin app opens the storage screen and connects to
  // GET /api/storage/accounts/live, and stops itself once the last
  // admin app closes/disconnects — see acquire()/release() there and
  // in routes/storage.js. No admin app open = no Drime traffic.
});