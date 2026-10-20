'use strict';

// Push notifications (Web Push / VAPID) and e-mails (Resend) for each new joke.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const webpush = require('web-push');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// The server POSTs to subscription endpoints: only accept real browser push services.
const PUSH_HOSTS = [
  'fcm.googleapis.com', 'android.googleapis.com', // Chrome, Edge (Android), Opera, Samsung
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari (macOS, iOS / iPadOS home screen apps)
  'notify.windows.com', // Edge (Windows)
];

const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,255}\.[a-z]{2,}$/i;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function splitJoke(text) {
  const [setup, ...rest] = text.split('\n');
  const punchline = rest.join('\n').trim();
  return punchline ? { setup, punchline } : { setup: null, punchline: null };
}

function createNotifier({ dataDir }) {
  const file = path.join(dataDir, 'subscribers.json');
  const vapidFile = path.join(dataDir, 'vapid.json');
  let subs = { push: [], emails: [] };
  let vapid = null;

  try {
    subs = { push: [], emails: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch { /* first start */ }

  // VAPID keys: from the environment, or generated once and kept in the data volume.
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    try {
      vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
    } catch {
      vapid = webpush.generateVAPIDKeys();
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(vapidFile, JSON.stringify(vapid, null, 2), { mode: 0o600 });
      console.log('[push] generated VAPID keys in', vapidFile);
    }
  }
  const subject = process.env.VAPID_SUBJECT
    || (PUBLIC_URL.startsWith('https://') ? PUBLIC_URL : 'mailto:noreply@example.com');
  webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);

  const emailEnabled = Boolean(RESEND_API_KEY && EMAIL_FROM && PUBLIC_URL);
  if (!emailEnabled) console.log('[email] disabled: set RESEND_API_KEY, EMAIL_FROM and PUBLIC_URL to enable');

  let saving = Promise.resolve();
  function save() {
    saving = saving.then(async () => {
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(subs, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, file);
    }).catch((err) => console.error('[subscribers] save failed:', err.message));
    return saving;
  }

  // ---------- Push ----------

  function validPushSubscription(sub) {
    if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1024) return false;
    if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return false;
    if (sub.keys.p256dh.length > 256 || sub.keys.auth.length > 64) return false;
    let url;
    try { url = new URL(sub.endpoint); } catch { return false; }
    return url.protocol === 'https:'
      && PUSH_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  }

  async function sendPush(sub, payload) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 12 * 3600, urgency: 'normal' });
      return true;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) return false; // expired: drop it
      console.warn('[push] send failed:', err.statusCode || '', err.message);
      return true;
    }
  }

  async function addPush(sub) {
    if (!validPushSubscription(sub)) return false;
    const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
    if (!subs.push.some((s) => s.endpoint === clean.endpoint)) {
      if (subs.push.length >= 50000) return false;
      subs.push.push({ ...clean, createdAt: new Date().toISOString() });
      await save();
    }
    await sendPush(clean, {
      title: 'Notifications activées',
      body: 'Tu recevras la blague plate du jour dès qu’elle sort.',
      tag: 'welcome',
    });
    return true;
  }

  async function removePush(endpoint) {
    const before = subs.push.length;
    subs.push = subs.push.filter((s) => s.endpoint !== endpoint);
    if (subs.push.length !== before) await save();
  }

  async function pushAll(joke, key) {
    const { setup } = splitJoke(joke.text);
    const payload = {
      title: 'La blague plate du jour',
      body: setup ? `${setup}\nOuvre pour la réponse 👀` : joke.text,
      tag: `joke-${key}`,
      url: '/',
    };
    const alive = [];
    for (let i = 0; i < subs.push.length; i += 50) {
      const batch = subs.push.slice(i, i + 50);
      const results = await Promise.all(batch.map((s) => sendPush(s, payload)));
      batch.forEach((s, j) => { if (results[j]) alive.push(s); });
    }
    const dropped = subs.push.length - alive.length;
    subs.push = alive;
    if (dropped) await save();
    console.log(`[push] sent to ${alive.length}, dropped ${dropped} expired`);
  }

  // ---------- E-mail (Resend) ----------

  async function resend(pathname, body) {
    const res = await fetch(`https://api.resend.com${pathname}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  function layout(inner, unsubscribeUrl) {
    const footer = unsubscribeUrl
      ? `<p style="margin:32px 0 0;font-size:12px;color:#86868b;">Tu reçois cet e-mail parce que tu t’es abonné à la blague plate du jour.<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#86868b;">Se désabonner</a></p>`
      : '';
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f5f5f7;">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1d1d1f;">
<p style="margin:0 0 4px;font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:#6e6e73;">La blague plate du jour</p>
${inner}${footer}
</div></body></html>`;
  }

  function jokeEmail(joke, sub) {
    const unsubscribeUrl = `${PUBLIC_URL}/email/unsubscribe?token=${sub.token}`;
    const { setup, punchline } = splitJoke(joke.text);
    const card = (content) => `<div style="margin:20px 0 0;padding:32px 28px;background:#ffffff;border-radius:20px;text-align:center;">${content}</div>`;
    const text = (t, color) => `<p style="margin:0;font-size:22px;line-height:1.35;font-weight:600;color:${color};">${escapeHtml(t)}</p>`;
    const inner = setup
      ? card(text(setup, '#1d1d1f'))
        + '<p style="margin:16px 0 0;text-align:center;font-size:13px;color:#86868b;">La réponse est plus bas ↓</p>'
        + '<div style="height:220px;"></div>'
        + card(text(punchline, '#0071e3'))
      : card(text(joke.text, '#1d1d1f'));
    const source = `<p style="margin:16px 0 0;text-align:center;font-size:12px;color:#86868b;">Source : ${escapeHtml(joke.source)} · <a href="${escapeHtml(PUBLIC_URL)}" style="color:#0071e3;">Voir sur le site</a></p>`;
    return {
      from: EMAIL_FROM,
      to: [sub.email],
      subject: setup ? `😐 ${setup}` : '😐 La blague plate du jour',
      html: layout(inner + source, unsubscribeUrl),
      text: `${setup || joke.text}\n\n${punchline ? `Réponse : ${punchline}\n\n` : ''}Source : ${joke.source}\n${PUBLIC_URL}\n\nSe désabonner : ${unsubscribeUrl}`,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
  }

  async function addEmail(rawEmail) {
    if (!emailEnabled) return 'disabled';
    const email = String(rawEmail || '').trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) return 'invalid';
    let sub = subs.emails.find((s) => s.email === email);
    if (sub && sub.confirmed) return 'ok'; // same answer either way: no address enumeration
    if (sub && Date.now() - Date.parse(sub.sentAt || 0) < 10 * 60e3) return 'ok';
    if (!sub) {
      if (subs.emails.length >= 50000) return 'full';
      sub = { email, token: crypto.randomBytes(24).toString('base64url'), confirmed: false, createdAt: new Date().toISOString() };
      subs.emails.push(sub);
    }
    sub.sentAt = new Date().toISOString();
    await save();
    const confirmUrl = `${PUBLIC_URL}/email/confirm?token=${sub.token}`;
    await resend('/emails', {
      from: EMAIL_FROM,
      to: [email],
      subject: 'Confirme ton abonnement à la blague plate du jour',
      html: layout(`<h1 style="margin:0 0 12px;font-size:26px;">Une blague plate par jour ?</h1>
<p style="margin:0 0 24px;font-size:17px;line-height:1.5;">Confirme ton adresse pour recevoir la blague du jour par e-mail : à midi en semaine, à minuit le week-end (heure de New York).</p>
<p style="margin:0;"><a href="${escapeHtml(confirmUrl)}" style="display:inline-block;padding:12px 22px;border-radius:980px;background:#0071e3;color:#ffffff;font-size:17px;text-decoration:none;">Confirmer mon abonnement</a></p>
<p style="margin:24px 0 0;font-size:13px;color:#86868b;">Si tu n’as rien demandé, ignore simplement cet e-mail.</p>`),
      text: `Confirme ton abonnement à la blague plate du jour :\n${confirmUrl}\n\nSi tu n’as rien demandé, ignore cet e-mail.`,
    });
    return 'ok';
  }

  async function confirmEmail(token) {
    const sub = subs.emails.find((s) => s.token === token);
    if (!sub) return false;
    if (!sub.confirmed) {
      sub.confirmed = true;
      sub.confirmedAt = new Date().toISOString();
      await save();
    }
    return true;
  }

  async function removeEmail(token) {
    const before = subs.emails.length;
    subs.emails = subs.emails.filter((s) => s.token !== token);
    if (subs.emails.length !== before) await save();
    return subs.emails.length !== before;
  }

  async function emailAll(joke) {
    if (!emailEnabled) return;
    const confirmed = subs.emails.filter((s) => s.confirmed);
    let sent = 0;
    for (let i = 0; i < confirmed.length; i += 100) { // Resend batch: 100 e-mails per call
      const batch = confirmed.slice(i, i + 100);
      try {
        await resend('/emails/batch', batch.map((s) => jokeEmail(joke, s)));
        sent += batch.length;
      } catch (err) {
        console.error('[email] batch failed:', err.message);
      }
    }
    console.log(`[email] sent to ${sent}/${confirmed.length}`);
  }

  async function notifyAll(joke, key) {
    await Promise.all([
      pushAll(joke, key).catch((err) => console.error('[push]', err)),
      emailAll(joke).catch((err) => console.error('[email]', err)),
    ]);
  }

  return {
    publicKey: vapid.publicKey,
    emailEnabled,
    addPush,
    removePush,
    addEmail,
    confirmEmail,
    removeEmail,
    notifyAll,
  };
}

module.exports = { createNotifier, escapeHtml };
