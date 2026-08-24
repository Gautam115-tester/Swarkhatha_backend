const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sendPasswordResetEmail } = require('../lib/mailer');
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabaseClient');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Listener signup (admins are created manually in Supabase or via a one-time seed script).
// New accounts start out 'pending' — they cannot log in until an admin approves them
// from the admin app (see routes/users.js), so no token is issued here.
router.post('/signup', authLimiter, async (req, res) => {
  try {
    const { email, password, displayName } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const { data: existing, error: lookupError } = await supabase
      .from('app_users').select('id').eq('email', email).maybeSingle();
    if (lookupError) return res.status(500).json({ error: lookupError.message });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('app_users')
      .insert({ email, password_hash, display_name: displayName, role: 'listener', status: 'pending' })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // No token: the listener app must not treat this as a logged-in session
    // until an admin approves the account.
    res.status(201).json({ pending: true, user: publicUser(data) });
  } catch (err) {
    console.error('signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const { data: user, error: lookupError } = await supabase
      .from('app_users').select('*').eq('email', email).maybeSingle();
    if (lookupError) return res.status(500).json({ error: lookupError.message });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.status === 'pending') {
      return res.status(403).json({ error: 'Your account is awaiting admin approval.', status: 'pending' });
    }
    if (user.status === 'rejected') {
      return res.status(403).json({ error: 'Your signup request was not approved.', status: 'rejected' });
    }

    const token = issueToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}
function publicUser(u) {
  return { id: u.id, email: u.email, displayName: u.display_name, role: u.role, status: u.status };
}


// Forgot password: always responds { ok: true } regardless of whether the
// email is registered, so this can't be used to enumerate accounts. If it
// IS registered, emails a 6-digit code (not a reset link -- there's no web
// page for a mobile app to link into) valid for 15 minutes. Reuses
// authLimiter so this can't be hammered to spam an inbox either.
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    const { data: user } = await supabase.from('app_users').select('id, email').eq('email', email).maybeSingle();
    if (user) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const token_hash = await bcrypt.hash(code, 10);
      const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await supabase.from('password_reset_tokens').insert({ user_id: user.id, token_hash, expires_at });
      sendPasswordResetEmail(user.email, code).catch((e) => console.error('[forgot-password] send failed:', e.message));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('forgot-password error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Reset password using the code emailed by /forgot-password. Checks the
// code against every unused, unexpired token issued for that email (there
// could be more than one if the listener requested a code twice) rather
// than looking a single row up by code directly, since only the bcrypt hash
// is ever stored.
router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'email, code, and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
    }

    const { data: user } = await supabase.from('app_users').select('id').eq('email', email).maybeSingle();
    if (!user) return res.status(400).json({ error: 'Invalid or expired code' });

    const { data: tokens } = await supabase
      .from('password_reset_tokens')
      .select('id, token_hash, expires_at, used_at')
      .eq('user_id', user.id)
      .is('used_at', null)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    let matched = null;
    for (const t of tokens || []) {
      if (await bcrypt.compare(code, t.token_hash)) { matched = t; break; }
    }
    if (!matched) return res.status(400).json({ error: 'Invalid or expired code' });

    const password_hash = await bcrypt.hash(newPassword, 10);
    const { error: updateError } = await supabase.from('app_users').update({ password_hash }).eq('id', user.id);
    if (updateError) return res.status(500).json({ error: updateError.message });

    await supabase.from('password_reset_tokens').update({ used_at: new Date().toISOString() }).eq('id', matched.id);

    res.json({ ok: true });
  } catch (err) {
    console.error('reset-password error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;