/**
 * Minimal SMTP mailer, used only for password-reset codes right now.
 *
 * Needs SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM set (see
 * .env.example) -- any standard SMTP provider works (SendGrid, Resend,
 * Mailgun, Gmail with an app password, etc.), nothing provider-specific is
 * assumed here.
 *
 * If those aren't set (e.g. local dev, or before you've picked a provider),
 * this deliberately doesn't throw -- it logs the message to the console
 * instead, so /forgot-password stays testable without real email set up,
 * and a missing SMTP config never turns into a 500 for the caller.
 */
const nodemailer = require('nodemailer');

let _transporter = null;
function transporter() {
  if (_transporter) return _transporter;
  if (!process.env.SMTP_HOST) return null;
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return _transporter;
}

async function sendPasswordResetEmail(toEmail, code) {
  const t = transporter();
  if (!t) {
    console.log(`[mailer] SMTP not configured — password reset code for ${toEmail}: ${code}`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: 'Your SwarKatha password reset code',
    text: `Your password reset code is ${code}. It expires in 15 minutes. If you didn't request this, you can ignore this email.`,
  });
}

module.exports = { sendPasswordResetEmail };
