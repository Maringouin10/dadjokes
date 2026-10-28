'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { escapeHtml } = require('./notifications');
const config = require('./config');

const MAX_PENDING = 500;

// Label requests from the people who stick labels around: how many, and their locker number.
function createAds({ dataDir }) {
  const file = path.join(dataDir, 'label-requests.json');
  let requests = [];
  try {
    requests = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* first start */ }

  async function save() {
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(`${file}.tmp`, JSON.stringify(requests, null, 2));
    await fsp.rename(`${file}.tmp`, file);
  }

  const hits = new Map();
  function limited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();
    return recent.length > 5;
  }

  const pending = () => requests.filter((r) => !r.deliveredAt);

  async function add({ locker, quantity, name, note }) {
    locker = String(locker || '').trim().slice(0, 30);
    quantity = Math.floor(Number(quantity));
    if (!locker) return 'Indique ton numéro de casier.';
    if (!(quantity >= 1 && quantity <= config.ADS_MAX_LABELS)) return `Choisis entre 1 et ${config.ADS_MAX_LABELS} étiquettes.`;
    if (pending().length >= MAX_PENDING) return 'Trop de demandes en attente, réessaie plus tard.';
    requests.push({
      id: crypto.randomBytes(6).toString('hex'),
      locker,
      quantity,
      name: String(name || '').trim().slice(0, 60),
      note: String(note || '').trim().slice(0, 300),
      createdAt: new Date().toISOString(),
      deliveredAt: null,
    });
    await save();
    console.log(`[ads] ${quantity} étiquette(s) pour le casier ${locker}`);
    return null;
  }

  async function markDelivered(id, delivered) {
    const request = requests.find((r) => r.id === id);
    if (!request) return;
    request.deliveredAt = delivered ? new Date().toISOString() : null;
    await save();
  }

  async function remove(id) {
    requests = requests.filter((r) => r.id !== id);
    await save();
  }

  // ---------- Public page /ads ----------

  function page(inner, status = '') {
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(config.ADS_TITLE)}</title><link rel="stylesheet" href="/styles.css">
<style>body{height:auto;min-height:100dvh;overflow:auto}.ads{max-width:420px;margin:0 auto;padding:max(24px,env(safe-area-inset-top)) 16px 40px;display:flex;flex-direction:column;gap:12px;justify-content:center;min-height:100dvh}
.ads label{font-weight:600;font-size:15px;margin-top:6px}.ads .field{width:100%}.ads .button{width:100%;margin-top:12px}
.ads .hp{position:absolute;left:-9999px}.ads .status{color:var(--secondary);min-height:1.4em;margin:0}</style></head>
<body><main class="ads">${inner}${status ? `<p class="status" role="status">${escapeHtml(status)}</p>` : ''}</main></body></html>`;
  }

  function form(values = {}) {
    const v = (k) => escapeHtml(values[k] || '');
    return `<h1 class="title">${escapeHtml(config.ADS_TITLE)}</h1>
<p class="message">${escapeHtml(config.ADS_TEXT)}</p>
<form method="post" action="/ads">
<label for="locker">Numéro de casier</label>
<input class="field" id="locker" name="locker" required maxlength="30" autocomplete="off" value="${v('locker')}">
<label for="quantity">Nombre d’étiquettes</label>
<input class="field" id="quantity" name="quantity" type="number" inputmode="numeric" min="1" max="${config.ADS_MAX_LABELS}" required value="${v('quantity') || 20}">
<label for="name">Ton nom (facultatif)</label>
<input class="field" id="name" name="name" maxlength="60" autocomplete="name" value="${v('name')}">
<label for="note">Un mot (facultatif)</label>
<input class="field" id="note" name="note" maxlength="300" value="${v('note')}">
<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<button class="button" type="submit">Demander les étiquettes</button>
</form>`;
  }

  function readForm(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 4096) reject(Object.assign(new Error('Payload too large'), { status: 413 }));
      });
      req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))));
      req.on('error', reject);
    });
  }

  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  };

  async function handle(req, res, pathname, ip) {
    if (pathname !== '/ads' && pathname !== '/ads/') return false;
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end(page(form()));
    }
    if (req.method !== 'POST') return false;
    const values = await readForm(req);
    if (values.website) { // honeypot: only bots fill it
      res.writeHead(200, headers);
      return res.end(page('<h1 class="title">Merci !</h1>'));
    }
    if (limited(ip)) {
      res.writeHead(429, headers);
      return res.end(page(form(values), 'Trop de demandes, réessaie dans une heure.'));
    }
    const error = await add(values);
    res.writeHead(error ? 400 : 200, headers);
    return res.end(error
      ? page(form(values), error)
      : page(`<h1 class="title">C’est noté !</h1><p class="message">${escapeHtml(String(Math.floor(values.quantity)))} étiquette(s) pour le casier <b>${escapeHtml(values.locker.trim())}</b>. On te les dépose bientôt.</p><p><a class="button" href="/">Voir la blague du jour</a></p>`));
  }

  // ---------- Admin ----------

  function adminHtml() {
    const fmt = (iso) => new Intl.DateTimeFormat('fr-CA', {
      timeZone: config.TIME_ZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
    const open = pending().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const done = requests.filter((r) => r.deliveredAt).sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt)).slice(0, 10);
    const total = open.reduce((n, r) => n + r.quantity, 0);
    const row = (r, delivered) => `<tr><td><b>Casier ${escapeHtml(r.locker)}</b> · ${r.quantity} étiquette(s)<br>
<small style="color:var(--secondary)">${escapeHtml([r.name, r.note].filter(Boolean).join(' · ') || '—')} · ${fmt(delivered ? r.deliveredAt : r.createdAt)}</small></td>
<td><form method="post" action="/admin/ads" style="display:inline"><input type="hidden" name="id" value="${r.id}">
<button name="action" value="${delivered ? 'undo' : 'done'}" class="${delivered ? 'alt' : ''}" type="submit">${delivered ? 'Annuler' : 'Livré'}</button>
<button name="action" value="delete" class="alt" type="submit" aria-label="Supprimer">✕</button></form></td></tr>`;
    return `<div class="card" style="margin-top:16px"><h2>Demandes d’étiquettes (/ads)${open.length ? ` · ${open.length} en attente, ${total} étiquettes` : ''}</h2>
${open.length ? `<table>${open.map((r) => row(r, false)).join('')}</table>` : '<p class="empty">Aucune demande en attente.</p>'}
${done.length ? `<details style="margin-top:12px"><summary>Livrées récemment</summary><table>${done.map((r) => row(r, true)).join('')}</table></details>` : ''}</div>`;
  }

  async function handleAdmin(req) {
    const { id, action } = await readForm(req);
    if (action === 'done' || action === 'undo') await markDelivered(id, action === 'done');
    if (action === 'delete') await remove(id);
  }

  return { handle, adminHtml, handleAdmin, pendingCount: () => pending().length };
}

module.exports = { createAds };
