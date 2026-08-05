const express = require('express');
const supabase = require('../lib/supabaseClient');
const { encrypt } = require('../lib/crypto');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const groq = require('../lib/groq');

const router = express.Router();

function maskKey(apiKey) {
  if (!apiKey || apiKey.length < 8) return '****';
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

/* ------------------------------------------------------------------
 * 1) ADD A GROQ ACCOUNT  (admin only)
 *    Body: { apiKey, label }
 *    Same spirit as POST /api/storage/accounts — validates the key with
 *    Groq itself (GET /models) before saving, so a typo'd/revoked key is
 *    caught immediately instead of surfacing later as a confusing
 *    transcription failure.
 * ------------------------------------------------------------------ */
router.post('/accounts', requireAuth, requireAdmin, async (req, res) => {
  const { apiKey, label } = req.body;
  if (!apiKey) {
    return res.status(400).json({ error: 'apiKey is required (create one at https://console.groq.com/keys)' });
  }

  try {
    await groq.validateKey({ apiKey });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    return res.status(500).json({ error: `Groq key check failed: ${msg}` });
  }

  try {
    const { data: row, error } = await supabase.from('groq_accounts').insert({
      provider: 'groq',
      label: label || `Groq - ${maskKey(apiKey)}`,
      credentials_enc: encrypt(JSON.stringify({ apiKey }))
    }).select().single();
    if (error) return res.status(500).json({ error: `Saving the account failed (database): ${error.message}` });
    return res.json({ account: { id: row.id, label: row.label, isActive: row.is_active } });
  } catch (e) {
    return res.status(500).json({ error: `Saving the account failed: ${e.message}` });
  }
});

/* ------------------------------------------------------------------
 * 2) LIST GROQ ACCOUNTS  (admin only) — masked, never returns the raw key.
 * ------------------------------------------------------------------ */
router.get('/accounts', requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('groq_accounts').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({
    accounts: (data || []).map((a) => ({
      id: a.id,
      label: a.label,
      isActive: a.is_active,
      lastUsedAt: a.last_used_at,
      lastError: a.last_error
    }))
  });
});

/* ------------------------------------------------------------------
 * 3) RENAME / ACTIVATE / DEACTIVATE  (admin only)
 * ------------------------------------------------------------------ */
router.patch('/accounts/:id', requireAuth, requireAdmin, async (req, res) => {
  const { label, isActive } = req.body;
  const update = {};
  if (label) update.label = label;
  if (typeof isActive === 'boolean') update.is_active = isActive;
  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  const { data, error } = await supabase.from('groq_accounts').update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ account: { id: data.id, label: data.label, isActive: data.is_active } });
});

/* ------------------------------------------------------------------
 * 4) REMOVE  (admin only) — does not touch any transcripts already
 *    generated using this key; only stops it being picked for new jobs.
 * ------------------------------------------------------------------ */
router.delete('/accounts/:id', requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabase.from('groq_accounts').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
