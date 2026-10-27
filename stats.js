'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const QRCode = require('qrcode');
const { escapeHtml } = require('./notifications');

const TIME_ZONE = 'America/New_York';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const SITE_URL = PUBLIC_URL || 'https://blaguedujour.lol';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const POW_ZEROS = 4; // leading hex zeros required in sha256(token:nonce) (~65k hashes)
const CHALLENGE_TTL = 10 * 60e3;
const MIN_SOLVE_MS = 2000; // a challenge cannot be answered faster than this
const SESSION_TTL = 7 * 86400e3;
const MAX_KEYS = 300; // distinct countries/cities/sources kept per day
const KEEP_DAYS = 400;
const DASHBOARD_DAYS = 30;

const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|headless|phantom|puppeteer|playwright|selenium|lighthouse|preview|monitor|uptime|scan|fetch|httpclient|libwww|facebookexternalhit|embedly|discord|telegram|whatsapp|skype|slack/i;

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('base64url');

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (date = new Date()) => dayFormat.format(date);

function isPrivateIp(ip) {
  return !ip || ip === '::1' || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip.replace(/^::ffff:/, ''));
}

function clientIp(req) {
  const ip = req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket.remoteAddress
    || '';
  return String(ip).replace(/^::ffff:/, '');
}

function deviceOf(ua) {
  if (/ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return 'Tablette';
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'Mobile';
  return 'Ordinateur';
}

function sourceOf(referrer, host) {
  if (!referrer) return 'Direct';
  try {
    const name = new URL(referrer).hostname.replace(/^www\./, '');
    return !name || name === String(host).split(':')[0].replace(/^www\./, '') ? 'Direct' : name.slice(0, 80);
  } catch {
    return 'Direct';
  }
}

function bump(map, key, n = 1) {
  if (!(key in map) && Object.keys(map).length >= MAX_KEYS) key = 'Autres';
  map[key] = (map[key] || 0) + n;
}

const flag = (code) => (/^[A-Z]{2}$/.test(code)
  ? String.fromCodePoint(...[...code].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65))
  : '🌐');
let countryNames = null;
function countryName(code) {
  if (code === '??') return 'Inconnu';
  try {
    countryNames ||= new Intl.DisplayNames(['fr'], { type: 'region' });
    return countryNames.of(code) || code;
  } catch {
    return code;
  }
}

function createStats({ dataDir }) {
  const file = path.join(dataDir, 'stats.json');
  let data = { salt: crypto.randomBytes(16).toString('hex'), days: {}, hashes: {} };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch { /* first start */ }

  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await fsp.mkdir(dataDir, { recursive: true });
        await fsp.writeFile(`${file}.tmp`, JSON.stringify(data));
        await fsp.rename(`${file}.tmp`, file);
      } catch (err) {
        console.error('[stats] save failed:', err.message);
      }
    }, 5000);
    saveTimer.unref();
  }

  function today() {
    const key = dayKey();
    data.days[key] ||= { views: 0, uniques: 0, bots: 0, countries: {}, cities: {}, sources: {}, devices: {} };
    const keys = Object.keys(data.days).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete data.days[old];
    for (const d of Object.keys(data.hashes)) if (d < key && d !== dayKey(new Date(Date.now() - 86400e3))) delete data.hashes[d];
    return data.days[key];
  }

  // ---------- Challenge (invisible captcha) ----------

  const secret = crypto.randomBytes(32);
  const used = new Map(); // token id -> expiry
  const issuedByIp = new Map();
  const visitsByIp = new Map();

  function limited(map, ip, max, windowMs) {
    const now = Date.now();
    const recent = (map.get(ip) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    map.set(ip, recent);
    if (map.size > 10000) map.clear();
    return recent.length > max;
  }

  function issueChallenge() {
    const payload = b64(JSON.stringify({ i: crypto.randomBytes(8).toString('hex'), t: Date.now() }));
    return { token: `${payload}.${hmac(secret, payload)}`, zeros: POW_ZEROS };
  }

  function verifyChallenge(token, nonce) {
    if (typeof token !== 'string' || typeof nonce !== 'string' || nonce.length > 32) return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig || !safeEqual(sig, hmac(secret, payload))) return false;
    let claim;
    try { claim = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return false; }
    const age = Date.now() - claim.t;
    if (!(age >= MIN_SOLVE_MS && age <= CHALLENGE_TTL) || used.has(claim.i)) return false;
    const hash = crypto.createHash('sha256').update(`${token}:${nonce}`).digest('hex');
    if (!hash.startsWith('0'.repeat(POW_ZEROS))) return false;
    const now = Date.now();
    for (const [id, exp] of used) if (exp < now) used.delete(id);
    used.set(claim.i, now + CHALLENGE_TTL);
    return true;
  }

  // ---------- Geolocation ----------

  const geoCache = new Map();
  async function locate(req, ip) {
    const header = req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country']
      || req.headers['cloudfront-viewer-country'] || req.headers['x-country-code'];
    const city = req.headers['cf-ipcity'] || req.headers['x-vercel-ip-city'];
    if (/^[A-Za-z]{2}$/.test(header || '') && header !== 'XX') {
      return { country: header.toUpperCase(), city: city ? decodeURIComponent(city) : null };
    }
    if (isPrivateIp(ip)) return { country: '??', city: null };
    if (geoCache.has(ip)) return geoCache.get(ip);
    let result = { country: '??', city: null };
    try {
      const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,city`, {
        signal: AbortSignal.timeout(4000),
      });
      const geo = await res.json();
      if (geo.success && /^[A-Z]{2}$/.test(geo.country_code)) result = { country: geo.country_code, city: geo.city || null };
    } catch { /* unknown location */ }
    if (geoCache.size > 5000) geoCache.clear();
    geoCache.set(ip, result);
    return result;
  }

  // ---------- Recording ----------

  async function record(req, body) {
    const ip = clientIp(req);
    const ua = String(req.headers['user-agent'] || '');
    const day = today();
    const { country, city } = await locate(req, ip);
    const visitor = crypto.createHash('sha256').update(`${data.salt}|${dayKey()}|${ip}|${ua}`).digest('hex').slice(0, 16);
    const seen = (data.hashes[dayKey()] ||= []);
    day.views += 1;
    if (!seen.includes(visitor)) {
      seen.push(visitor);
      day.uniques += 1;
    }
    bump(day.countries, country);
    if (city) bump(day.cities, `${String(city).slice(0, 60)}, ${country}`);
    bump(day.sources, sourceOf(body.ref, req.headers.host));
    bump(day.devices, deviceOf(ua));
    scheduleSave();
  }

  function countBot() {
    today().bots += 1;
    scheduleSave();
  }

  // ---------- Admin session ----------

  const sessionKey = ADMIN_PASSWORD ? sha256(`dadjokes-admin|${ADMIN_PASSWORD}`) : null;
  const failures = new Map();

  function sessionCookie(secure) {
    const exp = String(Date.now() + SESSION_TTL);
    return `adm=${exp}.${hmac(sessionKey, exp)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}${secure ? '; Secure' : ''}`;
  }

  function isAdmin(req) {
    if (!sessionKey) return false;
    const m = /(?:^|;\s*)adm=(\d+)\.([\w-]+)/.exec(req.headers.cookie || '');
    return Boolean(m && Number(m[1]) > Date.now() && safeEqual(m[2], hmac(sessionKey, m[1])));
  }

  const isSecure = (req) => req.headers['x-forwarded-proto'] === 'https' || SITE_URL.startsWith('https://') || Boolean(req.socket.encrypted);

  // ---------- HTTP ----------

  function reply(res, status, body, type, extra = {}) {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extra,
    });
    res.end(body);
  }
  const json = (res, status, obj) => reply(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

  const ADMIN_HEADERS = {
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
  };
  const html = (res, status, body, extra = {}) => reply(res, status, body, 'text/html; charset=utf-8', { ...ADMIN_HEADERS, ...extra });

  function readBody(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); chunks.length = 0; return; }
        chunks.push(c);
      });
      req.on('end', () => { if (size <= limit) resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', reject);
    });
  }

  async function handleVisit(req, res, pathname) {
    const ua = String(req.headers['user-agent'] || '');
    const ip = clientIp(req);

    if (pathname === '/api/visit/challenge' && req.method === 'GET') {
      if (!ua || BOT_UA.test(ua)) { countBot(); return json(res, 403, { error: 'bot' }); }
      if (limited(issuedByIp, ip, 20, 3600e3)) return json(res, 429, { error: 'rate' });
      return json(res, 200, issueChallenge());
    }

    if (pathname === '/api/visit' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
      const human = ua && !BOT_UA.test(ua) && body.human === true
        && !limited(visitsByIp, ip, 30, 3600e3) && verifyChallenge(body.token, body.nonce);
      if (!human) { countBot(); return json(res, 202, { ok: false }); }
      await record(req, { ref: typeof body.ref === 'string' ? body.ref.slice(0, 300) : '' });
      return json(res, 200, { ok: true });
    }
    return false;
  }

  const css = `
:root{--bg:#f5f5f7;--card:#fff;--label:#1d1d1f;--secondary:#6e6e73;--accent:#0071e3;--sep:rgba(0,0,0,.08);color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--label:#f5f5f7;--secondary:#a1a1a6;--accent:#2997ff;--sep:rgba(255,255,255,.1)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--label);font:16px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:960px;margin:0 auto;padding:max(20px,env(safe-area-inset-top)) 16px 48px}
h1{font-size:28px;margin:8px 0 4px}h2{font-size:17px;margin:0 0 12px}.sub{color:var(--secondary);margin:0 0 20px}
.card{background:var(--card);border-radius:18px;padding:18px;margin-bottom:16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:var(--card);border-radius:18px;padding:16px}.kpi b{display:block;font-size:30px;line-height:1.1}.kpi span{color:var(--secondary);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}.grid .card{margin:0}
table{width:100%;border-collapse:collapse}td{padding:7px 0;border-top:1px solid var(--sep)}tr:first-child td{border-top:0}td:last-child{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar{display:block;height:4px;border-radius:2px;background:var(--accent);margin-top:4px;opacity:.7}.empty{color:var(--secondary);margin:0}
.chart{display:flex;align-items:flex-end;gap:3px;height:130px}.chart i{flex:1;background:var(--accent);border-radius:3px 3px 0 0;min-height:2px;opacity:.85}
.axis{display:flex;justify-content:space-between;color:var(--secondary);font-size:12px;margin-top:6px}
.qr{display:flex;flex-wrap:wrap;gap:20px;align-items:center}.qr img{width:200px;height:200px;border-radius:12px;background:#fff;padding:8px}
a.button,button{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:12px;padding:12px 18px;min-height:44px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
a.button.alt,button.alt{background:var(--sep);color:var(--label)}
form.login{max-width:340px;margin:20vh auto 0}input{width:100%;min-height:44px;border:1px solid var(--sep);border-radius:12px;padding:10px 14px;font:inherit;background:var(--card);color:var(--label);margin:12px 0}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}`;

  const page = (title, inner) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title><style>${css}</style></head><body>${inner}</body></html>`;

  function loginPage(error) {
    return page('Admin', `<main><form class="card login" method="post" action="/admin/login">
<h1>Admin</h1>${error ? `<p class="sub" role="alert">${escapeHtml(error)}</p>` : ''}
<input type="password" name="password" placeholder="Mot de passe" autocomplete="current-password" autofocus required>
<button type="submit" style="width:100%">Entrer</button></form></main>`);
  }

  function table(rows, total, empty = 'Pas encore de données.', label = (k) => escapeHtml(k)) {
    if (!rows.length) return `<p class="empty">${empty}</p>`;
    const max = rows[0][1];
    return `<table>${rows.map(([k, n]) => `<tr><td>${label(k)}<span class="bar" style="width:${Math.max(2, Math.round((n / max) * 100))}%"></span></td>`
      + `<td>${n.toLocaleString('fr-FR')} <small style="color:var(--secondary)">${Math.round((n / total) * 100)} %</small></td></tr>`).join('')}</table>`;
  }

  function dashboard() {
    today();
    const keys = [];
    for (let i = DASHBOARD_DAYS - 1; i >= 0; i--) keys.push(dayKey(new Date(Date.now() - i * 86400e3)));
    const empty = { views: 0, uniques: 0, bots: 0, countries: {}, cities: {}, sources: {}, devices: {} };
    const days = keys.map((k) => ({ k, ...(data.days[k] || empty) }));
    const all = Object.values(data.days);
    const sum = (list, f) => list.reduce((n, d) => n + (f(d) || 0), 0);
    const merge = (field) => {
      const out = {};
      for (const d of days) for (const [k, n] of Object.entries(d[field] || {})) out[k] = (out[k] || 0) + n;
      return Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 12);
    };
    const views30 = sum(days, (d) => d.views);
    const max = Math.max(1, ...days.map((d) => d.views));
    const fmt = (n) => n.toLocaleString('fr-FR');
    const countries = merge('countries');
    const dayLabel = (k) => k.slice(5).replace('-', '/');

    return page('Stats · Admin', `<main>
<div class="top"><div><h1>Statistiques</h1><p class="sub">Visites humaines uniquement (captcha invisible) · jours en heure de New York</p></div>
<form method="post" action="/admin/logout"><button class="alt" type="submit">Déconnexion</button></form></div>
<div class="kpis">
<div class="kpi"><b>${fmt(sum(all, (d) => d.views))}</b><span>Visites au total</span></div>
<div class="kpi"><b>${fmt(days[days.length - 1].views)}</b><span>Aujourd’hui · ${fmt(days[days.length - 1].uniques)} visiteurs uniques</span></div>
<div class="kpi"><b>${fmt(sum(days.slice(-7), (d) => d.views))}</b><span>7 derniers jours</span></div>
<div class="kpi"><b>${fmt(views30)}</b><span>30 derniers jours · ${fmt(sum(days, (d) => d.uniques))} uniques</span></div>
<div class="kpi"><b>${fmt(sum(all, (d) => d.bots))}</b><span>Robots écartés</span></div></div>
<div class="card"><h2>Visites par jour</h2>
<div class="chart" role="img" aria-label="Visites par jour sur 30 jours">${days.map((d) => `<i style="height:${Math.round((d.views / max) * 100)}%" title="${dayLabel(d.k)} : ${d.views} visites, ${d.uniques} uniques"></i>`).join('')}</div>
<div class="axis"><span>${dayLabel(keys[0])}</span><span>max ${fmt(max)}/jour</span><span>${dayLabel(keys[keys.length - 1])}</span></div></div>
<div class="grid">
<div class="card"><h2>Pays (30 j)</h2>${table(countries, views30, undefined, (k) => `${flag(k)} ${escapeHtml(countryName(k))}`)}</div>
<div class="card"><h2>Villes (30 j)</h2>${table(merge('cities'), views30, 'Pas de ville (nécessite le service de géolocalisation).')}</div>
<div class="card"><h2>Sources (30 j)</h2>${table(merge('sources'), views30)}</div>
<div class="card"><h2>Appareils (30 j)</h2>${table(merge('devices'), views30)}</div></div>
<div class="card" style="margin-top:16px"><h2>Code QR</h2><div class="qr">
<img src="/admin/qr.png?size=400" alt="Code QR vers ${escapeHtml(SITE_URL)}" width="200" height="200">
<div><p class="sub" style="margin-bottom:12px">Mène à <b>${escapeHtml(SITE_URL)}</b><br>Correction d’erreur maximale (H), marge blanche incluse.</p>
<a class="button" href="/admin/qr.png" download="blaguedujour-qr.png">Télécharger le PNG (2048 px)</a>
<a class="button alt" href="/admin/qr.svg" download="blaguedujour-qr.svg">SVG (vectoriel)</a></div></div></div>
</main>`);
  }

  async function handleAdmin(req, res, pathname) {
    if (!ADMIN_PASSWORD) return reply(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const ip = clientIp(req);

    if (pathname === '/admin/login' && req.method === 'POST') {
      const recent = (failures.get(ip) || []).filter((t) => Date.now() - t < 15 * 60e3);
      if (recent.length >= 5) return html(res, 429, loginPage('Trop d’essais, réessaie dans 15 minutes.'));
      const password = new URLSearchParams(await readBody(req)).get('password') || '';
      if (!safeEqual(password, ADMIN_PASSWORD)) {
        recent.push(Date.now());
        failures.set(ip, recent);
        if (failures.size > 5000) failures.clear();
        return html(res, 401, loginPage('Mot de passe incorrect.'));
      }
      failures.delete(ip);
      return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, Location: '/admin', 'Set-Cookie': sessionCookie(isSecure(req)) });
    }

    if (pathname === '/admin/logout' && req.method === 'POST') {
      return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, Location: '/admin', 'Set-Cookie': 'adm=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Strict' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
    if (pathname === '/admin' || pathname === '/admin/') {
      return isAdmin(req) ? html(res, 200, dashboard()) : html(res, 401, loginPage());
    }

    if (!isAdmin(req)) return reply(res, 404, 'Not found', 'text/plain; charset=utf-8');

    if (pathname === '/admin/qr.png') {
      const size = Math.min(4096, Math.max(128, Number(new URLSearchParams(req.url.split('?')[1] || '').get('size')) || 2048));
      const png = await QRCode.toBuffer(SITE_URL, { errorCorrectionLevel: 'H', type: 'png', width: size, margin: 4 });
      return reply(res, 200, png, 'image/png', { 'X-Robots-Tag': 'noindex' });
    }
    if (pathname === '/admin/qr.svg') {
      const svg = await QRCode.toString(SITE_URL, { errorCorrectionLevel: 'H', type: 'svg', margin: 4 });
      return reply(res, 200, svg, 'image/svg+xml', { 'X-Robots-Tag': 'noindex' });
    }
    return reply(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }

  async function handle(req, res, pathname) {
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      await handleAdmin(req, res, pathname);
      return true;
    }
    if (pathname.startsWith('/api/visit')) {
      return (await handleVisit(req, res, pathname)) !== false;
    }
    return false;
  }

  function diagnose() {
    if (!ADMIN_PASSWORD) return '/admin désactivé : ADMIN_PASSWORD vide';
    if (ADMIN_PASSWORD.length < 10) return '/admin actif, mais ADMIN_PASSWORD est court (10 caractères minimum conseillés)';
    return `/admin actif · QR vers ${SITE_URL}`;
  }

  return { handle, diagnose };
}

module.exports = { createStats };
