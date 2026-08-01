const express = require('express');
const supabase = require('../lib/supabaseClient');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes here are admin-only — this is how the admin app finds and
// approves/rejects new listener self-signups (see routes/auth.js `/signup`,
// which creates accounts as status: 'pending').

// Lightweight count for a notification badge — the admin app polls this
// instead of pulling the full list every time, so a fresh signup shows up
// without the admin having to open the approvals screen first.
router.get('/pending-count', requireAuth, requireAdmin, async (req, res) => {
  const { count, error } = await supabase
    .from('app_users')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: count ?? 0 });
});

// Full list of listeners awaiting approval, oldest first so the admin
// works through the queue in signup order.
router.get('/pending', requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('app_users')
    .select('id, email, display_name, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ users: data.map(publicPendingUser) });
});

router.post('/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('app_users')
    .update({ status: 'approved' })
    .eq('id', req.params.id)
    .eq('status', 'pending') // only ever approve out of pending, never re-approve/undo a reject
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'No pending signup found with that id' });
  res.json({ user: publicPendingUser(data) });
});

router.post('/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('app_users')
    .update({ status: 'rejected' })
    .eq('id', req.params.id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'No pending signup found with that id' });
  res.json({ user: publicPendingUser(data) });
});

function publicPendingUser(u) {
  return { id: u.id, email: u.email, displayName: u.display_name, createdAt: u.created_at };
}

module.exports = router;
