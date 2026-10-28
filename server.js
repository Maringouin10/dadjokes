'use strict';

const http = require('node:http');

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Without Docker (node server.js), read the .env file next to this script.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env: use the environment */ }
const { createNotifier, escapeHtml } = require('./notifications');
const { createStats } = require('./stats');
const { createAds } = require('./ads');
const config = require('./config');

const PORT = Number(process.env.PORT) || 8002;
const { TIME_ZONE, CHANGE_HOUR, HISTORY_DAYS, SCHEDULE_TEXT } = config;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'jokes.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const USER_AGENT = 'DadJokes daily (https://github.com/maringouin10/dadjokes)';

// Last-resort jokes, used only when every public API is unreachable.
const FALLBACK_JOKES = require('./fallback-jokes.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------- Time helpers (New York day boundaries) ----------

function nyParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

// UTC instant of a wall-clock time in New York (DST-safe). Day overflow (d + 1) is fine.
function nyTimeToUtc(y, m, d, h) {
  const target = Date.UTC(y, m - 1, d, h, 0, 0);
  let guess = target + 5 * 3600e3; // New York is UTC-4 or UTC-5: start close, then correct
  for (let i = 0; i < 3; i++) {
    const p = nyParts(new Date(guess));
    guess += target - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  }
  return new Date(guess);
}

// The joke changes once per calendar day of TIME_ZONE, at CHANGE_HOUR, every day.

function changeTimeOn(y, m, d) {
  return nyTimeToUtc(y, m, d, CHANGE_HOUR);
}

// The current joke period: keyed by the New York date it started on, and when the next one starts.
function jokePeriod(now = new Date()) {
  const { y, m, d } = nyParts(now);
  let day = new Date(Date.UTC(y, m - 1, d));
  if (changeTimeOn(y, m, d) > now) day = new Date(day.getTime() - 86400e3); // today's change is still ahead
  const [py, pm, pd] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
  return {
    key: `${py}-${String(pm).padStart(2, '0')}-${String(pd).padStart(2, '0')}`,
    next: changeTimeOn(py, pm, pd + 1),
  };
}

// ---------- Storage ----------

let store = { days: {} };

function loadStore() {
  try {
    store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!store.days) store.days = {};
  } catch {
    store = { days: {} };
  }
}

async function saveStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(store, null, 2));
  await fsp.rename(tmp, STORE_FILE);
}

function seenIds() {
  return new Set(Object.values(store.days).map((j) => j.id));
}

// ---------- Joke sources ----------

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// Optional: free token from https://www.blagues-api.fr (best French source).
const BLAGUES_API_TOKEN = process.env.BLAGUES_API_TOKEN || '';

// JokeAPI's French jokes are not all well flagged: skip crude or mean ones.
const BLOCKED_WORDS = [
  'niquer?', 'nique', 'phoqu\\p{L}*', 'putes?', 'putain', 'merde', 'cul', 'bites?', 'sexe\\p{L}*', 'nue?s?',
  'pisser', 'chier', 'viol\\p{L}*', 'nazis?', 'hitler', 'juifs?', 'arabes?', 'noirs?', 'nègres?', 'negres?',
  'somali\\p{L}*', 'africains?', 'chinois', 'gays?', 'pd', 'tapettes?', 'handicap\\p{L}*', 'nains?',
  'morts?', 'tuer', 'tué', 'suicid\\p{L}*', 'drogu\\p{L}*', 'alcool\\p{L}*', 'bourrée?s?', 'blondes?', 'seins?',
];
const BLOCKLIST = new RegExp(`(?<!\\p{L})(${BLOCKED_WORDS.join('|')})(?!\\p{L})`, 'iu');

function acceptable(text) {
  return text && text.length <= 400 && !BLOCKLIST.test(text.normalize('NFC'));
}

const SOURCES = [
  async function blaguesApi() {
    if (!BLAGUES_API_TOKEN) throw new Error('no BLAGUES_API_TOKEN');
    const data = await fetchJson(
      'https://www.blagues-api.fr/api/random?disallow=dark&disallow=limit&disallow=beauf&disallow=blondes',
      { Authorization: `Bearer ${BLAGUES_API_TOKEN}` },
    );
    return {
      id: `blagues-api:${data.id}`,
      text: `${data.joke}\n${data.answer}`,
      source: 'Blagues API',
      sourceUrl: 'https://www.blagues-api.fr',
    };
  },
  async function jokeApi() {
    const data = await fetchJson(
      'https://v2.jokeapi.dev/joke/Pun,Misc?lang=fr&safe-mode'
      + '&blacklistFlags=nsfw,religious,political,racist,sexist,explicit',
    );
    if (data.error) throw new Error(data.message || 'JokeAPI error');
    return {
      id: `jokeapi-fr:${data.id}`,
      text: data.type === 'twopart' ? `${data.setup}\n${data.delivery}` : data.joke,
      source: 'JokeAPI',
      sourceUrl: 'https://jokeapi.dev',
    };
  },
];

async function pickNewJoke(dayKey) {
  const seen = seenIds();
  for (const source of SOURCES) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const joke = await source();
        if (acceptable(joke.text) && !seen.has(joke.id)) return { ...joke, lang: 'fr' };
      } catch (err) {
        console.warn(`[joke] ${source.name} failed: ${err.message}`);
        break;
      }
    }
  }
  // Deterministic fallback based on the day, so it stays stable all day.
  const index = Number(dayKey.replaceAll('-', '')) % FALLBACK_JOKES.length;
  return {
    id: `fallback:${index}`,
    text: FALLBACK_JOKES[index],
    source: 'Collection locale (API indisponibles)',
    sourceUrl: null,
    lang: 'fr',
    fallback: true,
  };
}

let pending = null;

async function getTodayJoke() {
  const dayKey = jokePeriod().key;
  const existing = store.days[dayKey];
  // A fallback joke is retried (at most every 10 min) in case the APIs are back.
  // Jokes stored before the switch to French (no lang) are replaced.
  const fresh = existing && existing.lang === 'fr' && (!existing.fallback || Date.now() - Date.parse(existing.fetchedAt) < 10 * 60e3);
  if (fresh) return { dayKey, joke: existing };
  if (!pending) {
    pending = (async () => {
      const joke = await pickNewJoke(dayKey);
      store.days[dayKey] = { ...joke, fetchedAt: new Date().toISOString() };
      await saveStore().catch((err) => console.error('[store] save failed:', err.message));
      console.log(`[joke] ${dayKey}: ${joke.id}`);
    })().finally(() => { pending = null; });
  }
  await pending;
  return { dayKey, joke: store.days[dayKey] };
}

// Sends push notifications and e-mails once per joke period.
async function notifyNewJoke() {
  const { dayKey, joke } = await getTodayJoke();
  if (store.notified === dayKey) return;
  store.notified = dayKey;
  await saveStore().catch((err) => console.error('[store] save failed:', err.message));
  console.log(`[notify] ${dayKey}`);
  await notifier.notifyAll(joke, dayKey);
}

function scheduleRefresh() {
  // setTimeout caps at ~24.8 days; periods last 36 h at most.
  const delay = jokePeriod().next.getTime() - Date.now() + 1000;
  setTimeout(async () => {
    await notifyNewJoke().catch((err) => console.error(err));
    scheduleRefresh();
  }, delay);
}

// ---------- HTTP ----------

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

async function handleApi(req, res) {
  const { dayKey, joke } = await getTodayJoke();
  const nextChange = jokePeriod().next;
  // Two-part jokes are stored as "setup\npunchline".
  const [setup, ...rest] = joke.text.split('\n');
  const punchline = rest.join('\n').trim() || null;
  send(res, 200, JSON.stringify({
    date: dayKey,
    timeZone: TIME_ZONE,
    joke: joke.text,
    setup: punchline ? setup : null,
    punchline,
    source: joke.source,
    sourceUrl: joke.sourceUrl,
    nextChangeAt: nextChange.toISOString(),
    schedule: SCHEDULE_TEXT,
  }), {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
  });
}

// ---------- History ----------

// Jokes of the previous periods, newest first, from at most HISTORY_DAYS days before the current one.
function handleHistory(req, res) {
  const { key } = jokePeriod();
  const [y, m, d] = key.split('-').map(Number);
  const oldest = new Date(Date.UTC(y, m - 1, d - HISTORY_DAYS)).toISOString().slice(0, 10);
  const jokes = Object.entries(store.days)
    .filter(([day, joke]) => day < key && day >= oldest && joke.lang === 'fr')
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([day, joke]) => {
      const [setup, ...rest] = joke.text.split('\n');
      const punchline = rest.join('\n').trim() || null;
      return {
        date: day,
        joke: joke.text,
        setup: punchline ? setup : null,
        punchline,
        source: joke.source,
        sourceUrl: joke.sourceUrl,
      };
    });
  sendJson(res, 200, { days: HISTORY_DAYS, jokes });
}

// ---------- Subscriptions ----------

function readJson(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        chunks.length = 0; // keep draining so the 413 reaches the client
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > limit) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Small in-memory limit on subscription endpoints: 10 requests per minute per IP.
const hits = new Map();
function rateLimited(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60e3);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10000) hits.clear();
  return recent.length > 10;
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
}

function sendPage(res, status, title, message) {
  send(res, status, `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/styles.css"></head><body><main class="page message-page">
<div class="card"><div><h1 class="title">${escapeHtml(title)}</h1><p class="message">${escapeHtml(message)}</p>
<p><a class="button" href="/">Voir la blague du jour</a></p></div></div></main></body></html>`, {
    'Content-Type': MIME['.html'], 'Cache-Control': 'no-store',
  });
}

async function handleSubscriptions(req, res, pathname, searchParams) {
  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { pushPublicKey: notifier.publicKey, email: notifier.emailEnabled });
  }

  if (req.method === 'POST' && pathname.startsWith('/api/') && rateLimited(req)) {
    return sendJson(res, 429, { error: 'Trop de demandes, réessaie dans une minute.' });
  }

  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    const body = await readJson(req);
    const ok = await notifier.addPush(body.subscription);
    return sendJson(res, ok ? 201 : 400, ok ? { ok } : { error: 'Abonnement invalide.' });
  }
  if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    const body = await readJson(req);
    if (typeof body.endpoint === 'string') await notifier.removePush(body.endpoint);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/email/subscribe' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const result = await notifier.addEmail(body.email);
      if (result === 'invalid') return sendJson(res, 400, { error: 'Adresse e-mail invalide.' });
      if (result === 'disabled') return sendJson(res, 503, { error: 'Les e-mails ne sont pas configurés.' });
      if (result === 'full') return sendJson(res, 503, { error: 'Les inscriptions sont pleines.' });
      return sendJson(res, 202, { ok: true });
    } catch (err) {
      console.error('[email] subscribe failed:', err.message);
      return sendJson(res, 502, {
        error: err.resendMessage
          ? `Envoi refusé par Resend : ${err.resendMessage}`
          : 'Impossible d’envoyer l’e-mail de confirmation pour le moment.',
      });
    }
  }

  const token = searchParams.get('token') || '';
  if (pathname === '/email/confirm' && req.method === 'GET') {
    return await notifier.confirmEmail(token)
      ? sendPage(res, 200, 'Abonnement confirmé', `Tu recevras la blague plate du jour par e-mail, ${SCHEDULE_TEXT}.`)
      : sendPage(res, 404, 'Lien invalide', 'Ce lien de confirmation n’est plus valide.');
  }
  if (pathname === '/email/unsubscribe') {
    const removed = await notifier.removeEmail(token);
    if (req.method === 'POST') return send(res, 200, 'ok'); // one-click unsubscribe from mail apps
    return sendPage(res, 200, 'Désabonné', removed
      ? 'Tu ne recevras plus la blague du jour par e-mail.'
      : 'Cette adresse n’est déjà plus abonnée.');
  }
  return false;
}

async function handleStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  try {
    let data = await fsp.readFile(filePath);
    const ext = path.extname(filePath);
    if (ext === '.html') data = data.toString('utf8').replaceAll('%SCHEDULE%', escapeHtml(SCHEDULE_TEXT));
    send(res, 200, req.method === 'HEAD' ? undefined : data, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': MIME['.txt'] });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (await stats.handle(req, res, pathname, searchParams)) return;
    if ((await handleSubscriptions(req, res, pathname, searchParams)) !== false) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (pathname === '/api/joke') return await handleApi(req, res);
    if (pathname === '/api/history') return handleHistory(req, res);
    if (pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': MIME['.txt'] });
    return await handleStatic(req, res, decodeURIComponent(pathname));
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, err.status ? err.message : 'Internal error');
  }
});

loadStore();
const ads = createAds({ dataDir: DATA_DIR });
const stats = createStats({ dataDir: DATA_DIR, ads });
console.log(`[stats] ${stats.diagnose()}`);
const notifier = createNotifier({
  dataDir: DATA_DIR,
  getCurrentJoke: () => getTodayJoke().then(({ dayKey, joke }) => ({ key: dayKey, joke })),
});
// First start: nothing to catch up on. After downtime across a change: send the missed one.
if (!store.notified) store.notified = jokePeriod().key;
scheduleRefresh();
notifyNewJoke().catch((err) => console.error(err));
server.listen(PORT, () => console.log(`Dad Jokes listening on :${PORT}`));
notifier.diagnose().then((lines) => console.log(['[config] Notifications :', ...lines].join('\n')));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
