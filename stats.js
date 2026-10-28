'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const QRCode = require('qrcode');
const { escapeHtml } = require('./notifications');
const { labelPdf, posterPdf } = require('./print');
const config = require('./config');

const { TIME_ZONE, SITE_URL, QR_URL, ADMIN_PASSWORD, HUMAN_REFERRERS } = config;
const SESSION_TTL = config.ADMIN_SESSION_DAYS * 86400e3;
const DASHBOARD_DAYS = config.STATS_DAYS;
const MAX_KEYS = 300; // distinct countries/cities/sources kept per day
const KEEP_DAYS = 400;

const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|headless|phantom|puppeteer|playwright|selenium|lighthouse|facebookexternalhit|embedly|discord|telegram|whatsapp|skype|slack/i;

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

function referrerHost(referrer, host) {
  try {
    const name = new URL(referrer).hostname.replace(/^www\./, '');
    return name && name !== String(host).split(':')[0].replace(/^www\./, '') ? name.slice(0, 80) : null;
  } catch {
    return null;
  }
}

// A visit counts as human when it comes from the QR code, the installed app (PWA),
// or a search engine listed in HUMAN_REFERRERS (google by default).
function originOf({ qr, pwa, ref }) {
  if (qr) return 'Code QR';
  if (pwa) return 'Application (PWA)';
  const engine = ref && HUMAN_REFERRERS.find((word) => ref.split('.').includes(word));
  return engine ? `Recherche ${engine[0].toUpperCase()}${engine.slice(1)}` : null;
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

function createStats({ dataDir, ads }) {
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

  const emptyDay = () => ({ views: 0, uniques: 0, others: 0, bots: 0, origins: {}, countries: {}, cities: {}, sources: {}, devices: {} });

  function today() {
    const key = dayKey();
    data.days[key] = { ...emptyDay(), ...data.days[key] };
    const keys = Object.keys(data.days).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete data.days[old];
    const yesterday = dayKey(new Date(Date.now() - 86400e3));
    for (const d of Object.keys(data.hashes)) if (d !== key && d !== yesterday) delete data.hashes[d];
    return data.days[key];
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

  const visitsByIp = new Map();
  function limited(ip) {
    const now = Date.now();
    const recent = (visitsByIp.get(ip) || []).filter((t) => now - t < 3600e3);
    recent.push(now);
    visitsByIp.set(ip, recent);
    if (visitsByIp.size > 10000) visitsByIp.clear();
    return recent.length > 60;
  }

  async function record(req, body) {
    const ip = clientIp(req);
    const ua = String(req.headers['user-agent'] || '');
    if (limited(ip)) return;
    const day = today();
    if (!ua || BOT_UA.test(ua)) {
      day.bots += 1;
      return scheduleSave();
    }
    const ref = referrerHost(body.ref, req.headers.host);
    const origin = originOf({ qr: body.qr === true, pwa: body.pwa === true, ref });
    if (!origin) {
      day.others += 1;
      return scheduleSave();
    }
    const { country, city } = await locate(req, ip);
    const visitor = crypto.createHash('sha256').update(`${data.salt}|${dayKey()}|${ip}|${ua}`).digest('hex').slice(0, 16);
    const seen = (data.hashes[dayKey()] ||= []);
    day.views += 1;
    if (!seen.includes(visitor)) {
      seen.push(visitor);
      day.uniques += 1;
    }
    bump(day.origins, origin);
    bump(day.countries, country);
    if (city) bump(day.cities, `${String(city).slice(0, 60)}, ${country}`);
    bump(day.sources, ref || 'Direct');
    bump(day.devices, deviceOf(ua));
    scheduleSave();
  }

  // ---------- Admin session ----------

  const sessionKey = ADMIN_PASSWORD ? sha256(`dadjokes-admin|${ADMIN_PASSWORD}`) : null;
  const failures = new Map();

  function sessionCookie(secure) {
    const exp = String(Date.now() + SESSION_TTL);
    return `adm=${exp}.${hmac(sessionKey, exp)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${Math.round(SESSION_TTL / 1000)}${secure ? '; Secure' : ''}`;
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
  const download = (res, body, type, name) => reply(res, 200, body, type, { ...ADMIN_HEADERS, 'Content-Disposition': `inline; filename="${name}"` });

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

  async function handleVisit(req, res) {
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    await record(req, {
      qr: body.qr,
      pwa: body.pwa,
      ref: typeof body.ref === 'string' ? body.ref.slice(0, 300) : '',
    });
    return json(res, 200, { ok: true });
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
table{width:100%;border-collapse:collapse}td{padding:7px 0;border-top:1px solid var(--sep);vertical-align:middle}tr:first-child td{border-top:0}td:last-child{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar{display:block;height:4px;border-radius:2px;background:var(--accent);margin-top:4px;opacity:.7}.empty{color:var(--secondary);margin:0}
.chart{display:flex;align-items:flex-end;gap:3px;height:130px}.chart i{flex:1;background:var(--accent);border-radius:3px 3px 0 0;min-height:2px;opacity:.85}
.axis{display:flex;justify-content:space-between;color:var(--secondary);font-size:12px;margin-top:6px}
.qr{display:flex;flex-wrap:wrap;gap:20px;align-items:center}.qr img{width:200px;height:200px;border-radius:12px;background:#fff;padding:8px}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.actions input{width:90px;margin:0}
a.button,button{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:12px;padding:10px 16px;min-height:44px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
a.button.alt,button.alt{background:var(--sep);color:var(--label)}summary{cursor:pointer;color:var(--secondary)}
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
      + `<td>${n.toLocaleString('fr-FR')} <small style="color:var(--secondary)">${Math.round((n / Math.max(1, total)) * 100)} %</small></td></tr>`).join('')}</table>`;
  }

  function dashboard() {
    today();
    const keys = [];
    for (let i = DASHBOARD_DAYS - 1; i >= 0; i--) keys.push(dayKey(new Date(Date.now() - i * 86400e3)));
    const days = keys.map((k) => ({ k, ...emptyDay(), ...data.days[k] }));
    const all = Object.values(data.days);
    const sum = (list, f) => list.reduce((n, d) => n + (f(d) || 0), 0);
    const merge = (field) => {
      const out = {};
      for (const d of days) for (const [k, n] of Object.entries(d[field] || {})) out[k] = (out[k] || 0) + n;
      return Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 12);
    };
    const viewsN = sum(days, (d) => d.views);
    const max = Math.max(1, ...days.map((d) => d.views));
    const fmt = (n) => n.toLocaleString('fr-FR');
    const dayLabel = (k) => k.slice(5).replace('-', '/');
    const last = days[days.length - 1];
    const n = `${DASHBOARD_DAYS} j`;

    return page('Stats · Admin', `<main>
<div class="top"><div><h1>Statistiques</h1><p class="sub">Visites humaines : code QR, application installée ou recherche ${escapeHtml(HUMAN_REFERRERS.join(', '))} · fuseau ${escapeHtml(TIME_ZONE)}</p></div>
<form method="post" action="/admin/logout"><button class="alt" type="submit">Déconnexion</button></form></div>
<div class="kpis">
<div class="kpi"><b>${fmt(sum(all, (d) => d.views))}</b><span>Visites humaines au total</span></div>
<div class="kpi"><b>${fmt(last.views)}</b><span>Aujourd’hui · ${fmt(last.uniques)} visiteurs uniques</span></div>
<div class="kpi"><b>${fmt(sum(days.slice(-7), (d) => d.views))}</b><span>7 derniers jours</span></div>
<div class="kpi"><b>${fmt(viewsN)}</b><span>${n} · ${fmt(sum(days, (d) => d.uniques))} uniques</span></div>
<div class="kpi"><b>${fmt(sum(days, (d) => d.others))}</b><span>Autres visites ${n} (non vérifiées)</span></div>
<div class="kpi"><b>${fmt(sum(days, (d) => d.bots))}</b><span>Robots écartés ${n}</span></div></div>
<div class="card"><h2>Visites humaines par jour</h2>
<div class="chart" role="img" aria-label="Visites par jour sur ${DASHBOARD_DAYS} jours">${days.map((d) => `<i style="height:${Math.round((d.views / max) * 100)}%" title="${dayLabel(d.k)} : ${d.views} visites, ${d.uniques} uniques"></i>`).join('')}</div>
<div class="axis"><span>${dayLabel(keys[0])}</span><span>max ${fmt(max)}/jour</span><span>${dayLabel(keys[keys.length - 1])}</span></div></div>
<div class="grid">
<div class="card"><h2>Arrivés par (${n})</h2>${table(merge('origins'), viewsN)}</div>
<div class="card"><h2>Pays (${n})</h2>${table(merge('countries'), viewsN, undefined, (k) => `${flag(k)} ${escapeHtml(countryName(k))}`)}</div>
<div class="card"><h2>Villes (${n})</h2>${table(merge('cities'), viewsN, 'Pas de ville (nécessite le service de géolocalisation).')}</div>
<div class="card"><h2>Sites d’origine (${n})</h2>${table(merge('sources'), viewsN)}</div>
<div class="card"><h2>Appareils (${n})</h2>${table(merge('devices'), viewsN)}</div></div>
${ads ? ads.adminHtml() : ''}
<div class="card" style="margin-top:16px"><h2>Code QR et impressions</h2><div class="qr">
<img src="/admin/qr.png?size=400" alt="Code QR vers ${escapeHtml(QR_URL)}" width="200" height="200">
<div><p class="sub" style="margin-bottom:12px">Mène à <b>${escapeHtml(QR_URL)}</b> (les scans comptent comme « Code QR »).</p>
<div class="actions" style="margin-bottom:10px"><a class="button" href="/admin/qr.png" download="blaguedujour-qr.png">QR PNG (2048 px)</a>
<a class="button alt" href="/admin/qr.svg" download="blaguedujour-qr.svg">QR SVG</a></div>
<form class="actions" method="get" action="/admin/label.pdf" style="margin-bottom:10px">
<button type="submit">Étiquettes ${config.LABEL_HEIGHT_IN}×${config.LABEL_WIDTH_IN} po (PDF)</button>
<label>× <input name="n" type="number" min="1" max="500" value="1" aria-label="Nombre d’étiquettes"></label></form>
<div class="actions"><a class="button" href="/admin/poster.pdf">Affiche 4 par page (PDF, ${config.POSTER_PAGE === 'A4' ? 'A4' : 'Lettre'})</a></div>
</div></div></div>
</main>`);
  }

  async function handleAdmin(req, res, pathname, searchParams) {
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

    if (pathname === '/admin' || pathname === '/admin/') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
      return isAdmin(req) ? html(res, 200, dashboard()) : html(res, 401, loginPage());
    }

    if (!isAdmin(req)) return reply(res, 404, 'Not found', 'text/plain; charset=utf-8');

    if (pathname === '/admin/ads' && req.method === 'POST' && ads) {
      await ads.handleAdmin(req);
      return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, Location: '/admin' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');

    if (pathname === '/admin/qr.png') {
      const size = Math.min(4096, Math.max(128, Number(searchParams.get('size')) || 2048));
      const png = await QRCode.toBuffer(QR_URL, { errorCorrectionLevel: 'H', type: 'png', width: size, margin: 4 });
      return download(res, png, 'image/png', 'blaguedujour-qr.png');
    }
    if (pathname === '/admin/qr.svg') {
      const svg = await QRCode.toString(QR_URL, { errorCorrectionLevel: 'H', type: 'svg', margin: 4 });
      return download(res, svg, 'image/svg+xml', 'blaguedujour-qr.svg');
    }
    if (pathname === '/admin/label.pdf') {
      const copies = Math.min(500, Math.max(1, Math.floor(Number(searchParams.get('n'))) || 1));
      return download(res, await labelPdf(copies), 'application/pdf', 'blaguedujour-etiquettes.pdf');
    }
    if (pathname === '/admin/poster.pdf') {
      return download(res, await posterPdf(), 'application/pdf', 'blaguedujour-affiche.pdf');
    }
    return reply(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }

  async function handle(req, res, pathname, searchParams) {
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      await handleAdmin(req, res, pathname, searchParams);
      return true;
    }
    if (pathname === '/api/visit' && req.method === 'POST') {
      await handleVisit(req, res);
      return true;
    }
    if (ads && (await ads.handle(req, res, pathname, clientIp(req))) !== false) return true;
    return false;
  }

  function diagnose() {
    if (!ADMIN_PASSWORD) return '/admin désactivé : ADMIN_PASSWORD vide';
    if (ADMIN_PASSWORD.length < 10) return '/admin actif, mais ADMIN_PASSWORD est court (10 caractères minimum conseillés)';
    return `/admin actif · QR vers ${QR_URL}`;
  }

  return { handle, diagnose };
}

module.exports = { createStats };
