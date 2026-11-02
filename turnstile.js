'use strict';

// Cloudflare Turnstile: checks the token the widget gave the browser. Without keys, it is off.
const config = require('./config');

const enabled = () => Boolean(config.TURNSTILE_SITE_KEY && config.TURNSTILE_SECRET_KEY);

async function verify(token, ip) {
  if (!enabled()) return true;
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: config.TURNSTILE_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!data.success) console.warn('[turnstile] refusé :', (data['error-codes'] || []).join(', '));
    return data.success === true;
  } catch (err) {
    console.error('[turnstile] vérification impossible :', err.message);
    return false;
  }
}

module.exports = { enabled, verify };
