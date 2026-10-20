'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 8002;
const TIME_ZONE = 'America/New_York';
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

function nyDateKey(date = new Date()) {
  const { y, m, d } = nyParts(date);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// UTC instant of the next midnight in New York (DST-safe).
function nextNyMidnight(now = new Date()) {
  const { y, m, d } = nyParts(now);
  // Start from a guess (UTC midnight of next NY day + 5h) and correct with the real offset.
  let guess = Date.UTC(y, m - 1, d + 1, 5, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = nyParts(new Date(guess));
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    const target = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
    guess += target - asUtc;
  }
  return new Date(guess);
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
  const dayKey = nyDateKey();
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

function scheduleMidnightRefresh() {
  const delay = nextNyMidnight().getTime() - Date.now() + 1000;
  setTimeout(async () => {
    await getTodayJoke().catch((err) => console.error(err));
    scheduleMidnightRefresh();
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
  const nextChange = nextNyMidnight();
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
  }), {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
  });
}

async function handleStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath);
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
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/joke') return await handleApi(req, res);
    if (pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': MIME['.txt'] });
    return await handleStatic(req, res, decodeURIComponent(pathname));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Internal error');
  }
});

loadStore();
scheduleMidnightRefresh();
getTodayJoke().catch((err) => console.error(err));
server.listen(PORT, () => console.log(`Dad Jokes listening on :${PORT}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
