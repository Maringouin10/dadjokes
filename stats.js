'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const QRCode = require('qrcode');
const { escapeHtml } = require('./notifications');
const { labelPdf, labelPng, posterPdf } = require('./print');
const config = require('./config');

const MAX_KEYS = 300; // distinct countries/cities/sources kept per day
const KEEP_DAYS = 400;

const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|headless|phantom|puppeteer|playwright|selenium|lighthouse|facebookexternalhit|embedly|discord|telegram|whatsapp|skype|slack/i;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('base64url');

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));
}

let hourFormat = null;
function hourOf(date = new Date()) {
  if (hourFormat?.resolvedOptions().timeZone !== config.TIME_ZONE) {
    hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: config.TIME_ZONE, hour: 'numeric', hourCycle: 'h23' });
  }
  return Number(hourFormat.format(date)) % 24;
}

let dayFormat = null;
function dayKey(date = new Date()) {
  if (dayFormat?.resolvedOptions().timeZone !== config.TIME_ZONE) {
    dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: config.TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  return dayFormat.format(date);
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
  const engine = ref && config.HUMAN_REFERRERS.find((word) => ref.split('.').includes(word));
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

function createStats({ dataDir, ads, diagnose: diagnoseNotifications, getJokes = () => ({}) }) {
  const file = path.join(dataDir, 'stats.json');
  let data = { salt: crypto.randomBytes(16).toString('hex'), days: {}, hashes: {}, installs: {}, campaigns: {} };
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

  // Country and city from the proxy's headers (Cloudflare…) only.
  async function locate(req) {
    const header = req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country']
      || req.headers['cloudfront-viewer-country'] || req.headers['x-country-code'];
    const city = req.headers['cf-ipcity'] || req.headers['x-vercel-ip-city'];
    if (/^[A-Za-z]{2}$/.test(header || '') && header !== 'XX') {
      return { country: header.toUpperCase(), city: city ? decodeURIComponent(city) : null };
    }
    // No third-party geolocation: the IP address never leaves the server (Loi 25, privacy by default).
    return { country: '??', city: null };
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
    const origin = originOf({ qr: body.qr === true || typeof body.qr === 'string', pwa: body.pwa === true, ref });
    const campaign = typeof body.qr === 'string' && Object.hasOwn(data.campaigns, body.qr) ? body.qr : null;
    if (!origin) {
      day.others += 1;
      return scheduleSave();
    }
    if (body.pwa === true && typeof body.install === 'string' && /^[a-f0-9]{32}$/.test(body.install)) {
      const known = data.installs[body.install];
      if (known) known.last = dayKey();
      else if (Object.keys(data.installs).length < 100000) data.installs[body.install] = { first: dayKey(), last: dayKey(), device: deviceOf(ua) };
    }
    const { country, city } = await locate(req);
    const visitor = crypto.createHash('sha256').update(`${data.salt}|${dayKey()}|${ip}|${ua}`).digest('hex').slice(0, 16);
    const seen = (data.hashes[dayKey()] ||= []);
    day.views += 1;
    const hour = hourOf();
    (day.hours ||= Array(24).fill(0))[hour] += 1;
    if (!seen.includes(visitor)) {
      seen.push(visitor);
      day.uniques += 1;
    }
    if (campaign) {
      const c = ((day.campaigns ||= {})[campaign] ||= { views: 0, uniques: 0 });
      c.views += 1;
      (c.hours ||= Array(24).fill(0))[hour] += 1;
      if (!seen.includes(`${campaign}:${visitor}`)) {
        seen.push(`${campaign}:${visitor}`);
        c.uniques += 1;
      }
    }
    bump(day.origins, origin);
    bump(day.countries, country);
    if (city) bump(day.cities, `${String(city).slice(0, 60)}, ${country}`);
    bump(day.sources, ref || 'Direct');
    bump(day.devices, deviceOf(ua));
    scheduleSave();
  }

  // ---------- Admin session ----------

  // Derived from the password: changing it signs every session out.
  const sessionKey = () => (config.ADMIN_PASSWORD ? sha256(`dadjokes-admin|${config.ADMIN_PASSWORD}`) : null);
  const failures = new Map();

  function sessionCookie(secure) {
    const ttl = config.ADMIN_SESSION_DAYS * 86400e3;
    const exp = String(Date.now() + ttl);
    return `adm=${exp}.${hmac(sessionKey(), exp)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${Math.round(ttl / 1000)}${secure ? '; Secure' : ''}`;
  }

  function isAdmin(req) {
    const key = sessionKey();
    if (!key) return false;
    const m = /(?:^|;\s*)adm=(\d+)\.([\w-]+)/.exec(req.headers.cookie || '');
    return Boolean(m && Number(m[1]) > Date.now() && safeEqual(m[2], hmac(key, m[1])));
  }

  const isSecure = (req) => req.headers['x-forwarded-proto'] === 'https' || config.SITE_URL.startsWith('https://') || Boolean(req.socket.encrypted);

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
      qr: typeof body.qr === 'string' ? body.qr.slice(0, 40) : body.qr,
      pwa: body.pwa,
      install: body.install,
      ref: typeof body.ref === 'string' ? body.ref.slice(0, 300) : '',
    });
    return json(res, 200, { ok: true });
  }

  const css = `
:root{--bg:#dbf2fc;--card:#fff;--label:#072d59;--secondary:#4a6385;--accent:#fd6e88;--on-accent:#072d59;--sep:rgba(7,45,89,.1);color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#041c38;--card:#072d59;--label:#dbf2fc;--secondary:#a6c3dc;--accent:#fd6e88;--sep:rgba(219,242,252,.12)}}
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
a.button,button{display:inline-block;background:var(--accent);color:var(--on-accent);border:0;border-radius:12px;padding:10px 16px;min-height:44px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
a.button.alt,button.alt{background:var(--sep);color:var(--label)}summary{cursor:pointer;color:var(--secondary)}
form.login{max-width:340px;margin:20vh auto 0}input{width:100%;min-height:44px;border:1px solid var(--sep);border-radius:12px;padding:10px 14px;font:inherit;background:var(--card);color:var(--label);margin:12px 0}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.settings .field{display:flex;flex-direction:column;gap:2px;padding:10px 0;border-top:1px solid var(--sep)}.settings h2+.field{border-top:0}
.settings label{font-weight:600}.settings input,.settings textarea,.settings select{margin:4px 0}
textarea,select{width:100%;min-height:44px;border:1px solid var(--sep);border-radius:12px;padding:10px 14px;font:inherit;background:var(--card);color:var(--label);resize:vertical}
.help{color:var(--secondary)}code{font-size:12px}.reset{font-weight:400!important;color:var(--secondary);display:flex;gap:6px;align-items:center}.reset input{width:auto;min-height:0;margin:0}
.tag{font-weight:500;font-size:11px;padding:1px 7px;border-radius:8px;background:var(--sep);color:var(--secondary)}.tag-admin{background:var(--accent);color:var(--on-accent)}
.notice{margin-bottom:16px}.error{color:#d70015}
.seg{display:flex;gap:4px;padding:4px;margin:0 0 16px;background:var(--sep);border-radius:12px;width:max-content;max-width:100%;overflow-x:auto}.seg a{padding:8px 14px;border-radius:9px;color:var(--label);text-decoration:none;font-weight:600;font-size:14px;white-space:nowrap}.seg a[aria-current]{background:var(--card);box-shadow:0 1px 3px rgba(7,45,89,.15)}
.savebar{position:sticky;bottom:0;padding:12px 0 max(12px,env(safe-area-inset-bottom));background:linear-gradient(transparent,var(--bg) 40%)}.savebar button{width:100%}`;

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

  // ---------- Periods: hour, day, week, month, year ----------

  const VIEWS = { heure: 'Heure', jour: 'Jour', semaine: 'Semaine', mois: 'Mois', annee: 'Année' };
  const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const short = (k) => `${k.slice(8)}/${k.slice(5, 7)}`;

  // Calendar days from `from` to `to` (YYYY-MM-DD, inclusive).
  function dayRange(from, to) {
    const out = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400e3) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }
  const shift = (k, days) => new Date(Date.parse(`${k}T00:00:00Z`) + days * 86400e3).toISOString().slice(0, 10);

  // Buckets of the chosen view. Each has a label, its days (for totals and tables) and, for the
  // hour view, the hour. `name` describes the whole period.
  function periodOf(view) {
    const todayKey = dayKey();
    if (view === 'heure') {
      const buckets = [];
      for (let i = 23; i >= 0; i--) {
        const d = new Date(Date.now() - i * 3600e3);
        const h = hourOf(d);
        buckets.push({ label: `${h} h`, title: `${short(dayKey(d))} ${h} h`, keys: [dayKey(d)], hour: h });
      }
      return { name: '24 dernières heures', unit: 'heure', buckets, keys: [...new Set(buckets.map((b) => b.keys[0]))] };
    }
    if (view === 'semaine') {
      const monday = shift(todayKey, -((new Date(`${todayKey}T00:00:00Z`).getUTCDay() + 6) % 7));
      const buckets = [];
      for (let w = 11; w >= 0; w--) {
        const start = shift(monday, -7 * w);
        buckets.push({ label: short(start), title: `semaine du ${short(start)}`, keys: dayRange(start, shift(start, 6)).filter((k) => k <= todayKey) });
      }
      return { name: '12 dernières semaines', unit: 'semaine', buckets, keys: buckets.flatMap((b) => b.keys) };
    }
    if (view === 'mois') {
      const [y, m] = todayKey.split('-').map(Number);
      const buckets = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(Date.UTC(y, m - 1 - i, 1));
        const prefix = d.toISOString().slice(0, 7);
        const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
        const label = `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
        buckets.push({ label, title: label, keys: dayRange(`${prefix}-01`, end).filter((k) => k <= todayKey) });
      }
      return { name: '12 derniers mois', unit: 'mois', buckets, keys: buckets.flatMap((b) => b.keys) };
    }
    if (view === 'annee') {
      const first = Object.keys(data.days).sort()[0] || todayKey;
      const buckets = [];
      for (let y = Number(first.slice(0, 4)); y <= Number(todayKey.slice(0, 4)); y++) {
        buckets.push({ label: String(y), title: String(y), keys: dayRange(`${y}-01-01`, `${y}-12-31`).filter((k) => k >= first && k <= todayKey) });
      }
      return { name: buckets.length > 1 ? 'toutes les années' : `année ${todayKey.slice(0, 4)}`, unit: 'année', buckets, keys: buckets.flatMap((b) => b.keys) };
    }
    const buckets = lastDays(config.STATS_DAYS).map((k) => ({ label: short(k), title: short(k), keys: [k] }));
    return { name: `${config.STATS_DAYS} derniers jours`, unit: 'jour', buckets, keys: buckets.map((b) => b.keys[0]) };
  }

  // Views and uniques of each bucket. `pick(day)` gives the counters to read ({ views, uniques, hours }).
  // Uniques are summed per day (a visitor coming back another day counts again); none per hour.
  function seriesOf(period, pick) {
    return period.buckets.map((b) => {
      if (b.hour !== undefined) return { ...b, views: pick(data.days[b.keys[0]])?.hours?.[b.hour] || 0, uniques: null };
      let views = 0;
      let uniques = 0;
      for (const k of b.keys) { const c = pick(data.days[k]); views += c?.views || 0; uniques += c?.uniques || 0; }
      return { ...b, views, uniques };
    });
  }

  function viewSelector(view, base) {
    return `<nav class="seg" aria-label="Période">${Object.entries(VIEWS).map(([v, label]) => `<a href="${base}?vue=${v}"${v === view ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  }

  function chartHtml(series, unitLabel) {
    const fmt = (n) => n.toLocaleString('fr-FR');
    const max = Math.max(1, ...series.map((b) => b.views));
    const tip = (b) => `${b.title} : ${fmt(b.views)} ${unitLabel}${b.uniques !== null ? `, ${fmt(b.uniques)} uniques` : ''}`;
    return `<div class="chart" role="img" aria-label="${escapeHtml(unitLabel)} par période">${series.map((b) => `<i style="height:${Math.round((b.views / max) * 100)}%" title="${escapeHtml(tip(b))}"></i>`).join('')}</div>
<div class="axis"><span>${escapeHtml(series[0].label)}</span><span>max ${fmt(max)}</span><span>${escapeHtml(series[series.length - 1].label)}</span></div>`;
  }

  // ---------- QR codes per place ----------
  // Each one points to QR_URL with ?qr=<slug>; its scans are counted apart (views and uniques per day).

  function slugify(name) {
    const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'qr';
    let slug = base;
    for (let i = 2; Object.hasOwn(data.campaigns, slug) || slug === 'new'; i++) slug = `${base}-${i}`;
    return slug;
  }

  function campaignUrl(slug) {
    if (!slug) return config.QR_URL;
    const url = new URL(config.QR_URL);
    url.searchParams.set('qr', slug);
    return url.toString();
  }

  function campaignTotals(slug, keys) {
    const pick = (k) => data.days[k]?.campaigns?.[slug] || { views: 0, uniques: 0 };
    const all = Object.keys(data.days).reduce((n, k) => n + pick(k).views, 0);
    const period = keys.map((k) => ({ k, ...pick(k) }));
    return { all, period, views: period.reduce((n, d) => n + d.views, 0), uniques: period.reduce((n, d) => n + d.uniques, 0) };
  }

  const fileName = (slug, suffix) => `blaguedujour-${slug || 'qr'}${suffix}`;

  function downloadLinks(slug) {
    const q = slug ? `?c=${encodeURIComponent(slug)}` : '';
    return `<a class="button" href="/admin/qr.png${q}" download="${fileName(slug, '.png')}">QR PNG</a>
<a class="button alt" href="/admin/qr.svg${q}" download="${fileName(slug, '.svg')}">QR SVG</a>
<a class="button alt" href="/admin/label.png${q}" download="${fileName(slug, '-etiquette.png')}">Étiquette PNG</a>
<a class="button alt" href="/admin/label.pdf${q}">Étiquette PDF</a>
<a class="button alt" href="/admin/poster.pdf${q}">Affiche PDF</a>`;
  }

  function lastDays(count) {
    const keys = [];
    for (let i = count - 1; i >= 0; i--) keys.push(dayKey(new Date(Date.now() - i * 86400e3)));
    return keys;
  }

  function campaignsCard() {
    const keys = lastDays(config.STATS_DAYS);
    const fmt = (n) => n.toLocaleString('fr-FR');
    const rows = Object.entries(data.campaigns)
      .map(([slug, c]) => ({ slug, ...c, ...campaignTotals(slug, keys) }))
      .sort((a, b) => b.views - a.views)
      .map((c) => `<tr><td><a href="/admin/qr/${encodeURIComponent(c.slug)}" style="color:var(--label);font-weight:600">${escapeHtml(c.name)}</a>
<br><small style="color:var(--secondary)">${escapeHtml(campaignUrl(c.slug))}</small></td>
<td>${fmt(c.views)} <small style="color:var(--secondary)">${config.STATS_DAYS} j · ${fmt(c.uniques)} uniques · ${fmt(c.all)} au total</small></td></tr>`).join('');
    return `<div class="card" style="margin-top:16px"><h2>Codes QR par lieu</h2>
<p class="sub" style="margin-bottom:12px">Crée un code QR pour une école, un local… Ses scans sont comptés à part.</p>
<form class="actions" method="post" action="/admin/qr/new" style="margin-bottom:12px">
<input name="name" required maxlength="60" placeholder="Nom (ex. École Sainte-Marie)" style="flex:1;min-width:200px;width:auto;margin:0">
<button type="submit">Créer le code QR</button></form>
${rows ? `<table>${rows}</table>` : '<p class="empty">Aucun code QR par lieu pour l’instant.</p>'}</div>`;
  }

  function campaignPage(slug, view = 'jour') {
    const c = data.campaigns[slug];
    const period = periodOf(view);
    const pick = (d) => d?.campaigns?.[slug];
    const series = seriesOf(period, pick);
    const fmt = (n) => n.toLocaleString('fr-FR');
    const sum = (list, f) => list.reduce((n, x) => n + (f(x) || 0), 0);
    const today = pick(data.days[dayKey()]) || { views: 0, uniques: 0 };
    const total = Object.values(data.days).reduce((n, d) => n + (pick(d)?.views || 0), 0);
    const views = sum(series, (b) => b.views);
    return page(`${c.name} · Admin`, `<main>
<div class="top"><div><h1>${escapeHtml(c.name)}</h1><p class="sub">Code QR créé le ${escapeHtml(c.createdAt.slice(0, 10))} · mène à <b>${escapeHtml(campaignUrl(slug))}</b></p></div>
<div class="actions"><a class="button alt" href="/admin">← Statistiques</a></div></div>
${viewSelector(view, `/admin/qr/${encodeURIComponent(slug)}`)}
<div class="kpis">
<div class="kpi"><b>${fmt(views)}</b><span>${escapeHtml(period.name)}${view === 'heure' ? '' : ` · ${fmt(sum(series, (b) => b.uniques))} uniques`}</span></div>
<div class="kpi"><b>${fmt(today.views)}</b><span>Aujourd’hui · ${fmt(today.uniques)} uniques</span></div>
<div class="kpi"><b>${fmt(total)}</b><span>Scans au total</span></div></div>
<div class="card"><h2>Scans par ${escapeHtml(period.unit)} · ${escapeHtml(period.name)}</h2>
${chartHtml(series, 'scans')}</div>
<div class="card"><h2>Télécharger</h2><div class="qr">
<img src="/admin/qr.png?size=400&amp;c=${encodeURIComponent(slug)}" alt="Code QR ${escapeHtml(c.name)}" width="200" height="200">
<div class="actions">${downloadLinks(slug)}</div></div></div>
<div class="card"><h2>Supprimer</h2><p class="sub">Le code QR imprimé continuera de mener au site, mais ses scans ne seront plus comptés à part.</p>
<form method="post" action="/admin/qr/${encodeURIComponent(slug)}/delete"><button class="alt" type="submit">Supprimer ce code QR</button></form></div>
</main>`);
  }

  // ---------- Joke ratings ----------

  function ratingsCard() {
    const days = Object.entries(getJokes()).filter(([, j]) => j.ratings?.count).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 14);
    if (!days.length) return '<div class="card" style="margin-top:16px"><h2>Notes des blagues</h2><p class="empty">Pas encore de note.</p></div>';
    const rows = days.map(([day, j]) => {
      const avg = j.ratings.sum / j.ratings.count;
      return `<tr><td>${escapeHtml(day.slice(5).replace('-', '/'))} · ${escapeHtml(j.text.split('\n')[0].slice(0, 70))}<span class="bar" style="width:${Math.round(avg * 10)}%"></span></td>
<td><b>${avg.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}</b>/10 <small style="color:var(--secondary)">${j.ratings.count} vote${j.ratings.count > 1 ? 's' : ''}</small></td></tr>`;
    }).join('');
    return `<div class="card" style="margin-top:16px"><h2>Notes des blagues (sur 10)</h2><table>${rows}</table></div>`;
  }

  function dashboard(view = 'jour') {
    today();
    const QR_URL = config.QR_URL;
    const period = periodOf(view);
    const series = seriesOf(period, (d) => d);
    const days = period.keys.map((k) => ({ k, ...emptyDay(), ...data.days[k] }));
    const all = Object.values(data.days);
    const sum = (list, f) => list.reduce((n, d) => n + (f(d) || 0), 0);
    const merge = (field) => {
      const out = {};
      for (const d of days) for (const [k, n] of Object.entries(d[field] || {})) out[k] = (out[k] || 0) + n;
      return Object.entries(out).sort((x, y) => y[1] - x[1]).slice(0, 12);
    };
    const viewsN = sum(series, (b) => b.views);
    const uniquesN = view === 'heure' ? null : sum(series, (b) => b.uniques);
    const fmt = (n) => n.toLocaleString('fr-FR');
    const last = { ...emptyDay(), ...data.days[dayKey()] };
    // Tables and other counters: whole days of the period (for "Heure": today and yesterday).
    const n = view === 'heure' ? 'aujourd’hui et hier' : period.name;
    const installs = Object.values(data.installs || {});

    return page('Stats · Admin', `<main>
<div class="top"><div><h1>Statistiques</h1><p class="sub">Visites humaines : code QR, application installée ou recherche ${escapeHtml(config.HUMAN_REFERRERS.join(', '))} · fuseau ${escapeHtml(config.TIME_ZONE)}</p></div>
<div class="actions"><a class="button alt" href="/admin/settings">Réglages</a><form method="post" action="/admin/logout"><button class="alt" type="submit">Déconnexion</button></form></div></div>
${viewSelector(view, '/admin')}
<div class="kpis">
<div class="kpi"><b>${fmt(viewsN)}</b><span>${escapeHtml(period.name)}${uniquesN !== null ? ` · ${fmt(uniquesN)} uniques` : ''}</span></div>
<div class="kpi"><b>${fmt(last.views)}</b><span>Aujourd’hui · ${fmt(last.uniques)} visiteurs uniques</span></div>
<div class="kpi"><b>${fmt(sum(all, (d) => d.views))}</b><span>Visites humaines au total</span></div>
<div class="kpi"><b>${fmt(installs.length)}</b><span>Applis installées (PWA) · ${fmt(installs.filter((i) => i.last >= period.keys[0]).length)} ouvertes (${escapeHtml(n)})</span></div>
<div class="kpi"><b>${fmt(sum(days, (d) => d.others))}</b><span>Autres visites, non vérifiées (${escapeHtml(n)})</span></div>
<div class="kpi"><b>${fmt(sum(days, (d) => d.bots))}</b><span>Robots écartés (${escapeHtml(n)})</span></div></div>
<div class="card"><h2>Visites humaines par ${escapeHtml(period.unit)} · ${escapeHtml(period.name)}</h2>
${chartHtml(series, 'visites')}</div>
<div class="grid">
<div class="card"><h2>Arrivés par (${escapeHtml(n)})</h2>${table(merge('origins'), sum(days, (d) => d.views))}</div>
<div class="card"><h2>Pays (${escapeHtml(n)})</h2>${table(merge('countries'), sum(days, (d) => d.views), undefined, (k) => `${flag(k)} ${escapeHtml(countryName(k))}`)}</div>
<div class="card"><h2>Villes (${escapeHtml(n)})</h2>${table(merge('cities'), sum(days, (d) => d.views), 'Pas de ville (active « Add visitor location headers » dans Cloudflare).')}</div>
<div class="card"><h2>Sites d’origine (${escapeHtml(n)})</h2>${table(merge('sources'), sum(days, (d) => d.views))}</div>
<div class="card"><h2>Appareils (${escapeHtml(n)})</h2>${table(merge('devices'), sum(days, (d) => d.views))}</div></div>
${ads ? ads.adminHtml() : ''}
${ratingsCard()}
${campaignsCard()}
<div class="card" style="margin-top:16px"><h2>Code QR et impressions</h2><div class="qr">
<img src="/admin/qr.png?size=400" alt="Code QR vers ${escapeHtml(QR_URL)}" width="200" height="200">
<div><p class="sub" style="margin-bottom:12px">Mène à <b>${escapeHtml(QR_URL)}</b> (les scans comptent comme « Code QR »).</p>
<div class="actions" style="margin-bottom:10px"><a class="button" href="/admin/qr.png" download="blaguedujour-qr.png">QR PNG (2048 px)</a>
<a class="button alt" href="/admin/qr.svg" download="blaguedujour-qr.svg">QR SVG</a></div>
<form class="actions" method="get" action="/admin/label.pdf" style="margin-bottom:10px">
<button type="submit">Étiquettes ${config.LABEL_HEIGHT_IN}×${config.LABEL_WIDTH_IN} po (PDF)</button>
<label>× <input name="n" type="number" min="1" max="500" value="1" aria-label="Nombre d’étiquettes"></label></form>
<div class="actions" style="margin-bottom:10px"><a class="button alt" href="/admin/label.png" download="blaguedujour-etiquette.png">Étiquette ${config.LABEL_HEIGHT_IN}×${config.LABEL_WIDTH_IN} po (PNG, 300 dpi)</a></div>
<div class="actions"><a class="button" href="/admin/poster.pdf">Affiche 4 par page (PDF, ${config.POSTER_PAGE === 'A4' ? 'A4' : 'Lettre'})</a></div>
</div></div></div>
</main>`);
  }

  async function settingsPage({ errors = [], saved = false } = {}) {
    const badge = { admin: 'modifié ici', env: '.env', default: 'défaut' };
    const groups = [...new Set(config.SETTINGS.map((s) => s.group))];
    const field = (s) => {
      const source = config.source(s.key);
      const value = config.raw(s.key);
      const id = `f-${s.key}`;
      let input;
      if (s.type === 'secret') {
        input = `<input id="${id}" name="${s.key}" type="password" autocomplete="new-password" placeholder="${value ? '•••••••• (inchangé si vide)' : 'vide'}">`;
      } else if (s.type === 'textarea') {
        input = `<textarea id="${id}" name="${s.key}" rows="3">${escapeHtml(value)}</textarea>`;
      } else if (s.type === 'select') {
        input = `<select id="${id}" name="${s.key}">${Object.entries(s.options).map(([k, label]) => `<option value="${k}"${k === config[s.key] ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`;
      } else {
        const num = s.type === 'number' ? ` type="number" min="${s.min}" max="${s.max}" step="${s.step || 1}"` : '';
        input = `<input id="${id}" name="${s.key}"${num} value="${escapeHtml(value)}" autocomplete="off">`;
      }
      const reset = source === 'admin'
        ? `<label class="reset"><input type="checkbox" name="reset" value="${s.key}"> revenir à ${envValueLabel(s)}</label>` : '';
      return `<div class="field"><label for="${id}">${escapeHtml(s.label)} <small class="tag tag-${source}">${badge[source]}</small>${s.restart ? ' <small class="tag">redémarrage</small>' : ''}</label>
${input}<small class="help"><code>${s.key}</code>${s.help ? ` · ${escapeHtml(s.help)}` : ''}</small>${reset}</div>`;
    };
    const envValueLabel = (s) => {
      const base = config.baseValue(s.key);
      if (s.type === 'secret') return base ? 'la valeur du .env' : 'vide';
      return base ? `« ${escapeHtml(base.length > 40 ? `${base.slice(0, 40)}…` : base)} »` : 'vide';
    };
    let status = '';
    try {
      status = (await diagnoseNotifications?.() || []).map((l) => escapeHtml(l.trim())).join('<br>');
    } catch { /* report only */ }

    return page('Réglages · Admin', `<main>
<div class="top"><div><h1>Réglages</h1><p class="sub">Une valeur modifiée ici remplace celle du <code>.env</code> et s’applique tout de suite.</p></div>
<a class="button alt" href="/admin">← Stats</a></div>
${saved ? '<p class="card notice">✅ Réglages enregistrés.</p>' : ''}
${errors.length ? `<p class="card notice error" role="alert">${errors.map(escapeHtml).join('<br>')}</p>` : ''}
<form method="post" action="/admin/settings">
${groups.map((g) => `<div class="card settings"><h2>${escapeHtml(g)}</h2>${config.SETTINGS.filter((s) => s.group === g).map(field).join('')}</div>`).join('')}
<div class="savebar"><button type="submit">Enregistrer</button></div>
</form>
${status ? `<div class="card"><h2>État des notifications</h2><p class="sub" style="margin:0">${status}</p></div>` : ''}
</main>`);
  }

  async function saveSettings(req, res) {
    const form = new URLSearchParams(await readBody(req, 64 * 1024));
    const resets = new Set(form.getAll('reset'));
    const changes = {};
    for (const s of config.SETTINGS) {
      if (resets.has(s.key)) { changes[s.key] = null; continue; }
      if (!form.has(s.key)) continue;
      const value = form.get(s.key).replace(/\r\n?/g, ' ').trim();
      if (s.type === 'secret' && !value) continue; // empty password field: keep the current one
      if (value !== config.raw(s.key)) changes[s.key] = value;
    }
    const passwordChanged = 'ADMIN_PASSWORD' in changes;
    const errors = config.update(changes);
    if (errors.length) return html(res, 400, await settingsPage({ errors }));
    // A new password signs this session out too: give it a fresh cookie.
    const cookie = passwordChanged && config.ADMIN_PASSWORD ? { 'Set-Cookie': sessionCookie(isSecure(req)) } : {};
    return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, ...cookie, Location: '/admin/settings?ok' });
  }

  const viewParam = (searchParams) => (Object.hasOwn(VIEWS, searchParams.get('vue') || '') ? searchParams.get('vue') : 'jour');

  async function handleAdmin(req, res, pathname, searchParams) {
    if (!config.ADMIN_PASSWORD) return reply(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const ip = clientIp(req);

    if (pathname === '/admin/login' && req.method === 'POST') {
      const recent = (failures.get(ip) || []).filter((t) => Date.now() - t < 15 * 60e3);
      if (recent.length >= 5) return html(res, 429, loginPage('Trop d’essais, réessaie dans 15 minutes.'));
      const password = new URLSearchParams(await readBody(req)).get('password') || '';
      if (!safeEqual(password, config.ADMIN_PASSWORD)) {
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
      return isAdmin(req) ? html(res, 200, dashboard(viewParam(searchParams))) : html(res, 401, loginPage());
    }

    if (!isAdmin(req)) return reply(res, 404, 'Not found', 'text/plain; charset=utf-8');

    if (pathname === '/admin/settings') {
      if (req.method === 'POST') return saveSettings(req, res);
      return html(res, 200, await settingsPage({ saved: searchParams.has('ok') }));
    }
    if (pathname === '/admin/ads' && req.method === 'POST' && ads) {
      await ads.handleAdmin(req);
      return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, Location: '/admin' });
    }
    if (pathname === '/admin/qr/new' && req.method === 'POST') {
      const name = (new URLSearchParams(await readBody(req)).get('name') || '').trim().slice(0, 60);
      if (!name) return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, Location: '/admin' });
      const slug = slugify(name);
      data.campaigns[slug] = { name, createdAt: new Date().toISOString() };
      scheduleSave();
      return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, Location: `/admin/qr/${encodeURIComponent(slug)}` });
    }
    const qrMatch = /^\/admin\/qr\/([a-z0-9-]+)(\/delete)?$/.exec(pathname);
    if (qrMatch && Object.hasOwn(data.campaigns, qrMatch[1])) {
      if (qrMatch[2] && req.method === 'POST') {
        delete data.campaigns[qrMatch[1]];
        scheduleSave();
        return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, Location: '/admin' });
      }
      if (!qrMatch[2]) return html(res, 200, campaignPage(qrMatch[1], viewParam(searchParams)));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');

    // ?c=<slug>: the files of a QR code made for one place.
    const slug = Object.hasOwn(data.campaigns, searchParams.get('c') || '') ? searchParams.get('c') : null;
    const qrUrl = campaignUrl(slug);

    if (pathname === '/admin/qr.png') {
      const size = Math.min(4096, Math.max(128, Number(searchParams.get('size')) || 2048));
      const png = await QRCode.toBuffer(qrUrl, { errorCorrectionLevel: 'H', type: 'png', width: size, margin: 4 });
      return download(res, png, 'image/png', fileName(slug, '.png'));
    }
    if (pathname === '/admin/qr.svg') {
      const svg = await QRCode.toString(qrUrl, { errorCorrectionLevel: 'H', type: 'svg', margin: 4 });
      return download(res, svg, 'image/svg+xml', fileName(slug, '.svg'));
    }
    if (pathname === '/admin/label.pdf') {
      const copies = Math.min(500, Math.max(1, Math.floor(Number(searchParams.get('n'))) || 1));
      return download(res, await labelPdf(copies, qrUrl), 'application/pdf', fileName(slug, '-etiquettes.pdf'));
    }
    if (pathname === '/admin/label.png') {
      const dpi = Math.min(1200, Math.max(100, Math.floor(Number(searchParams.get('dpi'))) || 300));
      return download(res, labelPng(dpi, qrUrl), 'image/png', fileName(slug, '-etiquette.png'));
    }
    if (pathname === '/admin/poster.pdf') {
      return download(res, await posterPdf(qrUrl), 'application/pdf', fileName(slug, '-affiche.pdf'));
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
    if (!config.ADMIN_PASSWORD) return '/admin désactivé : ADMIN_PASSWORD vide';
    if (config.ADMIN_PASSWORD.length < 10) return '/admin actif, mais ADMIN_PASSWORD est court (10 caractères minimum conseillés)';
    return `/admin actif · QR vers ${config.QR_URL}`;
  }

  return { handle, diagnose };
}

module.exports = { createStats };
