'use strict';

// The library: more human-written jokes from the same public APIs as the daily joke, collected slowly
// in the background and published as pages (never as the joke of the day: the daily pick never uses them).
// Each one goes through the word filter AND the Groq check. Without a Groq key nothing is imported, and a joke
// Groq could not judge is skipped (the daily joke is more lenient; a library that grows by itself is not).

const config = require('./config');
const moderation = require('./moderation');

const PER_RUN_DEFAULT = 8;
const EVERY_MS = 30 * 60e3;

function createLibrary({ getStore, save, sources, acceptable, seenIds }) {
  let timer = null;
  let running = false;

  const status = { last: null, added: 0, rejected: 0, skipped: 0, note: '' };

  async function runOnce() {
    if (running) return status;
    const perRun = config.LIBRARY_PER_RUN;
    if (!perRun) { status.note = 'désactivée (LIBRARY_PER_RUN = 0)'; return status; }
    if (!moderation.enabled()) { status.note = 'inactive : demande une clé Groq (GROQ_API_KEY)'; return status; }
    running = true;
    try {
      const store = getStore();
      store.library ||= [];
      store.rejected ||= [];
      const seen = seenIds();
      let added = 0;
      let misses = 0;
      for (let tries = 0; added < perRun && tries < perRun * 4 && misses < 12; tries++) {
        if (store.library.length >= config.LIBRARY_MAX) { status.note = 'pleine'; break; }
        if (tries) await new Promise((r) => setTimeout(r, 700)); // be kind to the free APIs
        const source = sources[tries % sources.length];
        let joke;
        try { joke = await source(); } catch { misses++; continue; }
        if (!joke || seen.has(joke.id) || store.rejected.includes(joke.id)) { misses++; continue; }
        if (!acceptable(joke.text)) { store.rejected.push(joke.id); status.rejected++; continue; }
        const check = await moderation.moderate(joke.text);
        if (check.ok !== true) {
          if (check.ok === false) { store.rejected.push(joke.id); status.rejected++; } else status.skipped++;
          continue; // refused, or Groq could not answer: not published
        }
        const n = (store.library.at(-1)?.n || 0) + 1;
        store.library.push({ n, id: joke.id, text: joke.text, source: joke.source, sourceUrl: joke.sourceUrl, lang: 'fr', addedAt: new Date().toISOString() });
        seen.add(joke.id);
        added++;
        status.added++;
      }
      store.rejected = store.rejected.slice(-2000);
      if (added) await save();
      status.last = new Date().toISOString();
      status.note = added ? `${added} ajoutée${added > 1 ? 's' : ''}` : 'rien de nouveau';
      console.log(`[library] ${status.note} (total ${store.library.length})`);
    } catch (err) {
      console.warn(`[library] ${err.message}`);
    } finally {
      running = false;
    }
    return status;
  }

  function start() {
    clearInterval(timer);
    setTimeout(() => runOnce(), 30e3).unref(); // not during startup
    timer = setInterval(() => runOnce(), EVERY_MS);
    timer.unref();
  }

  return { runOnce, start, status };
}

module.exports = { createLibrary };
