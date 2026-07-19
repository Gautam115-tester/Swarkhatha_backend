const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabaseClient');

const router = express.Router();

// Listener signup (admins are created manually in Supabase or via a one-time seed script)
router.post('/signup', async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const { data: existing } = await supabase.from('app_users').select('id').eq('email', email).maybeSingle();
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const password_hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase
    .from('app_users')
    .insert({ email, password_hash, display_name: displayName, role: 'listener' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  const token = issueToken(data);
  res.json({ token, user: publicUser(data) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase.from('app_users').select('*').eq('email', email).maybeSingle();
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = issueToken(user);
  res.json({ token, user: publicUser(user) });
});

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}
function publicUser(u) {
  return { id: u.id, email: u.email, displayName: u.display_name, role: u.role };
}

module.exports = router;
