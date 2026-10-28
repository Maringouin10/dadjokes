'use strict';

// Every setting of the site, read from the environment (.env next to docker-compose.yml).
// See .env.example for the full list with their default values.

const env = (name, fallback = '') => {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
};
const num = (name, fallback, min = -Infinity, max = Infinity) => {
  const value = Number(env(name, String(fallback)));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
};
const list = (name, fallback) => env(name, fallback).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const PUBLIC_URL = env('PUBLIC_URL').replace(/\/+$/, '');
const SITE_URL = PUBLIC_URL || 'https://blaguedujour.lol';

module.exports = {
  PUBLIC_URL,
  SITE_URL,
  SITE_NAME: env('SITE_NAME', 'La blague plate du jour'),

  // Joke schedule
  TIME_ZONE: env('TIME_ZONE', 'America/New_York'),
  CHANGE_HOUR: num('CHANGE_HOUR', 12, 0, 23),
  HISTORY_DAYS: num('HISTORY_DAYS', 7, 1, 60),
  SCHEDULE_TEXT: env('SCHEDULE_TEXT', 'chaque jour à midi (heure de New York)'),

  // Admin
  ADMIN_PASSWORD: env('ADMIN_PASSWORD'),
  ADMIN_SESSION_DAYS: num('ADMIN_SESSION_DAYS', 7, 1, 365),

  // Visits counted as human: opened from the QR code, from the installed app (PWA),
  // or coming from one of these search engines (domains containing these words).
  HUMAN_REFERRERS: list('HUMAN_REFERRERS', 'google'),
  STATS_DAYS: num('STATS_DAYS', 30, 7, 365),

  // QR code (admin, labels, posters). "?qr" marks visits that come from a scan.
  QR_URL: env('QR_URL', `${SITE_URL}/?qr`),
  QR_TEXT: env('QR_TEXT', SITE_URL.replace(/^https?:\/\//, '')),

  // Thermal label (inches) and its texts
  LABEL_WIDTH_IN: num('LABEL_WIDTH_IN', 3, 1, 8),
  LABEL_HEIGHT_IN: num('LABEL_HEIGHT_IN', 1, 0.5, 8),
  LABEL_TITLE: env('LABEL_TITLE', 'La blague plate du jour'),
  LABEL_TEXT: env('LABEL_TEXT', 'Scanne-moi : une nouvelle blague plate chaque jour à midi !'),

  // Poster: same block 4 times on one sheet (LETTER or A4)
  POSTER_PAGE: env('POSTER_PAGE', 'LETTER').toUpperCase() === 'A4' ? 'A4' : 'LETTER',
  POSTER_TITLE: env('POSTER_TITLE', 'La blague plate du jour'),
  POSTER_TEXT: env('POSTER_TEXT', 'Scanne le code : une nouvelle blague plate chaque jour à midi. Promis, elle est nulle.'),

  // /ads: label requests from the people who stick them around
  ADS_MAX_LABELS: num('ADS_MAX_LABELS', 200, 1, 10000),
  ADS_TITLE: env('ADS_TITLE', 'Plus d’étiquettes ?'),
  ADS_TEXT: env('ADS_TEXT', 'Tu colles des étiquettes de la blague du jour et tu n’en as plus ? Dis combien il t’en faut et ton numéro de casier : on te les dépose.'),
};
