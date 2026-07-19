require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const storageRoutes = require('./routes/storage');
const mediaRoutes = require('./routes/media');
const labelsRoutes = require('./routes/labels');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, service: 'swarkatha-backend' }));

app.use('/api/auth', authRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/labels', labelsRoutes);

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