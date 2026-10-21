'use strict';

// HTML e-mails: table layout and inline styles so they render the same in Gmail, Outlook and
// Apple Mail, with a dark mode for the clients that support it.

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif";
const C = {
  bg: '#f5f5f7', card: '#ffffff', label: '#1d1d1f', secondary: '#6e6e73', tertiary: '#86868b',
  accent: '#0071e3', separator: '#e5e5ea',
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function splitJoke(text) {
  const [setup, ...rest] = text.split('\n');
  const punchline = rest.join('\n').trim();
  return punchline ? { setup, punchline } : { setup: null, punchline: null };
}

function formatDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  const day = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)));
  return day.charAt(0).toUpperCase() + day.slice(1);
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
<tr><td class="btn" align="center" bgcolor="${C.accent}" style="border-radius:980px;background:${C.accent};">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:17px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:980px;">${label}</a>
</td></tr></table>`;
}

function card(inner, { padding = '40px 28px' } = {}) {
  return `<tr><td class="card" bgcolor="${C.card}" style="background:${C.card};border-radius:22px;padding:${padding};text-align:center;">${inner}</td></tr>`;
}

function spacer(height) {
  return `<tr><td style="height:${height}px;line-height:${height}px;font-size:0;">&nbsp;</td></tr>`;
}

// Common frame: hidden preview text, header with icon and date, content rows, footer.
function layout({ baseUrl, preheader, eyebrow, rows, footer }) {
  // Pads the preview so clients don't fill it with the body text (which could show the punchline).
  const filler = '&#847;&zwnj;&nbsp;'.repeat(60);
  return `<!doctype html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>La blague plate du jour</title>
<style>
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  a { color:${C.accent}; }
  @media (prefers-color-scheme: dark) {
    .bg { background:#000000 !important; }
    .card { background:#1c1c1e !important; }
    .label { color:#f5f5f7 !important; }
    .secondary { color:#a1a1a6 !important; }
    .accent { color:#2997ff !important; }
    .btn { background:#2997ff !important; }
  }
  @media (max-width: 480px) {
    .joke { font-size:24px !important; line-height:31px !important; }
  }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};">${escapeHtml(preheader)}${filler}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg};">
<tr><td align="center" style="padding:32px 16px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:${FONT};">
<tr><td align="center" style="padding:0 0 24px;">
  <a href="${escapeHtml(baseUrl)}" style="text-decoration:none;"><img src="${escapeHtml(baseUrl)}/icons/icon-192.png" width="52" height="52" alt="" style="display:block;border:0;border-radius:12px;"></a>
  <p class="secondary" style="margin:14px 0 2px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${C.secondary};">${escapeHtml(eyebrow)}</p>
  <p class="label" style="margin:0;font-size:26px;line-height:32px;font-weight:700;letter-spacing:-.01em;color:${C.label};">La blague plate du jour</p>
</td></tr>
${rows.join('\n')}
<tr><td align="center" class="secondary" style="padding:32px 12px 0;font-size:12px;line-height:18px;color:${C.tertiary};">${footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function jokeRows({ joke, revealUrl, revealLabel }) {
  const { setup, punchline } = splitJoke(joke.text);
  const text = (t, cls, color) => `<p class="joke ${cls}" style="margin:0;font-size:27px;line-height:35px;font-weight:600;letter-spacing:-.01em;color:${color};">${escapeHtml(t)}</p>`;
  if (!setup) {
    return [card(text(joke.text, 'label', C.label)), spacer(24), `<tr><td>${button(revealUrl, 'Voir sur le site')}</td></tr>`];
  }
  return [
    card(`${text(setup, 'label', C.label)}
<p class="secondary" style="margin:20px 0 0;font-size:14px;color:${C.tertiary};">…</p>`),
    spacer(24),
    `<tr><td>${button(revealUrl, revealLabel)}</td></tr>`,
    spacer(14),
    `<tr><td align="center" class="secondary" style="font-size:13px;line-height:18px;color:${C.tertiary};">Pas envie de cliquer ? La réponse est tout en bas 👇</td></tr>`,
    spacer(260), // keeps the punchline out of sight until you scroll
    card(`<p class="secondary" style="margin:0 0 10px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${C.tertiary};">La réponse</p>
${text(punchline, 'accent', C.accent)}`, { padding: '32px 28px' }),
  ];
}

const SCHEDULE = 'Une nouvelle blague chaque jour à midi (heure de New York).';

function footerHtml({ joke, unsubscribeUrl }) {
  const source = joke.sourceUrl
    ? `<a href="${escapeHtml(joke.sourceUrl)}" style="color:${C.tertiary};">${escapeHtml(joke.source)}</a>`
    : escapeHtml(joke.source);
  return `Blague : ${source}<br>${SCHEDULE}<br><br>
Tu reçois cet e-mail parce que tu t’es abonné à la blague plate du jour.<br>
<a href="${escapeHtml(unsubscribeUrl)}" style="color:${C.tertiary};">Se désabonner</a>`;
}

function subjectFor(joke) {
  const { setup } = splitJoke(joke.text);
  const line = setup || joke.text;
  return `😐 ${line.length > 70 ? `${line.slice(0, 67).trimEnd()}…` : line}`;
}

function jokeText({ joke, baseUrl, revealUrl, unsubscribeUrl, intro = '' }) {
  const { setup, punchline } = splitJoke(joke.text);
  return [
    intro,
    setup || joke.text,
    punchline ? `\nRetourne la carte : ${revealUrl}\n\n\n\n\n\n\n\nLa réponse : ${punchline}` : `\n${baseUrl}`,
    `\n—\nBlague : ${joke.source}\n${SCHEDULE}\nSe désabonner : ${unsubscribeUrl}`,
  ].filter(Boolean).join('\n');
}

// Daily e-mail.
function dailyEmail({ joke, key, baseUrl, unsubscribeUrl }) {
  const { setup } = splitJoke(joke.text);
  const revealUrl = `${baseUrl}/?reveal=1`;
  return {
    subject: subjectFor(joke),
    html: layout({
      baseUrl,
      preheader: setup ? 'Retourne la carte pour découvrir la réponse… si tu oses.' : 'Ta dose quotidienne de blague plate.',
      eyebrow: formatDay(key),
      rows: jokeRows({ joke, revealUrl, revealLabel: 'Retourner la carte' }),
      footer: footerHtml({ joke, unsubscribeUrl }),
    }),
    text: jokeText({ joke, baseUrl, revealUrl, unsubscribeUrl }),
  };
}

// Sent right after the address is confirmed, with the current joke so there's no wait.
function welcomeEmail({ joke, key, baseUrl, unsubscribeUrl }) {
  const revealUrl = `${baseUrl}/?reveal=1`;
  const intro = `<tr><td align="center" class="label" style="padding:0 8px 24px;font-size:17px;line-height:25px;color:${C.label};">
C’est confirmé ✅ Pour ne pas te faire attendre, voici déjà celle d’aujourd’hui.</td></tr>`;
  return {
    subject: 'Bienvenue ! Voici ta première blague plate 😐',
    html: layout({
      baseUrl,
      preheader: 'Ton abonnement est confirmé. Voici déjà la blague d’aujourd’hui.',
      eyebrow: formatDay(key),
      rows: [intro, ...jokeRows({ joke, revealUrl, revealLabel: 'Retourner la carte' })],
      footer: footerHtml({ joke, unsubscribeUrl }),
    }),
    text: jokeText({ joke, baseUrl, revealUrl, unsubscribeUrl, intro: 'C’est confirmé ! Voici déjà la blague d’aujourd’hui :\n' }),
  };
}

// Double opt-in.
function confirmEmail({ baseUrl, confirmUrl }) {
  const rows = [
    card(`<p style="margin:0 0 14px;font-size:44px;line-height:48px;">😐</p>
<p class="label" style="margin:0 0 10px;font-size:22px;line-height:28px;font-weight:700;color:${C.label};">Une blague plate par jour ?</p>
<p class="secondary" style="margin:0 0 28px;font-size:16px;line-height:24px;color:${C.secondary};">Confirme ton adresse pour la recevoir chaque jour.<br>${SCHEDULE}</p>
${button(confirmUrl, 'Confirmer mon abonnement')}`),
  ];
  return {
    subject: 'Confirme ton abonnement à la blague plate du jour',
    html: layout({
      baseUrl,
      preheader: 'Un clic et tu reçois une blague plate chaque jour.',
      eyebrow: 'Confirmation',
      rows,
      footer: `Si tu n’as rien demandé, ignore simplement cet e-mail : tu ne recevras rien.<br>
Le lien ne marche pas ? Copie cette adresse dans ton navigateur :<br><span style="word-break:break-all;">${escapeHtml(confirmUrl)}</span>`,
    }),
    text: `Une blague plate par jour ?\n\nConfirme ton abonnement :\n${confirmUrl}\n\n${SCHEDULE}\n\nSi tu n’as rien demandé, ignore cet e-mail.`,
  };
}

module.exports = { dailyEmail, welcomeEmail, confirmEmail, escapeHtml, splitJoke };
