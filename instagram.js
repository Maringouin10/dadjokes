'use strict';

// Daily Instagram post through the Meta Graph API (Instagram content publishing).
// At each joke change (noon), the question is posted as an image + caption; the answer is never
// posted: the caption says it is on the site, through the link in the bio.
//
// Works with both kinds of Meta tokens:
//  - « Instagram API with Instagram Login » (token starting with IG…): graph.instagram.com,
//    the account id is found by itself, the token (60 days) is refreshed here every week.
//  - « Instagram API with Facebook Login » (Page token, EAA…): graph.facebook.com, INSTAGRAM_USER_ID needed.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const { instagramJpeg } = require('./print');
const { splitJoke } = require('./email-templates');

const API_VERSION = 'v23.0';
const CATCH_UP_HOURS = 6; // after downtime, a missed post is still made within this delay
const RETRY_MINUTES = [5, 15, 30, 60, 120];
const REFRESH_DAYS = 7;

function createInstagram({ dataDir, getCurrentJoke, periodStart }) {
  const file = path.join(dataDir, 'instagram.json');
  let state = { posts: {}, token: null };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch { /* first start */ }

  let saving = Promise.resolve();
  function save() {
    saving = saving.then(async () => {
      await fsp.mkdir(dataDir, { recursive: true });
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
      await fsp.rename(`${file}.tmp`, file);
    }).catch((err) => console.error('[instagram] save failed:', err.message));
    return saving;
  }

  const enabled = () => Boolean(config.INSTAGRAM_ACCESS_TOKEN);

  // The refreshed token is kept in /data; a new token typed in the settings replaces it.
  function token() {
    const base = config.INSTAGRAM_ACCESS_TOKEN;
    if (state.token && state.token.base === base) return state.token.value;
    return base;
  }
  const host = () => (token().startsWith('IG') ? 'graph.instagram.com' : 'graph.facebook.com');

  async function api(method, pathname, params = {}) {
    const url = new URL(`https://${host()}/${API_VERSION}/${pathname}`);
    const body = new URLSearchParams({ ...params, access_token: token() });
    let res;
    if (method === 'GET') {
      for (const [k, v] of body) url.searchParams.set(k, v);
      res = await fetch(url, { signal: AbortSignal.timeout(30e3) });
    } else {
      res = await fetch(url, { method, body, signal: AbortSignal.timeout(60e3) });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const e = data.error || {};
      const err = new Error(`${e.message || `HTTP ${res.status}`}${e.code ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''}`);
      err.code = e.code;
      throw err;
    }
    return data;
  }

  async function userId() {
    if (config.INSTAGRAM_USER_ID) return config.INSTAGRAM_USER_ID;
    if (host() !== 'graph.instagram.com') throw new Error('INSTAGRAM_USER_ID manquant (obligatoire avec un jeton de Page Facebook)');
    const me = await api('GET', 'me', { fields: 'user_id,username' });
    return me.user_id || me.id;
  }

  // Instagram Login tokens last 60 days and can be extended once they are 24 h old.
  async function refreshToken() {
    if (!enabled() || host() !== 'graph.instagram.com') return;
    const base = config.INSTAGRAM_ACCESS_TOKEN;
    const last = state.token && state.token.base === base ? Date.parse(state.token.refreshedAt) : 0;
    if (Date.now() - last < REFRESH_DAYS * 86400e3) return;
    try {
      const url = new URL('https://graph.instagram.com/refresh_access_token');
      url.searchParams.set('grant_type', 'ig_refresh_token');
      url.searchParams.set('access_token', token());
      const res = await fetch(url, { signal: AbortSignal.timeout(30e3) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.access_token) throw new Error(data.error?.message || `HTTP ${res.status}`);
      state.token = {
        base,
        value: data.access_token,
        refreshedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + (data.expires_in || 0) * 1000).toISOString(),
      };
      await save();
      console.log(`[instagram] jeton renouvelé (expire le ${state.token.expiresAt.slice(0, 10)})`);
    } catch (err) {
      console.warn(`[instagram] renouvellement du jeton impossible : ${err.message}`);
    }
  }

  // ---------- Content ----------

  function question(joke) {
    const { setup } = splitJoke(joke.text);
    return setup || joke.text;
  }

  function caption(joke) {
    const { punchline } = splitJoke(joke.text);
    let text = config.INSTAGRAM_CAPTION.replace(/\\n/g, '\n');
    // A one-liner has no answer to hide: the whole joke is the « question ».
    if (!punchline) text = text.replace(/^.*(r[ée]ponse|bio).*$/im, '👉 Une nouvelle blague plate chaque jour à midi : lien dans la bio');
    return text.replaceAll('{question}', question(joke)).slice(0, 2200);
  }

  const images = new Map();
  // JPEG of a day's joke (question only): /ig/<YYYY-MM-DD>.jpg, fetched by Meta when posting.
  function image(key, joke) {
    if (!joke || joke.unavailable) return null;
    const cacheKey = `${key}|${joke.id}|${config.INSTAGRAM_TEASER}`;
    if (!images.has(cacheKey)) {
      if (images.size >= 20) images.delete(images.keys().next().value);
      const { punchline } = splitJoke(joke.text);
      images.set(cacheKey, instagramJpeg(question(joke), punchline ? config.INSTAGRAM_TEASER : 'Une nouvelle blague plate chaque jour'));
    }
    return images.get(cacheKey);
  }

  // ---------- Publishing ----------

  async function waitForContainer(id) {
    for (let i = 0; i < 30; i++) {
      const { status_code: status } = await api('GET', id, { fields: 'status_code' });
      if (status === 'FINISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`le conteneur média est en ${status} (image refusée ou injoignable ?)`);
      await new Promise((r) => setTimeout(r, 4000));
    }
    throw new Error('le conteneur média n’est pas prêt après 2 minutes');
  }

  async function publish(key, joke) {
    if (!config.PUBLIC_URL.startsWith('https://')) throw new Error('PUBLIC_URL doit être en https (Meta télécharge l’image depuis le site)');
    const id = await userId();
    const imageUrl = `${config.PUBLIC_URL}/ig/${key}.jpg?id=${encodeURIComponent(joke.id)}`;
    const container = await api('POST', `${id}/media`, { image_url: imageUrl, caption: caption(joke) });
    await waitForContainer(container.id);
    const media = await api('POST', `${id}/media_publish`, { creation_id: container.id });
    let permalink = null;
    try { ({ permalink = null } = await api('GET', media.id, { fields: 'permalink' })); } catch { /* optional */ }
    state.posts[key] = { mediaId: media.id, jokeId: joke.id, permalink, at: new Date().toISOString() };
    // Keep the last 60 posts only.
    for (const old of Object.keys(state.posts).sort().slice(0, -60)) delete state.posts[old];
    state.lastError = null;
    await save();
    console.log(`[instagram] ${key} publiée : ${permalink || media.id}`);
    return state.posts[key];
  }

  let running = null;
  let retryTimer = null;

  // Called at each joke change. force: post now even if late or already posted (admin button).
  async function postDaily({ force = false, attempt = 0 } = {}) {
    if (!enabled()) return { skipped: 'pas de jeton Instagram' };
    if (running) return running;
    running = (async () => {
      const { key, joke } = await getCurrentJoke();
      if (!force && state.posts[key]) return { skipped: 'déjà publiée' };
      if (!joke || joke.unavailable) return { skipped: 'blague non disponible' };
      if (!force && Date.now() - periodStart().getTime() > CATCH_UP_HOURS * 3600e3) return { skipped: 'trop tard pour aujourd’hui' };
      // A local fallback joke may still be replaced by an API one: wait a little first.
      if (!force && joke.fallback && attempt < 2) throw Object.assign(new Error('blague de secours, on attend les API'), { retry: true });
      await refreshToken();
      return publish(key, joke);
    })();
    try {
      return await running;
    } catch (err) {
      state.lastError = { at: new Date().toISOString(), message: err.message };
      await save();
      const wait = RETRY_MINUTES[attempt];
      // Auth errors (190) will not fix themselves: no retry.
      if (!force && wait && err.code !== 190) {
        console.warn(`[instagram] échec (${err.message}), nouvel essai dans ${wait} min`);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => postDaily({ attempt: attempt + 1 }).catch(() => {}), wait * 60e3);
      } else {
        console.error(`[instagram] échec : ${err.message}`);
      }
      throw err;
    } finally {
      running = null;
    }
  }

  // Weekly token refresh even when nothing is posted.
  setInterval(() => refreshToken(), 24 * 3600e3).unref();

  async function diagnose() {
    if (!enabled()) return ['  ➖ Instagram : désactivé (INSTAGRAM_ACCESS_TOKEN vide)'];
    const lines = [];
    try {
      const fields = host() === 'graph.instagram.com' ? 'user_id,username' : 'username';
      const id = host() === 'graph.instagram.com' ? 'me' : await userId();
      const me = await api('GET', id, { fields });
      lines.push(`  ✅ Instagram : connecté à @${me.username} (${host()}), publication chaque jour au changement de blague`);
      if (!config.PUBLIC_URL.startsWith('https://')) lines.push('  ❌ Instagram : PUBLIC_URL doit être en https pour que Meta récupère l’image');
      if (state.token?.expiresAt && state.token.base === config.INSTAGRAM_ACCESS_TOKEN) lines.push(`  ✅ Instagram : jeton renouvelé automatiquement, expire le ${state.token.expiresAt.slice(0, 10)}`);
    } catch (err) {
      lines.push(`  ❌ Instagram : ${err.message}`);
    }
    const last = Object.keys(state.posts).sort().pop();
    if (last) lines.push(`  ✅ Instagram : dernière publication le ${last}${state.posts[last].permalink ? ` (${state.posts[last].permalink})` : ''}`);
    if (state.lastError) lines.push(`  ⚠️  Instagram : dernier échec le ${state.lastError.at.slice(0, 16).replace('T', ' ')} : ${state.lastError.message}`);
    return lines;
  }

  return { enabled, postDaily, image, caption, diagnose, refreshToken };
}

module.exports = { createInstagram };
