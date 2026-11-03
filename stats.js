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

  // ---------- Admin look ----------
  // App shell: navy sidebar (top bar on phones), pages for each topic, light cards.

  const css = `
:root{--bg:#eef7fc;--card:#fff;--ink:#072d59;--muted:#56708f;--faint:#8aa0b8;--line:rgba(7,45,89,.09);--fill:rgba(7,45,89,.05);
--accent:#fd6e88;--accent-ink:#c93a57;--on-accent:#072d59;--nav:#072d59;--nav-ink:#dbf2fc;--good:#13795b;--bad:#c93a57;
--shadow:0 1px 2px rgba(7,45,89,.04),0 4px 16px rgba(7,45,89,.05);color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#031427;--card:#06223f;--ink:#dbf2fc;--muted:#9fbad3;--faint:#6f8cab;--line:rgba(219,242,252,.1);
--fill:rgba(219,242,252,.06);--accent-ink:#fd6e88;--nav:#041a33;--good:#4fd1a5;--bad:#fd6e88;--shadow:none}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%;-webkit-font-smoothing:antialiased}
a{color:inherit}
.shell{display:grid;grid-template-columns:232px 1fr;min-height:100vh;background:linear-gradient(90deg,var(--nav) 232px,transparent 232px)}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:4px;padding:20px 12px;background:var(--nav);color:var(--nav-ink)}
.brand{display:flex;align-items:center;gap:10px;padding:4px 10px 18px;font-weight:700;font-size:15px;line-height:1.2;text-decoration:none}
.brand img{width:32px;height:32px;border-radius:8px;flex:none}
.brand small{display:block;font-weight:500;opacity:.6;font-size:12px}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;text-decoration:none;font-weight:500;opacity:.78}
.nav a:hover{background:rgba(219,242,252,.08);opacity:1}
.nav a[aria-current]{background:rgba(219,242,252,.12);opacity:1;box-shadow:inset 3px 0 0 var(--accent)}
.nav svg{width:18px;height:18px;flex:none}
.nav .count{margin-left:auto;background:var(--accent);color:var(--on-accent);border-radius:99px;padding:0 7px;font-size:12px;font-weight:700}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:2px}
.side-foot a,.side-foot button{display:block;width:100%;text-align:left;padding:8px 10px;border:0;border-radius:10px;background:none;color:inherit;font:inherit;font-size:14px;opacity:.65;cursor:pointer;text-decoration:none}
.side-foot a:hover,.side-foot button:hover{opacity:1;background:rgba(219,242,252,.08)}
main{min-width:0;padding:28px clamp(16px,4vw,40px) 64px;max-width:1180px}
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.head h1{font-size:26px;line-height:1.15;margin:0;letter-spacing:-.02em}
.head p{margin:4px 0 0;color:var(--muted);font-size:14px}
.crumb{display:inline-block;margin-bottom:6px;color:var(--muted);font-size:13px;text-decoration:none}.crumb:hover{color:var(--ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;box-shadow:var(--shadow);min-width:0}
.card+.card,.grid+.card,.card+.grid,.grid-2+.card,.card+.grid-2,.kpis+.card,.grid+.grid{margin-top:16px}
.grid>.card,.grid-2>.card{margin-top:0}
.card h2{font-size:15px;margin:0 0 14px;display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.card h2 small{font-weight:500;color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px}
.grid-2{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow)}
.kpi>span:first-child{display:block;color:var(--muted);font-size:13px;font-weight:500}
.kpi b{display:block;font-size:30px;line-height:1.15;margin:6px 0 2px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi small{color:var(--faint);font-size:12.5px}
.delta{display:inline-block;padding:1px 7px;border-radius:99px;font-size:12px;font-weight:700;margin-right:4px}
.delta.up{color:var(--good);background:color-mix(in srgb,var(--good) 12%,transparent)}.delta.down{color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,transparent)}
.seg{display:inline-flex;gap:2px;padding:3px;background:var(--fill);border:1px solid var(--line);border-radius:11px;overflow-x:auto;max-width:100%}
.seg a{padding:6px 12px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;color:var(--muted);white-space:nowrap}
.seg a:hover{color:var(--ink)}.seg a[aria-current]{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(7,45,89,.15)}
.chart{display:grid;grid-template-columns:auto 1fr;gap:0 10px}
.y{display:flex;flex-direction:column;justify-content:space-between;height:200px;font-size:11px;color:var(--faint);text-align:right;font-variant-numeric:tabular-nums}
.plot{position:relative;height:200px;display:flex;align-items:flex-end;gap:3px;background:linear-gradient(var(--line) 1px,transparent 1px) 0 0/100% 50%;border-bottom:1px solid var(--line)}
.plot i{flex:1;min-width:2px;background:var(--accent);border-radius:4px 4px 0 0;min-height:2px;transition:opacity .15s}
.plot i:hover{opacity:.7}
.x{grid-column:2;display:flex;gap:3px;margin-top:6px;font-size:11px;color:var(--faint)}
.x span{flex:1;min-width:0;text-align:center;white-space:nowrap;overflow:visible}
.rows{width:100%;border-collapse:collapse}
.rows td{padding:8px 0;border-top:1px solid var(--line);vertical-align:middle;font-size:14px}
.rows tr:first-child td{border-top:0}
.rows td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;padding-left:12px}
.rows td.n small{color:var(--faint);margin-left:6px;display:inline-block;min-width:36px}
.bar{display:block;height:5px;border-radius:3px;background:var(--fill);margin-top:5px;overflow:hidden}
.bar>i{display:block;height:100%;background:var(--accent);border-radius:3px}
.empty{color:var(--muted);margin:0;font-size:14px}
.muted{color:var(--muted)}.faint{color:var(--faint);font-size:13px}
.btn,button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:0 14px;border:0;border-radius:10px;background:var(--accent);color:var(--on-accent);font:inherit;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer;white-space:nowrap}
.btn:hover,button:hover{filter:brightness(.96)}
.btn.alt,button.alt{background:var(--fill);color:var(--ink);border:1px solid var(--line)}
.btn.danger,button.danger{background:none;color:var(--bad);border:1px solid color-mix(in srgb,var(--bad) 35%,transparent)}
.btn.sm,button.sm{min-height:32px;padding:0 10px;font-size:13px}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input,textarea,select{width:100%;min-height:40px;border:1px solid var(--line);border-radius:10px;padding:8px 12px;font:inherit;background:var(--card);color:var(--ink)}
input:focus,textarea:focus,select:focus{outline:2px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:0;border-color:transparent}
textarea{resize:vertical}
.qrbox{display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.qrbox img{width:150px;height:150px;border-radius:12px;background:#fff;padding:8px;border:1px solid var(--line);flex:none}
.list{display:flex;flex-direction:column}
.item{display:flex;align-items:center;gap:14px;padding:12px 0;border-top:1px solid var(--line)}
.item:first-child{border-top:0;padding-top:0}
.item .grow{flex:1;min-width:0}
.item .title{font-weight:600;text-decoration:none}.item .title:hover{text-decoration:underline}
.item .sub{color:var(--faint);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.item .n b{font-size:18px}
.spark{width:96px;height:28px;flex:none}
.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600;background:var(--fill);color:var(--muted);border:1px solid var(--line)}
.pill.ok{color:var(--good);border-color:color-mix(in srgb,var(--good) 30%,transparent)}
.pill.warn{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 30%,transparent)}
.joke{font-size:22px;line-height:1.35;font-weight:650;letter-spacing:-.01em;margin:0;white-space:pre-line}
.joke+.joke{margin-top:10px;color:var(--accent-ink)}
.facts{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.score{font-size:30px;font-weight:700;letter-spacing:-.02em}
.dist{display:flex;align-items:flex-end;gap:3px;height:56px;margin-top:8px}
.dist i{flex:1;background:var(--accent);opacity:.85;border-radius:3px 3px 0 0;min-height:2px}
.dist-x{display:flex;gap:3px;font-size:11px;color:var(--faint)}.dist-x span{flex:1;text-align:center}
.notice{padding:12px 16px;border-radius:12px;margin-bottom:16px;font-size:14px;background:color-mix(in srgb,var(--good) 10%,var(--card));border:1px solid color-mix(in srgb,var(--good) 30%,transparent)}
.notice.error{background:color-mix(in srgb,var(--bad) 8%,var(--card));border-color:color-mix(in srgb,var(--bad) 35%,transparent);color:var(--bad)}
.status{margin:0;padding:0;list-style:none;font-size:13.5px;display:flex;flex-direction:column;gap:6px}
.settings-wrap{display:grid;grid-template-columns:200px minmax(0,1fr);gap:24px;align-items:start}
.toc{position:sticky;top:20px;display:flex;flex-direction:column;gap:2px;font-size:13.5px}
.toc a{padding:6px 10px;border-radius:8px;text-decoration:none;color:var(--muted)}.toc a:hover{background:var(--fill);color:var(--ink)}
.settings h2{margin-bottom:4px}
.field{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:6px 20px;padding:14px 0;border-top:1px solid var(--line)}
.settings h2+.field{border-top:0}
.field label{font-weight:600;font-size:14px}
.field .help{display:block;color:var(--faint);font-size:12.5px;font-weight:400;margin-top:3px}
.field code{font-size:11.5px;color:var(--faint)}
.tag{display:inline-block;font-weight:600;font-size:11px;padding:0 6px;border-radius:6px;background:var(--fill);color:var(--muted);margin-left:4px;vertical-align:1px}
.tag-admin{background:color-mix(in srgb,var(--accent) 25%,transparent);color:var(--ink)}
.infos{display:flex;flex-direction:column;gap:10px}.infos label{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600;color:var(--muted)}.infos button{align-self:flex-start}.infos input,.infos textarea{font-weight:400;font-size:14px;color:var(--ink)}
.reset{display:flex;gap:6px;align-items:center;font-size:12.5px;color:var(--muted);margin-top:6px}.reset input{width:auto;min-height:0}
.savebar{position:sticky;bottom:0;margin-top:16px;padding:12px 0 max(12px,env(safe-area-inset-bottom));background:linear-gradient(transparent,var(--bg) 35%);display:flex;justify-content:flex-end}
.savebar button{min-width:180px;min-height:44px}
.login{min-height:100vh;display:grid;place-items:center;padding:20px}
.login form{width:min(100%,360px);display:flex;flex-direction:column;gap:12px;text-align:center}
.login img{width:56px;height:56px;border-radius:14px;margin:0 auto 4px}
.login h1{margin:0;font-size:22px}.login button{min-height:44px}
details summary{cursor:pointer;color:var(--muted);font-size:14px;margin-top:12px}
@media(max-width:900px){
.shell{grid-template-columns:1fr;background:none}
.side{position:sticky;z-index:5;height:auto;flex-direction:row;align-items:center;gap:8px;padding:10px 12px;overflow-x:auto}
.brand{padding:0 6px 0 0}.brand span{display:none}
.nav{flex-direction:row}.nav a{padding:8px 10px;white-space:nowrap}.nav a span{display:none}.nav a[aria-current] span{display:inline}
.nav a[aria-current]{box-shadow:inset 0 -2px 0 var(--accent)}
.side-foot{margin:0 0 0 auto;flex-direction:row}.side-foot a{display:none}
.grid-2,.settings-wrap{grid-template-columns:1fr}.toc{display:none}
.field{grid-template-columns:1fr}
main{padding-top:20px}
.kpis{grid-template-columns:1fr 1fr;gap:10px}.kpi{padding:12px 14px}.kpi b{font-size:24px}.head h1{font-size:22px}}`;

  const ICONS = {
    stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    jokes: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5h7M9 9.5h.01M15 9.5h.01"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
    labels: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  const doc = (title, body) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title><link rel="icon" href="/icons/icon.svg"><style>${css}</style></head><body>${body}</body></html>`;

  // Page inside the shell. `active` is the menu entry to highlight.
  function page(title, active, inner) {
    const pending = ads?.pendingCount?.() || 0;
    const links = [
      ['stats', '/admin', 'Vue d’ensemble'],
      ['jokes', '/admin/blagues', 'Blagues'],
      ['qr', '/admin/qr', 'Codes QR'],
      ['labels', '/admin/etiquettes', 'Étiquettes', pending],
      ['settings', '/admin/settings', 'Réglages'],
    ];
    return doc(`${title} · Admin`, `<div class="shell">
<aside class="side"><a class="brand" href="/admin"><img src="/icons/icon-192.png" alt=""><span>${escapeHtml(config.SITE_NAME)}<small>Administration</small></span></a>
<nav class="nav" aria-label="Menu">${links.map(([key, href, label, count]) => `<a href="${href}"${key === active ? ' aria-current="page"' : ''} title="${label}">${icon(key)}<span>${label}</span>${count ? `<b class="count">${count}</b>` : ''}</a>`).join('')}</nav>
<div class="side-foot"><a href="/" target="_blank" rel="noopener">Voir le site ↗</a><form method="post" action="/admin/logout"><button type="submit" title="Déconnexion">Déconnexion</button></form></div></aside>
<main>${inner}</main></div>`);
  }

  const head = (title, sub = '', right = '', crumb = '') => `<div class="head"><div>${crumb}<h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${right}</div>`;

  function loginPage(error) {
    return doc('Admin', `<div class="login"><form class="card" method="post" action="/admin/login">
<img src="/icons/icon-192.png" alt=""><h1>Administration</h1><p class="muted" style="margin:0 0 4px">${escapeHtml(config.SITE_NAME)}</p>
${error ? `<p class="notice error" role="alert" style="margin:0">${escapeHtml(error)}</p>` : ''}
<input type="password" name="password" placeholder="Mot de passe" autocomplete="current-password" autofocus required>
<button type="submit">Entrer</button></form></div>`);
  }

  const fmt = (n) => Number(n || 0).toLocaleString('fr-FR');

  function table(rows, total, empty = 'Pas encore de données.', label = (k) => escapeHtml(k)) {
    if (!rows.length) return `<p class="empty">${empty}</p>`;
    const max = rows[0][1];
    return `<table class="rows">${rows.map(([k, n]) => `<tr><td>${label(k)}<span class="bar"><i style="width:${Math.max(2, Math.round((n / max) * 100))}%"></i></span></td>`
      + `<td class="n">${fmt(n)}<small>${Math.round((n / Math.max(1, total)) * 100)} %</small></td></tr>`).join('')}</table>`;
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

  function lastDays(count, back = 0) {
    const end = shift(dayKey(), -count * back);
    return dayRange(shift(end, -(count - 1)), end);
  }

  // Buckets of the chosen view. Each has a label, its days (for totals and tables) and, for the hour
  // view, the hour. `back` = 1 gives the period just before (to compare). `name` describes the period.
  function periodOf(view, back = 0) {
    const todayKey = dayKey();
    if (view === 'heure') {
      const buckets = [];
      for (let i = 23 + 24 * back; i >= 24 * back; i--) {
        const d = new Date(Date.now() - i * 3600e3);
        const h = hourOf(d);
        buckets.push({ label: `${h} h`, title: `${short(dayKey(d))} ${h} h`, keys: [dayKey(d)], hour: h });
      }
      return { name: '24 dernières heures', prev: 'les 24 h d’avant', unit: 'heure', buckets, keys: [...new Set(buckets.map((b) => b.keys[0]))] };
    }
    if (view === 'semaine') {
      const monday = shift(todayKey, -((new Date(`${todayKey}T00:00:00Z`).getUTCDay() + 6) % 7));
      const buckets = [];
      for (let w = 11 + 12 * back; w >= 12 * back; w--) {
        const start = shift(monday, -7 * w);
        buckets.push({ label: short(start), title: `semaine du ${short(start)}`, keys: dayRange(start, shift(start, 6)).filter((k) => k <= todayKey) });
      }
      return { name: '12 dernières semaines', prev: 'les 12 semaines d’avant', unit: 'semaine', buckets, keys: buckets.flatMap((b) => b.keys) };
    }
    if (view === 'mois') {
      const [y, m] = todayKey.split('-').map(Number);
      const buckets = [];
      for (let i = 11 + 12 * back; i >= 12 * back; i--) {
        const d = new Date(Date.UTC(y, m - 1 - i, 1));
        const prefix = d.toISOString().slice(0, 7);
        const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
        const label = `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
        buckets.push({ label, title: label, keys: dayRange(`${prefix}-01`, end).filter((k) => k <= todayKey) });
      }
      return { name: '12 derniers mois', prev: 'les 12 mois d’avant', unit: 'mois', buckets, keys: buckets.flatMap((b) => b.keys) };
    }
    if (view === 'annee') {
      if (back) return null; // nothing before "all years"
      const first = Object.keys(data.days).sort()[0] || todayKey;
      const buckets = [];
      for (let y = Number(first.slice(0, 4)); y <= Number(todayKey.slice(0, 4)); y++) {
        buckets.push({ label: String(y), title: String(y), keys: dayRange(`${y}-01-01`, `${y}-12-31`).filter((k) => k >= first && k <= todayKey) });
      }
      return { name: buckets.length > 1 ? 'toutes les années' : `année ${todayKey.slice(0, 4)}`, unit: 'année', buckets, keys: buckets.flatMap((b) => b.keys) };
    }
    const buckets = lastDays(config.STATS_DAYS, back).map((k) => ({ label: short(k), title: short(k), keys: [k] }));
    return { name: `${config.STATS_DAYS} derniers jours`, prev: `les ${config.STATS_DAYS} jours d’avant`, unit: 'jour', buckets, keys: buckets.map((b) => b.keys[0]) };
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

  const total = (series, field = 'views') => series.reduce((n, b) => n + (b[field] || 0), 0);

  // "+12 %" against the previous period of the same length.
  function delta(view, pick, now) {
    const before = periodOf(view, 1);
    if (!before) return '';
    const was = total(seriesOf(before, pick));
    if (!was) return `<small>${escapeHtml(before.prev)} : 0</small>`;
    const pct = Math.round(((now - was) / was) * 100);
    return `<span class="delta ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct)} %</span><small>vs ${escapeHtml(before.prev)}</small>`;
  }

  function viewSelector(view, base) {
    return `<nav class="seg" aria-label="Période">${Object.entries(VIEWS).map(([v, label]) => `<a href="${base}?vue=${v}"${v === view ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  }

  // Bar chart with a 0 / half / max scale and a few dates under it.
  function chartHtml(series, unitLabel) {
    const max = Math.max(1, ...series.map((b) => b.views));
    const nice = max <= 4 ? max : Math.ceil(max / 2) * 2;
    const every = Math.max(1, Math.ceil(series.length / 8));
    const tip = (b) => `${b.title} : ${fmt(b.views)} ${unitLabel}${b.uniques !== null ? `, ${fmt(b.uniques)} uniques` : ''}`;
    return `<div class="chart" role="img" aria-label="${escapeHtml(unitLabel)} par période">
<div class="y"><span>${fmt(nice)}</span><span>${fmt(nice / 2)}</span><span>0</span></div>
<div class="plot">${series.map((b) => `<i style="height:${Math.round((b.views / nice) * 100)}%" title="${escapeHtml(tip(b))}"></i>`).join('')}</div>
<div class="x">${series.map((b, i) => `<span>${(series.length - 1 - i) % every === 0 ? escapeHtml(b.label) : ''}</span>`).join('')}</div></div>`;
  }

  // Tiny line of the last 30 days, for lists.
  function sparkline(values) {
    const max = Math.max(1, ...values);
    const step = 96 / Math.max(1, values.length - 1);
    const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(26 - (v / max) * 24).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 96 28" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  // ---------- QR codes per place ----------
  // Each one points to QR_URL with ?qr=<slug>; its scans are counted apart (views and uniques per day/hour).

  // New QR codes get a random 4-digit code (?qr=4821), which never changes, even when renamed.
  // Older ones keep the code made from their first name.
  function newCode() {
    for (;;) {
      const code = String(crypto.randomInt(1000, 10000));
      if (!Object.hasOwn(data.campaigns, code)) return code;
    }
  }


  function campaignUrl(slug) {
    if (!slug) return config.QR_URL;
    const url = new URL(config.QR_URL);
    url.searchParams.set('qr', slug);
    return url.toString();
  }

  const fileName = (slug, suffix) => `blaguedujour-${slug || 'qr'}${suffix}`;

  function downloadLinks(slug) {
    const q = slug ? `?c=${encodeURIComponent(slug)}` : '';
    return `<div class="actions"><a class="btn" href="/admin/qr.png${q}" download="${fileName(slug, '.png')}">QR PNG</a>
<a class="btn alt" href="/admin/qr.svg${q}" download="${fileName(slug, '.svg')}">QR SVG</a>
<a class="btn alt" href="/admin/label.png${q}" download="${fileName(slug, '-etiquette.png')}">Étiquette PNG</a>
<a class="btn alt" href="/admin/poster.pdf${q}">Affiche PDF (${config.POSTER_PAGE === 'A4' ? 'A4' : 'Lettre'})</a></div>
<form class="actions" method="get" action="/admin/label.pdf" style="margin-top:8px">${slug ? `<input type="hidden" name="c" value="${escapeHtml(slug)}">` : ''}
<button class="alt" type="submit">Étiquettes ${config.LABEL_HEIGHT_IN}×${config.LABEL_WIDTH_IN} po (PDF)</button>
<label class="faint">× <input name="n" type="number" min="1" max="500" value="1" style="width:80px;min-height:38px" aria-label="Nombre d’étiquettes"></label></form>`;
  }

  const campaignPick = (slug) => (d) => d?.campaigns?.[slug];

  function qrPage() {
    const days = lastDays(30);
    const rows = Object.entries(data.campaigns).map(([slug, c]) => {
      const pick = campaignPick(slug);
      const values = days.map((k) => pick(data.days[k])?.views || 0);
      const all = Object.values(data.days).reduce((n, d) => n + (pick(d)?.views || 0), 0);
      return { slug, ...c, values, month: values.reduce((a, b) => a + b, 0), all };
    }).sort((a, b) => b.month - a.month);
    const list = rows.map((c) => `<div class="item"><div class="grow"><a class="title" href="/admin/qr/${encodeURIComponent(c.slug)}">${escapeHtml(c.name)}</a>
<div class="sub">${escapeHtml(campaignUrl(c.slug))}${c.note ? ` · ${escapeHtml(c.note.split('\n')[0].slice(0, 80))}` : ''}</div></div>${sparkline(c.values)}
<div class="n"><b>${fmt(c.month)}</b><div class="faint">30 j · ${fmt(c.all)} au total</div>
${c.copies ? `<div class="faint">${fmt(c.copies)} étiq. · ${perLabel(c.all, c.copies)} scans/étiq.</div>` : ''}</div></div>`).join('');
    return page('Codes QR', 'qr', `${head('Codes QR', 'Un code par lieu (école, local…) pour compter ses scans à part.')}
<div class="card"><h2>Codes QR par lieu <small>${rows.length} code${rows.length > 1 ? 's' : ''}</small></h2>
<form class="actions" method="post" action="/admin/qr/new" style="margin-bottom:14px;flex-wrap:nowrap">
<input name="name" required maxlength="60" placeholder="Nom du lieu (ex. École Sainte-Marie)"><button type="submit">Créer</button></form>
${list ? `<div class="list">${list}</div>` : '<p class="empty">Aucun code pour l’instant. Crée-en un pour chaque école où tu poses des étiquettes.</p>'}</div>
<div class="card"><h2>Code QR principal <small>${escapeHtml(config.QR_URL)}</small></h2><div class="qrbox"><img src="/admin/qr.png?size=400" alt="Code QR principal">
<div style="flex:1;min-width:240px"><p class="faint" style="margin:0 0 12px">Pour les étiquettes sans lieu précis. Ses scans comptent dans « Code QR » sans lieu.</p>${downloadLinks(null)}</div></div></div>`);
  }

  const perLabel = (scans, copies) => (copies ? (scans / copies).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : null);

  function campaignPage(slug, view = 'jour') {
    const c = data.campaigns[slug];
    const period = periodOf(view);
    const pick = campaignPick(slug);
    const series = seriesOf(period, pick);
    const todayC = pick(data.days[dayKey()]) || { views: 0, uniques: 0 };
    const all = Object.values(data.days).reduce((n, d) => n + (pick(d)?.views || 0), 0);
    const views = total(series);
    return page(c.name, 'qr', `${head(escapeHtml(c.name), `Créé le ${escapeHtml(c.createdAt.slice(0, 10))} · <a href="${escapeHtml(campaignUrl(slug))}" target="_blank" rel="noopener">${escapeHtml(campaignUrl(slug))}</a>`,
      viewSelector(view, `/admin/qr/${encodeURIComponent(slug)}`), '<a class="crumb" href="/admin/qr">← Codes QR</a>')}
<div class="kpis">
<div class="kpi"><span>Scans · ${escapeHtml(period.name)}</span><b>${fmt(views)}</b>${delta(view, pick, views)}</div>
<div class="kpi"><span>Visiteurs uniques</span><b>${view === 'heure' ? '—' : fmt(total(series, 'uniques'))}</b><small>${view === 'heure' ? 'non compté par heure' : 'additionnés par jour'}</small></div>
<div class="kpi"><span>Aujourd’hui</span><b>${fmt(todayC.views)}</b><small>${fmt(todayC.uniques)} uniques</small></div>
<div class="kpi"><span>Depuis la création</span><b>${fmt(all)}</b><small>scans</small></div>
<div class="kpi"><span>Étiquettes produites</span><b>${c.copies ? fmt(c.copies) : '—'}</b><small>${c.copies ? 'exemplaires de ce code' : 'à indiquer dans « Infos »'}</small></div>
<div class="kpi"><span>Scans par étiquette</span><b>${perLabel(all, c.copies) ?? '—'}</b><small>${c.copies ? `depuis la création · ${perLabel(views, c.copies)} (${escapeHtml(period.name)})` : 'indique le nombre d’exemplaires'}</small></div></div>
<div class="card"><h2>Scans par ${escapeHtml(period.unit)} <small>${escapeHtml(period.name)}</small></h2>${chartHtml(series, 'scans')}</div>
<div class="grid-2">
<div class="card"><h2>Télécharger</h2><div class="qrbox"><img src="/admin/qr.png?size=400&amp;c=${encodeURIComponent(slug)}" alt="Code QR ${escapeHtml(c.name)}">
<div style="flex:1;min-width:240px">${downloadLinks(slug)}</div></div></div>
<div class="card"><h2>Infos <small>code ${escapeHtml(slug)}</small></h2>
<form method="post" action="/admin/qr/${encodeURIComponent(slug)}/rename" class="infos">
<label>Nom<input name="name" required maxlength="60" value="${escapeHtml(c.name)}"></label>
<label>Nombre d’exemplaires produits<input name="copies" type="number" min="0" max="1000000" step="1" value="${c.copies || ''}" placeholder="ex. 40"></label>
<label>Note<textarea name="note" rows="3" maxlength="2000" placeholder="ex. posées au 2e étage le 3 nov., casier 112">${escapeHtml(c.note || '')}</textarea></label>
<button type="submit">Enregistrer</button></form>
<p class="faint" style="margin:8px 0 0">Le nom change seulement dans l’admin : l’adresse (<b>?qr=${escapeHtml(slug)}</b>) et les codes déjà imprimés ne changent pas.</p>
<h2 style="margin-top:20px">Supprimer</h2><p class="faint" style="margin:0 0 12px">Le code imprimé mènera toujours au site, mais ses scans ne seront plus comptés à part.</p>
<form method="post" action="/admin/qr/${encodeURIComponent(slug)}/delete"><button class="danger" type="submit">Supprimer ce code QR</button></form></div></div>`);
  }

  // ---------- Jokes ----------

  function jokesPage() {
    const days = Object.entries(getJokes()).sort(([a], [b]) => (a < b ? 1 : -1));
    const [currentKey, current] = days[0] || [];
    const avg = (j) => (j?.ratings?.count ? j.ratings.sum / j.ratings.count : null);
    const one = (n) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
    let todayCard = '<div class="card"><p class="empty">Pas encore de blague.</p></div>';
    if (current) {
      const [setup, ...rest] = current.text.split('\n');
      const a = avg(current);
      const dist = current.ratings?.dist || Array(10).fill(0);
      const dmax = Math.max(1, ...dist);
      todayCard = `<div class="grid-2"><div class="card"><h2>Blague en cours <small>${escapeHtml(currentKey)}</small></h2>
<p class="joke">${escapeHtml(setup)}</p>${rest.length ? `<p class="joke">${escapeHtml(rest.join('\n'))}</p>` : ''}
<div class="facts"><span class="pill">${escapeHtml(current.source)}</span>
${current.moderated ? '<span class="pill ok">✓ vérifiée par Groq</span>' : '<span class="pill">non vérifiée par IA</span>'}
${current.unavailable ? '<span class="pill warn">retirée</span>' : ''}
<span class="pill${(current.reports?.length || 0) ? ' warn' : ''}">${current.reports?.length || 0} / ${config.REPORT_THRESHOLD} signalements</span>
${current.replaces ? '<span class="pill">remplace une blague signalée</span>' : ''}</div></div>
<div class="card"><h2>Note <small>${current.ratings?.count || 0} vote${(current.ratings?.count || 0) > 1 ? 's' : ''}</small></h2>
<div class="score">${a === null ? '—' : `${one(a)}<span class="faint" style="font-size:16px"> /10</span>`}</div>
<div class="dist">${dist.map((n) => `<i style="height:${Math.round((n / dmax) * 100)}%" title="${n} vote(s)"></i>`).join('')}</div>
<div class="dist-x">${dist.map((_, i) => `<span>${i + 1}</span>`).join('')}</div></div></div>`;
    }
    const rows = days.slice(1, 31).map(([day, j]) => {
      const a = avg(j);
      return `<tr><td><span class="faint">${escapeHtml(short(day))}</span> · ${escapeHtml(j.text.split('\n')[0].slice(0, 90))}
${j.unavailable ? ' <span class="pill warn">retirée</span>' : ''}${a !== null ? `<span class="bar"><i style="width:${Math.round(a * 10)}%"></i></span>` : ''}</td>
<td class="n">${a === null ? '<span class="faint">—</span>' : `<b>${one(a)}</b>/10<small>${j.ratings.count} vote${j.ratings.count > 1 ? 's' : ''}</small>`}</td></tr>`;
    }).join('');
    return page('Blagues', 'jokes', `${head('Blagues', `Une nouvelle ${escapeHtml(config.SCHEDULE_TEXT)} · historique et notes sur 10`)}
${todayCard}
<div class="card"><h2>Blagues précédentes <small>30 dernières</small></h2>${rows ? `<table class="rows">${rows}</table>` : '<p class="empty">Pas encore d’historique.</p>'}</div>`);
  }

  // ---------- Overview ----------

  function dashboard(view = 'jour') {
    today();
    const period = periodOf(view);
    const series = seriesOf(period, (d) => d);
    const days = period.keys.map((k) => ({ k, ...emptyDay(), ...data.days[k] }));
    const sum = (list, f) => list.reduce((n, d) => n + (f(d) || 0), 0);
    const merge = (field) => {
      const out = {};
      for (const d of days) for (const [k, n] of Object.entries(d[field] || {})) out[k] = (out[k] || 0) + n;
      return Object.entries(out).sort((x, y) => y[1] - x[1]).slice(0, 8);
    };
    const views = total(series);
    const dayViews = sum(days, (d) => d.views);
    const todayD = { ...emptyDay(), ...data.days[dayKey()] };
    // Tables and side counters cover whole days (for "Heure": today and yesterday).
    const n = view === 'heure' ? 'aujourd’hui et hier' : period.name;
    const installs = Object.values(data.installs || {});
    const opened = installs.filter((i) => i.last >= period.keys[0]).length;
    const card = (title, body) => `<div class="card"><h2>${title} <small>${escapeHtml(n)}</small></h2>${body}</div>`;

    return page('Vue d’ensemble', 'stats', `${head('Vue d’ensemble', `Visites humaines (code QR, appli installée, recherche ${escapeHtml(config.HUMAN_REFERRERS.join(', '))}) · ${escapeHtml(config.TIME_ZONE)}`, viewSelector(view, '/admin'))}
<div class="kpis">
<div class="kpi"><span>Visites · ${escapeHtml(period.name)}</span><b>${fmt(views)}</b>${delta(view, (d) => d, views)}</div>
<div class="kpi"><span>Visiteurs uniques</span><b>${view === 'heure' ? '—' : fmt(total(series, 'uniques'))}</b><small>${view === 'heure' ? 'non compté par heure' : 'additionnés par jour'}</small></div>
<div class="kpi"><span>Aujourd’hui</span><b>${fmt(todayD.views)}</b><small>${fmt(todayD.uniques)} visiteurs uniques</small></div>
<div class="kpi"><span>Applis installées</span><b>${fmt(installs.length)}</b><small>${fmt(opened)} ouvertes (${escapeHtml(n)})</small></div></div>
<div class="card"><h2>Visites par ${escapeHtml(period.unit)} <small>${escapeHtml(period.name)}</small></h2>${chartHtml(series, 'visites')}
<p class="faint" style="margin:12px 0 0">Écartés (${escapeHtml(n)}) : ${fmt(sum(days, (d) => d.others))} visites non vérifiées · ${fmt(sum(days, (d) => d.bots))} robots</p></div>
<div class="grid">
${card('Provenance', table(merge('origins'), dayViews))}
${card('Appareils', table(merge('devices'), dayViews))}
${card('Pays', table(merge('countries'), dayViews, undefined, (k) => `${flag(k)} ${escapeHtml(countryName(k))}`))}
${card('Villes', table(merge('cities'), dayViews, 'Pas de ville : active « Add visitor location headers » dans Cloudflare.'))}
${card('Sites d’origine', table(merge('sources'), dayViews))}
</div>`);
  }

  function labelsPage() {
    return page('Étiquettes', 'labels', `${head('Demandes d’étiquettes', 'Envoyées depuis la page <a href="/ads" target="_blank" rel="noopener">/ads</a> par les gens qui collent des étiquettes.')}
${ads ? ads.adminHtml() : '<div class="card"><p class="empty">Module indisponible.</p></div>'}`);
  }

  // ---------- Settings ----------

  async function settingsPage({ errors = [], saved = false } = {}) {
    const badge = { admin: 'modifié ici', env: '.env', default: 'défaut' };
    const groups = [...new Set(config.SETTINGS.map((s) => s.group))];
    const anchor = (g) => `g-${g.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const envValueLabel = (s) => {
      const base = config.baseValue(s.key);
      if (s.type === 'secret') return base ? 'la valeur du .env' : 'vide';
      return base ? `« ${escapeHtml(base.length > 40 ? `${base.slice(0, 40)}…` : base)} »` : 'vide';
    };
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
      return `<div class="field"><div><label for="${id}">${escapeHtml(s.label)}</label><span class="tag tag-${source}">${badge[source]}</span>${s.restart ? '<span class="tag">redémarrage</span>' : ''}
<span class="help">${s.help ? `${escapeHtml(s.help)} · ` : ''}<code>${s.key}</code></span></div><div>${input}${reset}</div></div>`;
    };
    let status = [];
    try { status = (await diagnoseNotifications?.()) || []; } catch { /* report only */ }

    return page('Réglages', 'settings', `${head('Réglages', 'Une valeur modifiée ici remplace celle du <code>.env</code> et s’applique tout de suite.')}
${saved ? '<p class="notice">✅ Réglages enregistrés.</p>' : ''}
${errors.length ? `<p class="notice error" role="alert">${errors.map(escapeHtml).join('<br>')}</p>` : ''}
${status.length ? `<div class="card" style="margin-bottom:16px"><h2>État des e-mails et notifications</h2><ul class="status">${status.map((l) => `<li>${escapeHtml(l.trim())}</li>`).join('')}</ul></div>` : ''}
<div class="settings-wrap"><nav class="toc" aria-label="Sections">${groups.map((g) => `<a href="#${anchor(g)}">${escapeHtml(g)}</a>`).join('')}</nav>
<form method="post" action="/admin/settings">
${groups.map((g) => `<div class="card settings" id="${anchor(g)}"><h2>${escapeHtml(g)}</h2>${config.SETTINGS.filter((s) => s.group === g).map(field).join('')}</div>`).join('')}
<div class="savebar"><button type="submit">Enregistrer</button></div>
</form></div>`);
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
      return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, Location: '/admin/etiquettes' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/admin/blagues') return html(res, 200, jokesPage());
      if (pathname === '/admin/qr') return html(res, 200, qrPage());
      if (pathname === '/admin/etiquettes') return html(res, 200, labelsPage());
    }
    if (pathname === '/admin/qr/new' && req.method === 'POST') {
      const name = (new URLSearchParams(await readBody(req)).get('name') || '').trim().slice(0, 60);
      if (!name) return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, Location: '/admin/qr' });
      const slug = newCode();
      data.campaigns[slug] = { name, createdAt: new Date().toISOString() };
      scheduleSave();
      return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, Location: `/admin/qr/${encodeURIComponent(slug)}` });
    }
    const qrMatch = /^\/admin\/qr\/([a-z0-9-]+)(\/delete|\/rename)?$/.exec(pathname);
    if (qrMatch && Object.hasOwn(data.campaigns, qrMatch[1])) {
      if (qrMatch[2] === '/rename' && req.method === 'POST') {
        // Only the name shown in /admin changes: the code in the URL (and the printed QR) stays.
        const form = new URLSearchParams(await readBody(req, 8192));
        const c = data.campaigns[qrMatch[1]];
        const name = (form.get('name') || '').trim().slice(0, 60);
        if (name) c.name = name;
        if (form.has('copies')) c.copies = Math.min(1e6, Math.max(0, Math.floor(Number(form.get('copies'))) || 0));
        if (form.has('note')) c.note = (form.get('note') || '').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
        scheduleSave();
        return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, Location: `/admin/qr/${encodeURIComponent(qrMatch[1])}` });
      }
      if (qrMatch[2] === '/delete' && req.method === 'POST') {
        delete data.campaigns[qrMatch[1]];
        scheduleSave();
        return reply(res, 303, '', 'text/plain', { ...ADMIN_HEADERS, Location: '/admin/qr' });
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
