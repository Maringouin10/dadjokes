'use strict';

// Search-engine and sharing side of the site: one permanent page per past joke (/blague/<date>-<slug>),
// the archive (/blagues, /blagues/<YYYY-MM>), sitemap.xml, robots.txt, and the <head> tags of the home page.
// Only jokes of the PREVIOUS periods get a page: today's joke lives on the home page.

const config = require('./config');
const { escapeHtml } = require('./notifications');
const { ogPng } = require('./print');

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

  // Past, shown, French, non-fallback, not removed: sorted newest first.
  function archive() {
    const store = getStore();
    const banned = new Set(store.banned || []);
    const today = currentKey();
    return Object.entries(store.days)
      .filter(([day, j]) => DAY.test(day) && day < today && j.lang === 'fr' && !j.unavailable && !j.fallback && !banned.has(j.id))
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([day, j]) => ({ day, joke: j, ...splitJoke(j.text), slug: slugOf(splitJoke(j.text).setup) }));
  }

  const pathOf = (e) => `/blague/${e.day}${e.slug ? `-${e.slug}` : ''}`;
  const urlOf = (e) => `${base()}${pathOf(e)}`;

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

  function jokePage(entry, list) {
    const { day, joke, setup, punchline } = entry;
    const i = list.findIndex((e) => e.day === day);
    const newer = list[i - 1]; // the list is newest first
    const older = list[i + 1];
    const url = urlOf(entry);
    const date = longDate(day);
    const title = `${clip(setup, 70)} | Blague du ${date}`;
    const description = clip(`${sentence(setup)} Découvre la chute de cette blague plate du ${date}, et une nouvelle blague chaque jour.`, 160);
    const link = (e, label) => `<a class="doc-nav-link" href="${pathOf(e)}" rel="${label === 'older' ? 'prev' : 'next'}">${label === 'older' ? '‹ Blague précédente' : 'Blague suivante ›'}</a>`;
    const ratings = joke.ratings && joke.ratings.count >= 3
      ? `<p class="doc-rating">Note des visiteurs : <b>${(joke.ratings.sum / joke.ratings.count).toFixed(1).replace('.', ',')}/10</b> (${joke.ratings.count} votes)</p>` : '';
    const source = joke.sourceUrl
      ? `Source : <a href="${escapeHtml(joke.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(joke.source)}</a>`
      : `Source : ${escapeHtml(joke.source)}`;
    const shareText = encodeURIComponent(`${setup}${punchline ? '\n… ' + punchline : ''}\n\n`);
    const enc = (src) => encodeURIComponent(`${url}?src=${src}`);
    const more = list.slice(Math.max(0, i - 3), i + 4).filter((e) => e.day !== day);
    const body = `    <article class="history-item doc-joke">
      <p class="history-date"><time datetime="${day}">${escapeHtml(date)}</time></p>
      <h1 class="doc-setup">${escapeHtml(setup)}</h1>
      ${punchline ? `<details class="doc-answer"><summary>Voir la réponse</summary><p class="doc-punchline">${escapeHtml(punchline)}</p></details>` : ''}
      ${ratings}
      <p class="history-source">${source} · contenu externe, nous n’en sommes pas responsables</p>
    </article>
    <p class="doc-share">
      <a class="button secondary" href="https://wa.me/?text=${shareText}${enc('wa')}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
      <a class="button secondary" href="https://www.facebook.com/sharer/sharer.php?u=${enc('fb')}" target="_blank" rel="noopener noreferrer">Facebook</a>
      <a class="button secondary" href="https://twitter.com/intent/tweet?url=${enc('x')}&amp;text=${shareText}" target="_blank" rel="noopener noreferrer">X</a>
    </p>
    <nav class="doc-nav" aria-label="Autres blagues">${older ? link(older, 'older') : '<span></span>'}${newer ? link(newer, 'newer') : '<span></span>'}</nav>
    <p class="doc-cta"><a class="button" href="/?src=archive">Voir la blague d’aujourd’hui</a></p>
    ${more.length ? `<section class="doc-more"><h2 class="doc-h2">D’autres blagues</h2><ul class="doc-list">${more.map((e) => `<li><a href="${pathOf(e)}">${escapeHtml(e.setup)}</a></li>`).join('')}</ul></section>` : ''}`;
    return layout({
      title, description, canonical: url, image: `${base()}/og/${day}.png`, body,
      extraHead: `${jsonLd({
        '@context': 'https://schema.org', '@type': 'WebPage', name: title, url, inLanguage: 'fr',
        datePublished: day, isPartOf: { '@type': 'WebSite', name: config.SITE_NAME, url: base() },
      })}
  ${breadcrumb([[config.SITE_NAME, `${base()}/`], ['Blagues', `${base()}/blagues`], [clip(setup, 60), url]])}`,
    });
  }

  // ---------- Archive: /blagues and /blagues/<YYYY-MM> ----------

  function months(list) {
    const out = new Map();
    for (const e of list) out.set(e.day.slice(0, 7), (out.get(e.day.slice(0, 7)) || 0) + 1);
    return [...out];
  }

  const jokeList = (entries) => `<ul class="doc-list">${entries.map((e) => `<li><a href="${pathOf(e)}">${escapeHtml(e.setup)}</a> <span class="doc-date">${escapeHtml(longDate(e.day))}</span></li>`).join('')}</ul>`;

  function indexPage(list) {
    const url = `${base()}/blagues`;
    const monthLinks = months(list).map(([m, n]) => `<li><a href="/blagues/${m}">${escapeHtml(monthName(m))}</a> <span class="doc-date">${n} blague${n > 1 ? 's' : ''}</span></li>`).join('');
    const body = `    <h1 class="doc-h1">Toutes les blagues plates</h1>
    <p class="doc-intro">Une nouvelle blague plate chaque jour : voici toutes celles déjà publiées, avec leur réponse.</p>
    <section><h2 class="doc-h2">Les plus récentes</h2>${list.length ? jokeList(list.slice(0, 30)) : '<p class="doc-intro">Pas encore d’anciennes blagues. Reviens demain !</p>'}</section>
    ${monthLinks ? `<section><h2 class="doc-h2">Par mois</h2><ul class="doc-list">${monthLinks}</ul></section>` : ''}`;
    return layout({
      title: `Toutes les blagues plates | ${config.SITE_NAME}`,
      description: 'Toutes les blagues plates publiées chaque jour sur La blague plate du jour, avec leur réponse. Une nouvelle blague chaque jour.',
      canonical: url, body,
      extraHead: breadcrumb([[config.SITE_NAME, `${base()}/`], ['Blagues', url]]),
    });
  }

  function monthPage(month, list) {
    const entries = list.filter((e) => e.day.startsWith(month));
    if (!entries.length) return null;
    const url = `${base()}/blagues/${month}`;
    const name = monthName(month);
    const body = `    <h1 class="doc-h1">Blagues plates de ${escapeHtml(name)}</h1>
    <p class="doc-intro">${entries.length} blague${entries.length > 1 ? 's' : ''} publiée${entries.length > 1 ? 's' : ''} en ${escapeHtml(name)}.</p>
    <section>${jokeList(entries)}</section>
    <p class="doc-cta"><a class="button secondary" href="/blagues">Tous les mois</a></p>`;
    return layout({
      title: `Blagues plates de ${name} | ${config.SITE_NAME}`,
      description: clip(`Les blagues plates de ${name} : ${entries.slice(0, 3).map((e) => e.setup).join(' ')}`, 160),
      canonical: url, body,
      extraHead: breadcrumb([[config.SITE_NAME, `${base()}/`], ['Blagues', `${base()}/blagues`], [name, url]]),
    });
  }

  // ---------- Sitemap and robots ----------

  function sitemap() {
    const list = archive();
    const urls = [
      { loc: `${base()}/`, changefreq: 'daily', priority: '1.0' },
      { loc: `${base()}/blagues`, changefreq: 'daily', priority: '0.8' },
      ...months(list).map(([m]) => ({ loc: `${base()}/blagues/${m}`, changefreq: 'monthly', priority: '0.6' })),
      ...list.slice(0, 50000 - 100).map((e) => ({ loc: urlOf(e), lastmod: e.day, priority: '0.5' })),
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${escapeHtml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}${u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : ''}<priority>${u.priority}</priority></url>`).join('\n')}
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
  function ogImage(day) {
    const store = getStore();
    const joke = store.days[day];
    if (!DAY.test(day) || !joke || joke.lang !== 'fr' || joke.unavailable) return null;
    const key = `${day}|${joke.id}`;
    if (!images.has(key)) {
      if (images.size >= 300) images.delete(images.keys().next().value);
      const { setup, punchline } = splitJoke(joke.text);
      images.set(key, punchline ? ogPng(setup) : ogPng(setup, 'Une nouvelle blague plate chaque jour'));
    }
    return images.get(key);
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

  return { archive, permalink, pathOf, jokePage, indexPage, monthPage, sitemap, robots, ogImage, homeHead, slugOf, splitJoke, MONTH, DAY };
}

module.exports = { createSeo };
