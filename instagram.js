'use strict';

// Daily Instagram post through the Meta Graph API (Instagram content publishing).
// At each joke change (noon), the question is posted as an image + caption; the answer is never
// posted: the caption says it is on the site, through the link in the bio.
//
// Works with every kind of Meta token:
//  - « API setup with Unified login » (newer apps; system-user token EAA…, never expires):
//    graph.facebook.com, the account id is found with /me/assigned_instagram_accounts.
//  - « API setup with Instagram login » (token starting with IG…): graph.instagram.com,
//    the account id is found by itself, the token (60 days) is refreshed here every week.
//  - « API setup with Facebook login » (Page token, EAA…): graph.facebook.com, found through the Page.

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
  let state = { posts: {}, stories: {}, token: null };
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

  let foundId = null; // { token, id }
  async function userId() {
    if (config.INSTAGRAM_USER_ID) return config.INSTAGRAM_USER_ID;
    if (foundId && foundId.token === token()) return foundId.id;
    let id = null;
    if (host() === 'graph.instagram.com') {
      const me = await api('GET', 'me', { fields: 'user_id,username' });
      id = me.user_id || me.id;
    } else {
      // Unified login (system user): the Instagram accounts assigned to it.
      try {
        const { data = [] } = await api('GET', 'me/assigned_instagram_accounts', { fields: 'id,username' });
        if (data.length > 1) console.warn(`[instagram] plusieurs comptes (${data.map((a) => `@${a.username}`).join(', ')}) : le premier est utilisé, sinon mets INSTAGRAM_USER_ID`);
        id = data[0]?.id || null;
      } catch { /* not a system-user token */ }
      // Facebook login (Page token): the Instagram account linked to the Page.
      if (!id) {
        try {
          const { data = [] } = await api('GET', 'me/accounts', { fields: 'instagram_business_account' });
          id = data.find((p) => p.instagram_business_account)?.instagram_business_account.id || null;
        } catch { /* no Page */ }
      }
      if (!id) throw new Error('aucun compte Instagram lié à ce jeton : vérifie que le compte est choisi dans la configuration Meta, ou mets INSTAGRAM_USER_ID');
    }
    foundId = { token: token(), id };
    return id;
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
    return text.replaceAll('{question}', question(joke)).replaceAll('{lien}', `${config.SITE_URL}/`).slice(0, 2200);
  }

  const images = new Map();
  // JPEG of a day's joke (question only), fetched by Meta when posting:
  // /ig/<YYYY-MM-DD>.jpg (post, 4:5) and /ig/<YYYY-MM-DD>-story.jpg (story, 9:16).
  function image(key, joke, story = false) {
    if (!joke || joke.unavailable) return null;
    const cacheKey = `${key}|${joke.id}|${config.INSTAGRAM_TEASER}|${story}|${config.SITE_URL}`;
    if (!images.has(cacheKey)) {
      if (images.size >= 20) images.delete(images.keys().next().value);
      const { punchline } = splitJoke(joke.text);
      const teaser = punchline ? (story ? config.INSTAGRAM_STORY_TEASER : config.INSTAGRAM_TEASER) : 'Une nouvelle blague plate chaque jour';
      // The story shows the full address: a link sticker cannot be added through the API.
      const site = config.SITE_URL.replace(/^https?:\/\//, '');
      images.set(cacheKey, instagramJpeg(question(joke), teaser, story ? `${site}  →` : site, story));
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

  const storyEnabled = () => config.INSTAGRAM_STORY === 'OUI';
  const done = (key) => Boolean(state.posts[key] && (!storyEnabled() || state.stories[key]));

  async function publishOne(id, params) {
    const container = await api('POST', `${id}/media`, params);
    await waitForContainer(container.id);
    return api('POST', `${id}/media_publish`, { creation_id: container.id });
  }

  // The post, then the story; each is recorded at once, so a retry only redoes what is missing.
  // force: post again even if already done today (admin button).
  async function publish(key, joke, force = false) {
    if (!config.PUBLIC_URL.startsWith('https://')) throw new Error('PUBLIC_URL doit être en https (Meta télécharge l’image depuis le site)');
    const id = await userId();
    const base = `${config.PUBLIC_URL}/ig/${key}`;
    const v = `?id=${encodeURIComponent(joke.id)}`;
    const result = {};
    if (force || !state.posts[key]) {
      const media = await publishOne(id, { image_url: `${base}.jpg${v}`, caption: caption(joke) });
      let permalink = null;
      try { ({ permalink = null } = await api('GET', media.id, { fields: 'permalink' })); } catch { /* optional */ }
      state.posts[key] = { mediaId: media.id, jokeId: joke.id, permalink, at: new Date().toISOString() };
      await save();
      console.log(`[instagram] ${key} publication : ${permalink || media.id}`);
    }
    result.post = state.posts[key];
    if (storyEnabled() && (force || !state.stories[key])) {
      const media = await publishOne(id, { image_url: `${base}-story.jpg${v}`, media_type: 'STORIES' });
      state.stories[key] = { mediaId: media.id, jokeId: joke.id, at: new Date().toISOString() };
      await save();
      console.log(`[instagram] ${key} story : ${media.id}`);
    }
    result.story = state.stories[key] || null;
    // Keep the last 60 days only.
    for (const list of [state.posts, state.stories]) for (const old of Object.keys(list).sort().slice(0, -60)) delete list[old];
    state.lastError = null;
    await save();
    return { ...result.post, story: result.story };
  }

  let running = null;
  let retryTimer = null;

  // Called at each joke change. force: post now even if late or already posted (admin button).
  async function postDaily({ force = false, attempt = 0 } = {}) {
    if (!enabled()) return { skipped: 'pas de jeton Instagram' };
    if (running) return running;
    running = (async () => {
      const { key, joke } = await getCurrentJoke();
      if (!force && done(key)) return { skipped: 'déjà publiée' };
      if (!joke || joke.unavailable) return { skipped: 'blague non disponible' };
      if (!force && Date.now() - periodStart().getTime() > CATCH_UP_HOURS * 3600e3) return { skipped: 'trop tard pour aujourd’hui' };
      // A local fallback joke may still be replaced by an API one: wait a little first.
      if (!force && joke.fallback && attempt < 2) throw Object.assign(new Error('blague de secours, on attend les API'), { retry: true });
      await refreshToken();
      return publish(key, joke, force);
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
    const lastStory = Object.keys(state.stories).sort().pop();
    if (storyEnabled()) lines.push(lastStory ? `  ✅ Instagram : dernière story le ${lastStory}` : '  ✅ Instagram : une story est aussi publiée chaque jour');
    if (state.lastError) lines.push(`  ⚠️  Instagram : dernier échec le ${state.lastError.at.slice(0, 16).replace('T', ' ')} : ${state.lastError.message}`);
    return lines;
  }

  return { enabled, postDaily, image, caption, diagnose, refreshToken };
}

module.exports = { createInstagram };
