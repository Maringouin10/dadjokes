'use strict';

// Search-engine and sharing side of the site: one permanent page per past joke (/blague/<date>-<slug>),
// the archive (/blagues, /blagues/<YYYY-MM>), sitemap.xml, robots.txt, and the <head> tags of the home page.
// Only jokes of the PREVIOUS periods get a page: today's joke lives on the home page.

const config = require('./config');
const { escapeHtml } = require('./notifications');
const { ogPng } = require('./print');
const { THEMES, BY_SLUG, MIN_JOKES, themesOf } = require('./themes');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

const longDate = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)));
};
const monthName = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
};

function splitJoke(text) {
  const [setup, ...rest] = String(text).split('\n');
  const punchline = rest.join('\n').trim();
  return { setup, punchline: punchline || null };
}

function slugOf(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
}

const clip = (text, max) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
};

// A setup without final punctuation gets "…" so the sentence after it reads well.
const sentence = (text) => (/[.!?…»)]$/.test(String(text).trim()) ? String(text).trim() : `${String(text).trim()} …`);

// JSON inside <script>: "<" is escaped so the data can never close the tag.
const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

function createSeo({ getStore, currentKey }) {
  const base = () => config.SITE_URL;

  // Everything that has a page, newest first: the past daily jokes only (/blague/<date>-<slug>), i.e. jokes that
  // were already revealed. Past, French, not removed, not from the local fallback list.
  // Recomputed at most once a minute (ratings change, thousands of jokes are cheap but not free).
  let memo = null;
  function load() {
    const store = getStore();
    const today = currentKey();
    if (memo && memo.today === today && Date.now() - memo.at < 60e3) return memo;
    const banned = new Set(store.banned || []);
    const make = (fields, j) => {
      const { setup, punchline } = splitJoke(j.text);
      const slug = slugOf(setup);
      return { ...fields, joke: j, setup, punchline, slug, themes: themesOf(j.text) };
    };
    const daily = Object.entries(store.days)
      .filter(([day, j]) => DAY.test(day) && day < today && j.lang === 'fr' && !j.unavailable && !j.fallback && !banned.has(j.id))
      .map(([day, j]) => make({ kind: 'day', key: day, day, sortKey: `${day}|0` }, j));
    for (const e of daily) e.path = `/blague/${e.key}${e.slug ? `-${e.slug}` : ''}`;
    const byNew = (a, b2) => (a.sortKey < b2.sortKey ? 1 : -1);
    daily.sort(byNew);
    const all = daily;
    const themes = new Map(THEMES.map((t) => [t.slug, all.filter((e) => e.themes.includes(t.slug))]));
    const rated = daily.filter((e) => e.joke.ratings && e.joke.ratings.count >= 3)
      .sort((a, b2) => b2.joke.ratings.sum / b2.joke.ratings.count - a.joke.ratings.sum / a.joke.ratings.count
        || b2.joke.ratings.count - a.joke.ratings.count);
    memo = { at: Date.now(), today, daily, all, themes, rated, byKey: new Map(all.map((e) => [e.key, e])) };
    return memo;
  }

  const archive = () => load().daily; // kept for the callers that only need the daily ones
  const pathOf = (e) => e.path;
  const urlOf = (e) => `${base()}${e.path}`;
  const liveThemes = () => THEMES.filter((t) => load().themes.get(t.slug).length >= MIN_JOKES);
  const PAGE = 50;

  // Permanent link of a joke by day, for the API (today's link shows the home page until tomorrow).
  function permalink(day, text) {
    const slug = slugOf(splitJoke(text).setup);
    return `${base()}/blague/${day}${slug ? `-${slug}` : ''}`;
  }

  // ---------- Layout shared by the archive pages ----------

  function layout({ title, description, canonical, image, body, extraHead = '', robots = 'index, follow' }) {
    return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="${robots}">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="${escapeHtml(config.SITE_NAME)}">
  <meta property="og:locale" content="fr_CA">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  ${image ? `<meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${escapeHtml(image)}">` : '<meta name="twitter:card" content="summary">'}
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#dbf2fc" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#041c38" media="(prefers-color-scheme: dark)">
  <meta name="color-scheme" content="light dark">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <link rel="stylesheet" href="/styles.css">
  ${extraHead}
</head>
<body class="doc">
  <main class="page doc-page">
    <header class="header"><p class="eyebrow"><a href="/">${escapeHtml(config.SITE_NAME)}</a></p></header>
${body}
  </main>
  <footer class="footer">
    <p><a href="/">Blague du jour</a> · <a href="/blagues">Toutes les blagues</a> · <a href="/confidentialite">Confidentialité</a> · <a href="/conditions">Conditions</a></p>
  </footer>
  <script src="/visit.js" defer></script>
</body>
</html>`;
  }

  const breadcrumb = (items) => jsonLd({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: url })),
  });

  // ---------- One joke ----------

  const themeChips = (e) => e.themes.map((slug) => BY_SLUG.get(slug)).filter((t) => t && load().themes.get(t.slug).length >= MIN_JOKES)
    .map((t) => `<a class="chip" href="/blagues/theme/${t.slug}">${escapeHtml(t.name.replace(/^Blagues (?:de |d’)?/, ''))}</a>`).join('');

  function jokePage(entry) {
    const { joke, setup, punchline } = entry;
    const data = load();
    const kindList = data.daily; // newest first
    const i = kindList.findIndex((e) => e.key === entry.key);
    const newer = kindList[i - 1];
    const older = kindList[i + 1];
    const url = urlOf(entry);
    const date = entry.day ? longDate(entry.day) : null;
    const title = entry.day ? `${clip(setup, 70)} | Blague du ${date}` : `${clip(setup, 70)} | Blague plate`;
    const description = clip(`${sentence(setup)} Découvre la chute de cette blague plate${date ? ` du ${date}` : ''}, et une nouvelle blague chaque jour.`, 160);
    const link = (e, which) => `<a class="doc-nav-link" href="${e.path}" rel="${which === 'older' ? 'prev' : 'next'}">${which === 'older' ? '‹ Blague précédente' : 'Blague suivante ›'}</a>`;
    const ratings = joke.ratings && joke.ratings.count >= 3
      ? `<p class="doc-rating">Note des visiteurs : <b>${(joke.ratings.sum / joke.ratings.count).toFixed(1).replace('.', ',')}/10</b> (${joke.ratings.count} votes)</p>` : '';
    const source = joke.sourceUrl
      ? `Source : <a href="${escapeHtml(joke.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(joke.source)}</a>`
      : `Source : ${escapeHtml(joke.source)}`;
    const shareText = encodeURIComponent(`${setup}${punchline ? '\n… ' + punchline : ''}\n\n`);
    const enc = (src) => encodeURIComponent(`${url}?src=${src}`);
    // Related: the neighbours in the first theme that has a page, else in the same list.
    const themeSlug = entry.themes.find((slug) => slug !== 'courtes' && data.themes.get(slug).length >= MIN_JOKES);
    const pool = themeSlug ? data.themes.get(themeSlug) : kindList;
    const at = pool.findIndex((e) => e.key === entry.key);
    const more = pool.slice(Math.max(0, at - 3), at + 4).filter((e) => e.key !== entry.key);
    const contact = config.PRIVACY_EMAIL || config.EMAIL_REPLY_TO;
    const report = contact && contact.includes('@')
      ? `<p class="doc-report"><a href="mailto:${escapeHtml(contact)}?subject=${encodeURIComponent(`Signaler une blague : ${url}`)}">Signaler cette blague</a></p>` : '';
    const body = `    <article class="history-item doc-joke">
      <p class="history-date">${date ? `<time datetime="${entry.day}">${escapeHtml(date)}</time>` : 'Blague plate'}</p>
      <h1 class="doc-setup">${escapeHtml(setup)}</h1>
      ${punchline ? `<details class="doc-answer"><summary>Voir la réponse</summary><p class="doc-punchline">${escapeHtml(punchline)}</p></details>` : ''}
      ${ratings}
      <p class="history-source">${source} · contenu externe, nous n’en sommes pas responsables</p>
    </article>
    ${themeChips(entry) ? `<p class="doc-chips">${themeChips(entry)}</p>` : ''}
    <p class="doc-share">
      <a class="button secondary" href="https://wa.me/?text=${shareText}${enc('wa')}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
      <a class="button secondary" href="https://www.facebook.com/sharer/sharer.php?u=${enc('fb')}" target="_blank" rel="noopener noreferrer">Facebook</a>
      <a class="button secondary" href="https://twitter.com/intent/tweet?url=${enc('x')}&amp;text=${shareText}" target="_blank" rel="noopener noreferrer">X</a>
    </p>
    <nav class="doc-nav" aria-label="Autres blagues">${older ? link(older, 'older') : '<span></span>'}${newer ? link(newer, 'newer') : '<span></span>'}</nav>
    <p class="doc-cta"><a class="button" href="/?src=archive">Voir la blague d’aujourd’hui</a></p>
    ${more.length ? `<section class="doc-more"><h2 class="doc-h2">D’autres blagues${themeSlug ? ` : ${escapeHtml(BY_SLUG.get(themeSlug).name.toLowerCase().replace(/^blagues /, ''))}` : ''}</h2><ul class="doc-list">${more.map((e) => `<li><a href="${e.path}">${escapeHtml(e.setup)}</a></li>`).join('')}</ul></section>` : ''}
    ${report}`;
    return layout({
      title, description, canonical: url, image: `${base()}/og/${entry.key}.png`, body,
      extraHead: `${jsonLd({
        '@context': 'https://schema.org', '@type': 'WebPage', name: title, url, inLanguage: 'fr',
        ...(entry.day ? { datePublished: entry.day } : {}), isPartOf: { '@type': 'WebSite', name: config.SITE_NAME, url: base() },
      })}
  ${breadcrumb([[config.SITE_NAME, `${base()}/`], ['Blagues', `${base()}/blagues`], [clip(setup, 60), url]])}`,
    });
  }

  // ---------- Lists: archive, months, themes, best ----------

  const jokeList = (entries) => `<ul class="doc-list">${entries.map((e) => `<li><a href="${e.path}">${escapeHtml(e.setup)}</a>${e.day ? ` <span class="doc-date">${escapeHtml(longDate(e.day))}</span>` : ''}</li>`).join('')}</ul>`;

  const pager = (basePath, page, pages) => (pages <= 1 ? '' : `<nav class="doc-nav" aria-label="Pages">${
    page > 1 ? `<a class="doc-nav-link" href="${page === 2 ? basePath : `${basePath}/${page - 1}`}" rel="prev">‹ Page précédente</a>` : '<span></span>'}<span class="doc-date">Page ${page} sur ${pages}</span>${
    page < pages ? `<a class="doc-nav-link" href="${basePath}/${page + 1}" rel="next">Page suivante ›</a>` : '<span></span>'}</nav>`);

  function months() {
    const out = new Map();
    for (const e of load().daily) out.set(e.day.slice(0, 7), (out.get(e.day.slice(0, 7)) || 0) + 1);
    return [...out];
  }

  const hubLinks = () => {
    const data = load();
    const links = liveThemes().map((t) => `<li><a href="/blagues/theme/${t.slug}">${escapeHtml(t.name)}</a> <span class="doc-date">${data.themes.get(t.slug).length} blagues</span></li>`);
    if (data.rated.length >= MIN_JOKES) links.unshift(`<li><a href="/blagues/meilleures">Les meilleures blagues</a> <span class="doc-date">selon les notes des visiteurs</span></li>`);
    return links.length ? `<section><h2 class="doc-h2">Par thème</h2><ul class="doc-list">${links.join('')}</ul></section>` : '';
  };

  // /blagues (page 1) and /blagues/page/<n>
  function indexPage(page = 1) {
    const { all } = load();
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    if (page < 1 || page > pages) return null;
    const url = page === 1 ? `${base()}/blagues` : `${base()}/blagues/page/${page}`;
    const monthLinks = months().map(([m, n]) => `<li><a href="/blagues/${m}">${escapeHtml(monthName(m))}</a> <span class="doc-date">${n} blague${n > 1 ? 's' : ''} du jour</span></li>`).join('');
    const body = `    <h1 class="doc-h1">Toutes les blagues plates</h1>
    <p class="doc-intro">Une nouvelle blague plate chaque jour : voici toutes celles publiées, avec leur réponse.</p>
    ${page === 1 ? hubLinks() : ''}
    <section><h2 class="doc-h2">${page === 1 ? 'Les plus récentes' : `Page ${page}`}</h2>${all.length ? jokeList(all.slice((page - 1) * PAGE, page * PAGE)) : '<p class="doc-intro">Pas encore d’anciennes blagues. Reviens demain !</p>'}</section>
    ${pager('/blagues/page', page, pages).replace('href="/blagues/page"', 'href="/blagues"')}
    ${page === 1 && monthLinks ? `<section><h2 class="doc-h2">Les blagues du jour, mois par mois</h2><ul class="doc-list">${monthLinks}</ul></section>` : ''}`;
    return layout({
      title: `Toutes les blagues plates${page > 1 ? ` (page ${page})` : ''} | ${config.SITE_NAME}`,
      description: 'Toutes les blagues plates de La blague plate du jour, avec leur réponse : par thème, par mois, les meilleures. Une nouvelle blague chaque jour.',
      canonical: url, body,
      extraHead: breadcrumb([[config.SITE_NAME, `${base()}/`], ['Blagues', `${base()}/blagues`]]),
    });
  }

  function monthPage(month) {
    const entries = load().daily.filter((e) => e.day.startsWith(month));
    if (!entries.length) return null;
    const url = `${base()}/blagues/${month}`;
    const name = monthName(month);
    const body = `    <h1 class="doc-h1">Blagues plates de ${escapeHtml(name)}</h1>
    <p class="doc-intro">${entries.length} blague${entries.length > 1 ? 's' : ''} du jour en ${escapeHtml(name)}.</p>
    <section>${jokeList(entries)}</section>
    <p class="doc-cta"><a class="button secondary" href="/blagues">Toutes les blagues</a></p>`;
    return layout({
      title: `Blagues plates de ${name} | ${config.SITE_NAME}`,
      description: clip(`Les blagues plates de ${name} : ${entries.slice(0, 3).map((e) => sentence(e.setup)).join(' ')}`, 160),
      canonical: url, body,
      extraHead: breadcrumb([[config.SITE_NAME, `${base()}/`], ['Blagues', `${base()}/blagues`], [name, url]]),
    });
  }

  // /blagues/theme/<slug> and /blagues/theme/<slug>/<n>: only themes with enough jokes exist.
  function themePage(slug, page = 1) {
    const theme = BY_SLUG.get(slug);
    const list = theme && load().themes.get(slug);
    if (!list || list.length < MIN_JOKES) return null;
    const pages = Math.ceil(list.length / PAGE);
    if (page < 1 || page > pages) return null;
    const basePath = `/blagues/theme/${slug}`;
    const url = `${base()}${basePath}${page > 1 ? `/${page}` : ''}`;
    const others = liveThemes().filter((t) => t.slug !== slug)
      .map((t) => `<a class="chip" href="/blagues/theme/${t.slug}">${escapeHtml(t.name.replace(/^Blagues (?:de |d’)?/, ''))}</a>`).join('');
    const body = `    <h1 class="doc-h1">${escapeHtml(theme.name)}</h1>
    <p class="doc-intro">${escapeHtml(theme.intro)} ${list.length} blagues.</p>
    <section>${jokeList(list.slice((page - 1) * PAGE, page * PAGE))}</section>
    ${pager(basePath, page, pages)}
    ${others ? `<section><h2 class="doc-h2">Autres thèmes</h2><p class="doc-chips">${others}</p></section>` : ''}
    <p class="doc-cta"><a class="button secondary" href="/blagues">Toutes les blagues</a></p>`;
    return layout({
      title: `${theme.name}${page > 1 ? ` (page ${page})` : ''} | ${config.SITE_NAME}`,
      description: clip(`${theme.intro} ${sentence(list[0].setup)}`, 160),
      canonical: url, body,
      extraHead: breadcrumb([[config.SITE_NAME, `${base()}/`], ['Blagues', `${base()}/blagues`], [theme.name, `${base()}${basePath}`]]),
    });
  }

  // The best jokes, from the 1–10 ratings of the visitors (jokes of the day with at least 3 votes).
  function bestPage() {
    const { rated } = load();
    if (rated.length < MIN_JOKES) return null;
    const url = `${base()}/blagues/meilleures`;
    const top = rated.slice(0, PAGE);
    const body = `    <h1 class="doc-h1">Les meilleures blagues plates</h1>
    <p class="doc-intro">Classées selon la note (sur 10) donnée par les visiteurs.</p>
    <section><ul class="doc-list">${top.map((e) => `<li><a href="${e.path}">${escapeHtml(e.setup)}</a> <span class="doc-date">${(e.joke.ratings.sum / e.joke.ratings.count).toFixed(1).replace('.', ',')}/10 · ${e.joke.ratings.count} votes</span></li>`).join('')}</ul></section>
    <p class="doc-cta"><a class="button secondary" href="/blagues">Toutes les blagues</a></p>`;
    return layout({
      title: `Les meilleures blagues plates | ${config.SITE_NAME}`,
      description: clip(`Les blagues plates les mieux notées par les visiteurs : ${top.slice(0, 3).map((e) => sentence(e.setup)).join(' ')}`, 160),
      canonical: url, body,
      extraHead: breadcrumb([[config.SITE_NAME, `${base()}/`], ['Blagues', `${base()}/blagues`], ['Meilleures', url]]),
    });
  }

  // ---------- Sitemap and robots ----------

  function sitemap() {
    const data = load();
    const urls = [
      { loc: `${base()}/`, changefreq: 'daily', priority: '1.0' },
      { loc: `${base()}/blagues`, changefreq: 'daily', priority: '0.8' },
      ...Array.from({ length: Math.ceil(data.all.length / PAGE) - 1 }, (_, i) => ({ loc: `${base()}/blagues/page/${i + 2}`, changefreq: 'daily', priority: '0.4' })),
      ...(data.rated.length >= MIN_JOKES ? [{ loc: `${base()}/blagues/meilleures`, changefreq: 'weekly', priority: '0.7' }] : []),
      ...liveThemes().flatMap((t) => Array.from({ length: Math.ceil(data.themes.get(t.slug).length / PAGE) }, (_, i) => ({
        loc: `${base()}/blagues/theme/${t.slug}${i ? `/${i + 1}` : ''}`, changefreq: 'weekly', priority: i ? '0.4' : '0.7',
      }))),
      ...months().map(([m]) => ({ loc: `${base()}/blagues/${m}`, changefreq: 'monthly', priority: '0.6' })),
    ];
    const jokes = data.all.slice(0, 50000 - urls.length).map((e) => ({ loc: urlOf(e), lastmod: e.day, priority: '0.5' }));
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...urls, ...jokes].map((u) => `<url><loc>${escapeHtml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}${u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : ''}<priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`;
  }

  const robots = () => `User-agent: *
Allow: /
Disallow: /admin
Disallow: /ads
Disallow: /api/
Disallow: /email/

Sitemap: ${base()}/sitemap.xml
`;

  // ---------- Share images (1200 × 630, setup only) ----------

  const images = new Map();
  // key: a day (YYYY-MM-DD). Only the setup is drawn, so today's joke can have one too.
  function ogImage(key) {
    let joke;
    if (DAY.test(key)) joke = getStore().days[key];
    if (!joke || joke.lang !== 'fr' || joke.unavailable) return null;
    const cacheKey = `${key}|${joke.id}`;
    if (!images.has(cacheKey)) {
      if (images.size >= 300) images.delete(images.keys().next().value);
      const { setup, punchline } = splitJoke(joke.text);
      images.set(cacheKey, punchline ? ogPng(setup) : ogPng(setup, 'Une nouvelle blague plate chaque jour'));
    }
    return images.get(cacheKey);
  }

  // ---------- Home page: <head> tags and the joke itself in the HTML ----------

  function homeHead(day, joke) {
    const url = `${base()}/`;
    const title = `${config.SITE_NAME} : la blague du jour`;
    const setup = joke && !joke.unavailable ? splitJoke(joke.text).setup : null;
    const description = clip(setup
      ? `${sentence(setup)} Découvre la chute et une nouvelle blague plate ${config.SCHEDULE_TEXT}.`
      : `Une nouvelle blague plate ${config.SCHEDULE_TEXT}.`, 160);
    const image = setup ? `${base()}/og/${day}.png` : `${base()}/icons/icon-512.png`;
    return `<title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${escapeHtml(url)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escapeHtml(config.SITE_NAME)}">
  <meta property="og:locale" content="fr_CA">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta name="twitter:card" content="${setup ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">
  ${jsonLd({ '@context': 'https://schema.org', '@type': 'WebSite', name: config.SITE_NAME, url, inLanguage: 'fr' })}`;
  }

  return { load, archive, permalink, jokePage, indexPage, monthPage, themePage, bestPage, sitemap, robots, ogImage, homeHead, slugOf, splitJoke, MONTH, DAY };
}

module.exports = { createSeo };
