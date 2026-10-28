'use strict';

// Every setting of the site. A value saved from /admin (data/settings.json) wins over the
// environment (.env), which wins over the default. Read settings at use time (config.X), never
// copy them into constants, so a change made in /admin applies at once.

const fs = require('node:fs');
const path = require('node:path');

const validUrl = (v) => /^https?:\/\/[^\s/]+/.test(v) || 'doit commencer par https://';
const validTimeZone = (v) => {
  try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return 'fuseau inconnu (ex. America/Toronto)'; }
};

// type: text, textarea, number, secret, select. restart: only applied after a restart.
const SETTINGS = [
  { group: 'Site', key: 'PUBLIC_URL', label: 'Adresse publique du site', type: 'text', def: '', help: 'En https. Utilisée par les e-mails, le push et le code QR.', validate: (v) => !v || validUrl(v) },
  { group: 'Site', key: 'SITE_NAME', label: 'Nom du site', type: 'text', def: 'La blague plate du jour' },

  { group: 'Blagues', key: 'BLAGUES_API_TOKEN', label: 'Clé Blagues API', type: 'secret', def: '', help: 'Meilleures blagues : clé gratuite sur blagues-api.fr' },
  { group: 'Blagues', key: 'TIME_ZONE', label: 'Fuseau horaire', type: 'text', def: 'America/New_York', validate: validTimeZone },
  { group: 'Blagues', key: 'CHANGE_HOUR', label: 'Heure du changement de blague (0-23)', type: 'number', def: 12, min: 0, max: 23 },
  { group: 'Blagues', key: 'HISTORY_DAYS', label: 'Jours d’historique', type: 'number', def: 7, min: 1, max: 60 },
  { group: 'Blagues', key: 'SCHEDULE_TEXT', label: 'Texte de l’horaire', type: 'text', def: 'chaque jour à midi (heure de New York)', help: 'Affiché « Nouvelle blague <texte> » sur le site et dans les e-mails.' },

  { group: 'Admin et statistiques', key: 'ADMIN_PASSWORD', label: 'Mot de passe admin', type: 'secret', def: '', help: 'Le changer te déconnecte. 10 caractères minimum.', validate: (v) => v.length >= 10 || '10 caractères minimum' },
  { group: 'Admin et statistiques', key: 'ADMIN_SESSION_DAYS', label: 'Durée de connexion (jours)', type: 'number', def: 7, min: 1, max: 365 },
  { group: 'Admin et statistiques', key: 'STATS_DAYS', label: 'Jours affichés dans les stats', type: 'number', def: 30, min: 7, max: 365 },
  { group: 'Admin et statistiques', key: 'HUMAN_REFERRERS', label: 'Moteurs de recherche comptés comme humains', type: 'text', def: 'google', help: 'Séparés par des virgules (ex. google,bing,duckduckgo). Le code QR et l’app comptent toujours.' },

  { group: 'Code QR, étiquettes et affiches', key: 'QR_URL', label: 'Adresse du code QR', type: 'text', def: '', help: 'Vide = adresse du site + /?qr (le ?qr compte les scans).', validate: (v) => !v || validUrl(v) },
  { group: 'Code QR, étiquettes et affiches', key: 'QR_TEXT', label: 'Adresse écrite sous le code', type: 'text', def: '', help: 'Vide = adresse du site sans https://' },
  { group: 'Code QR, étiquettes et affiches', key: 'LABEL_WIDTH_IN', label: 'Largeur de l’étiquette (po)', type: 'number', def: 3, min: 1, max: 8, step: 0.05 },
  { group: 'Code QR, étiquettes et affiches', key: 'LABEL_HEIGHT_IN', label: 'Hauteur de l’étiquette (po)', type: 'number', def: 1, min: 0.5, max: 8, step: 0.05 },
  { group: 'Code QR, étiquettes et affiches', key: 'LABEL_TITLE', label: 'Titre de l’étiquette', type: 'text', def: 'La blague plate du jour' },
  { group: 'Code QR, étiquettes et affiches', key: 'LABEL_TEXT', label: 'Texte de l’étiquette', type: 'textarea', def: 'Scanne-moi : une nouvelle blague plate chaque jour à midi !' },
  { group: 'Code QR, étiquettes et affiches', key: 'POSTER_PAGE', label: 'Format de l’affiche', type: 'select', def: 'LETTER', options: { LETTER: 'Lettre (8,5 × 11 po)', A4: 'A4' } },
  { group: 'Code QR, étiquettes et affiches', key: 'POSTER_TITLE', label: 'Titre de l’affiche', type: 'text', def: 'La blague plate du jour' },
  { group: 'Code QR, étiquettes et affiches', key: 'POSTER_TEXT', label: 'Texte de l’affiche', type: 'textarea', def: 'Scanne le code : une nouvelle blague plate chaque jour à midi. Promis, elle est nulle.' },

  { group: 'Demandes d’étiquettes (/ads)', key: 'ADS_MAX_LABELS', label: 'Maximum d’étiquettes par demande', type: 'number', def: 200, min: 1, max: 10000 },
  { group: 'Demandes d’étiquettes (/ads)', key: 'ADS_TITLE', label: 'Titre de la page', type: 'text', def: 'Plus d’étiquettes ?' },
  { group: 'Demandes d’étiquettes (/ads)', key: 'ADS_TEXT', label: 'Texte de la page', type: 'textarea', def: 'Tu colles des étiquettes de la blague du jour et tu n’en as plus ? Dis combien il t’en faut et ton numéro de casier : on te les dépose.' },

  { group: 'E-mails (Resend)', key: 'RESEND_API_KEY', label: 'Clé API Resend', type: 'secret', def: '', help: 'Commence par re_' },
  { group: 'E-mails (Resend)', key: 'EMAIL_FROM', label: 'Expéditeur', type: 'text', def: '', help: 'Ex. La blague plate du jour <blague@blaguedujour.lol>' },

  { group: 'Notifications push', key: 'VAPID_SUBJECT', label: 'Ton adresse e-mail (contact push)', type: 'text', def: '' },
  { group: 'Notifications push', key: 'VAPID_PUBLIC_KEY', label: 'Clé VAPID publique', type: 'text', def: '', restart: true, help: 'Facultatif (sinon générée). La changer coupe les abonnés push actuels.' },
  { group: 'Notifications push', key: 'VAPID_PRIVATE_KEY', label: 'Clé VAPID privée', type: 'secret', def: '', restart: true },
];

const BY_KEY = Object.fromEntries(SETTINGS.map((s) => [s.key, s]));
let overrides = {};
let file = null;
const listeners = [];

function envValue(key) {
  let value = process.env[key];
  if (key === 'RESEND_API_KEY' && !value) value = process.env.RESEND_API; // common typo
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

// Value from .env or the default: what a setting falls back to without an admin override.
function baseValue(key) {
  const env = envValue(key);
  return env === undefined ? String(BY_KEY[key].def) : env;
}

function raw(key) {
  return key in overrides ? overrides[key] : baseValue(key);
}

function parse(setting, value) {
  if (setting.type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(setting.max, Math.max(setting.min, n)) : setting.def;
  }
  if (setting.type === 'select') return value.toUpperCase() in setting.options ? value.toUpperCase() : setting.def;
  return value;
}

const config = {
  SETTINGS,

  load(dataDir) {
    file = path.join(dataDir, 'settings.json');
    try {
      overrides = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      overrides = {};
    }
    for (const key of Object.keys(overrides)) if (!BY_KEY[key]) delete overrides[key];
  },

  // Where the current value comes from: 'admin', 'env' or 'default'.
  source(key) {
    if (key in overrides) return 'admin';
    return envValue(key) === undefined ? 'default' : 'env';
  },
  raw,
  baseValue,

  // changes: { KEY: value } to set, { KEY: null } to go back to .env / default.
  // Returns a list of errors; nothing is saved when there is one.
  update(changes) {
    const errors = [];
    const next = { ...overrides };
    for (const [key, value] of Object.entries(changes)) {
      const setting = BY_KEY[key];
      if (!setting) continue;
      if (value === null || String(value).trim() === baseValue(key)) {
        delete next[key];
        continue;
      }
      const clean = String(value).trim();
      const check = setting.validate ? setting.validate(clean) : true;
      if (check !== true) errors.push(`${setting.label} : ${check}`);
      else next[key] = setting.type === 'number' || setting.type === 'select' ? String(parse(setting, clean)) : clean;
    }
    const password = 'ADMIN_PASSWORD' in next ? next.ADMIN_PASSWORD : baseValue('ADMIN_PASSWORD');
    if (!password) errors.push('Mot de passe admin : il ne peut pas être vide (tu serais bloqué dehors)');
    if (errors.length) return errors;
    const changed = SETTINGS.filter((s) => raw(s.key) !== (s.key in next ? next[s.key] : baseValue(s.key))).map((s) => s.key);
    overrides = next;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(overrides, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    if (changed.length) for (const fn of listeners) fn(changed);
    return [];
  },

  onChange(fn) {
    listeners.push(fn);
  },

  // ---------- Derived values ----------
  get SITE_URL() {
    return config.PUBLIC_URL || 'https://blaguedujour.lol';
  },
};

for (const setting of SETTINGS) {
  Object.defineProperty(config, setting.key, {
    enumerable: true,
    get() {
      const value = parse(setting, raw(setting.key));
      if (setting.key === 'PUBLIC_URL') return value.replace(/\/+$/, '');
      if (setting.key === 'QR_URL') return value || `${config.SITE_URL}/?qr`;
      if (setting.key === 'QR_TEXT') return value || config.SITE_URL.replace(/^https?:\/\//, '');
      if (setting.key === 'HUMAN_REFERRERS') return value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      return value;
    },
  });
}

module.exports = config;
