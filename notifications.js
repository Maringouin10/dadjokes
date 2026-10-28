'use strict';

// Push notifications (Web Push / VAPID) and e-mails (Resend) for each new joke.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const webpush = require('web-push');
const templates = require('./email-templates');
const config = require('./config');

const { escapeHtml, splitJoke } = templates;

// The server POSTs to subscription endpoints: only accept real browser push services.
const PUSH_HOSTS = [
  'fcm.googleapis.com', 'android.googleapis.com', // Chrome, Edge (Android), Opera, Samsung
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari (macOS, iOS / iPadOS home screen apps)
  'notify.windows.com', // Edge (Windows)
];

const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,255}\.[a-z]{2,}$/i;

function createNotifier({ dataDir, getCurrentJoke }) {
  const file = path.join(dataDir, 'subscribers.json');
  const vapidFile = path.join(dataDir, 'vapid.json');
  let subs = { push: [], emails: [] };
  let vapid = null;
  let subject = null;
  let vapidError = null;

  try {
    subs = { push: [], emails: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch { /* first start */ }

  // VAPID keys: from the settings, or generated once and kept in the data volume.
  // Read once: changing them needs a restart (and drops the current push subscribers).
  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
    vapid = { publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY };
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
  // A bad VAPID_SUBJECT must never crash the server: web-push throws on anything but mailto:/https:.
  // Applied again whenever the settings change.
  function configureVapid() {
    const raw = config.VAPID_SUBJECT;
    subject = /^[^\s@:]+@[^\s@]+$/.test(raw) ? `mailto:${raw}` // plain address
      : raw || (config.PUBLIC_URL.startsWith('https://') ? config.PUBLIC_URL : 'mailto:noreply@example.com');
    vapidError = null;
    try {
      webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
    } catch (err) {
      vapidError = err.message;
      console.error('[push] VAPID config error:', err.message);
      try {
        webpush.setVapidDetails('mailto:noreply@example.com', vapid.publicKey, vapid.privateKey);
      } catch { /* keys themselves are invalid: reported by diagnose(), push stays off */ }
    }
  }
  configureVapid();
  config.onChange(configureVapid);

  const emailEnabled = () => Boolean(config.RESEND_API_KEY && config.EMAIL_FROM && config.PUBLIC_URL);

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
      console.warn(`[push] send to ${new URL(sub.endpoint).hostname} failed: ${err.statusCode || ''} ${err.body || err.message}`);
      return true;
    }
  }

  async function addPush(sub) {
    if (!validPushSubscription(sub)) return false;
    const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
    if (subs.push.some((s) => s.endpoint === clean.endpoint)) return true;
    if (subs.push.length >= 50000) return false;
    subs.push.push({ ...clean, createdAt: new Date().toISOString() });
    await save();
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
      headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text.slice(0, 300);
      try { message = JSON.parse(text).message || message; } catch { /* not JSON */ }
      throw Object.assign(new Error(`Resend ${res.status}: ${message}`), { resendMessage: message });
    }
    return res.json();
  }

  function toResend(sub, email) {
    const unsubscribeUrl = unsubscribeUrlFor(sub);
    return {
      from: config.EMAIL_FROM,
      to: [sub.email],
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
  }

  function unsubscribeUrlFor(sub) {
    return `${config.PUBLIC_URL}/email/unsubscribe?token=${sub.token}`;
  }

  async function addEmail(rawEmail) {
    if (!emailEnabled()) return 'disabled';
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
    const confirmUrl = `${config.PUBLIC_URL}/email/confirm?token=${sub.token}`;
    const message = templates.confirmEmail({ baseUrl: config.PUBLIC_URL, confirmUrl });
    await resend('/emails', { from: config.EMAIL_FROM, to: [sub.email], ...message });
    return 'ok';
  }

  async function confirmEmail(token) {
    const sub = subs.emails.find((s) => s.token === token);
    if (!sub) return false;
    if (!sub.confirmed) {
      sub.confirmed = true;
      sub.confirmedAt = new Date().toISOString();
      await save();
      // Welcome e-mail with today's joke; the confirmation page doesn't wait for it.
      Promise.resolve(getCurrentJoke && getCurrentJoke())
        .then(({ joke, key }) => resend('/emails', toResend(sub, templates.welcomeEmail({
          joke, key, baseUrl: config.PUBLIC_URL, unsubscribeUrl: unsubscribeUrlFor(sub),
        }))))
        .catch((err) => console.error('[email] welcome failed:', err.message));
    }
    return true;
  }

  async function removeEmail(token) {
    const before = subs.emails.length;
    subs.emails = subs.emails.filter((s) => s.token !== token);
    if (subs.emails.length !== before) await save();
    return subs.emails.length !== before;
  }

  async function emailAll(joke, key) {
    if (!emailEnabled()) return;
    const confirmed = subs.emails.filter((s) => s.confirmed);
    let sent = 0;
    for (let i = 0; i < confirmed.length; i += 100) { // Resend batch: 100 e-mails per call
      const batch = confirmed.slice(i, i + 100);
      try {
        await resend('/emails/batch', batch.map((s) => toResend(s, templates.dailyEmail({
          joke, key, baseUrl: config.PUBLIC_URL, unsubscribeUrl: unsubscribeUrlFor(s),
        }))));
        sent += batch.length;
      } catch (err) {
        console.error('[email] batch failed:', err.message);
      }
    }
    console.log(`[email] sent to ${sent}/${confirmed.length}`);
  }

  // Startup report: says plainly what is missing or wrong, without printing secrets.
  async function diagnose() {
    const lines = [];
    const ok = (t) => lines.push(`  ✅ ${t}`);
    const bad = (t) => lines.push(`  ❌ ${t}`);
    const warn = (t) => lines.push(`  ⚠️  ${t}`);

    const PUBLIC_URL = config.PUBLIC_URL;
    const RESEND_API_KEY = config.RESEND_API_KEY;
    const EMAIL_FROM = config.EMAIL_FROM;
    if (!PUBLIC_URL) warn('PUBLIC_URL vide : nécessaire pour les e-mails (ex. https://blague.tondomaine.com)');
    else if (!/^https:\/\//.test(PUBLIC_URL)) warn(`PUBLIC_URL=${PUBLIC_URL} n’est pas en https:// : les notifications push ne marcheront pas dans le navigateur`);
    else ok(`PUBLIC_URL=${PUBLIC_URL}`);

    if (vapidError) bad(`Push : configuration VAPID invalide (${vapidError}). VAPID_SUBJECT doit être une adresse e-mail ou une URL https://`);
    else ok(`Push : prêt (contact ${subject}), ${subs.push.length} abonné(s)`);
    if (!config.VAPID_SUBJECT) warn('VAPID_SUBJECT vide : mets ton adresse e-mail (Apple peut refuser les notifications sinon)');

    const missing = [['RESEND_API_KEY', RESEND_API_KEY], ['EMAIL_FROM', EMAIL_FROM], ['PUBLIC_URL', PUBLIC_URL]]
      .filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      bad(`E-mail désactivé : variable(s) manquante(s) ${missing.join(', ')} (le bouton E-mail reste caché)`);
      return lines;
    }
    if (!RESEND_API_KEY.startsWith('re_')) bad('RESEND_API_KEY ne ressemble pas à une clé Resend (elle commence par re_)');
    const fromDomain = (EMAIL_FROM.match(/@([^>\s]+)>?\s*$/) || [])[1];
    if (!fromDomain) {
      bad(`EMAIL_FROM invalide : « ${EMAIL_FROM} » (format : Nom <adresse@domaine.com> ou adresse@domaine.com)`);
      return lines;
    }
    try {
      const res = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${RESEND_API_KEY}` }, signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.name === 'restricted_api_key') {
        ok(`Resend : clé valide (limitée à l’envoi, domaine ${fromDomain} non vérifiable d’ici)`);
      } else if (!res.ok) {
        bad(`Resend refuse la clé (${res.status}) : ${data.message || 'clé invalide'}`);
      } else if (fromDomain === 'resend.dev') {
        warn('EMAIL_FROM utilise resend.dev : Resend n’envoie alors qu’à l’adresse de ton compte Resend');
      } else {
        const domain = (data.data || []).find((d) => d.name === fromDomain);
        if (!domain) bad(`Le domaine ${fromDomain} (de EMAIL_FROM) n’est pas ajouté dans Resend → resend.com/domains`);
        else if (domain.status !== 'verified') bad(`Le domaine ${fromDomain} n’est pas encore vérifié dans Resend (statut : ${domain.status}) → ajoute les DNS`);
        else ok(`E-mail : Resend OK, domaine ${fromDomain} vérifié`);
      }
    } catch (err) {
      bad(`Impossible de joindre l’API Resend : ${err.message}`);
    }
    return lines;
  }

  async function notifyAll(joke, key) {
    await Promise.all([
      pushAll(joke, key).catch((err) => console.error('[push]', err)),
      emailAll(joke, key).catch((err) => console.error('[email]', err)),
    ]);
  }

  return {
    publicKey: vapid.publicKey,
    get emailEnabled() { return emailEnabled(); },
    addPush,
    removePush,
    addEmail,
    confirmEmail,
    removeEmail,
    notifyAll,
    diagnose,
  };
}

module.exports = { createNotifier, escapeHtml };
