'use strict';

// Themes of the jokes, decided by plain keyword rules (no AI). A joke can have up to 3 themes.
// A theme page only exists (and is only indexed) once it holds MIN_JOKES jokes: no thin pages.

const MIN_JOKES = 5;

const words = (list) => new RegExp(`(?<!\\p{L})(?:${list.join('|')})(?!\\p{L})`, 'iu');

const THEMES = [
  { slug: 'animaux', name: 'Blagues d’animaux', intro: 'Chats, chiens, vaches, canards et tous leurs amis : les blagues plates sur les animaux.',
    re: words(['chat\\p{L}*', 'chien\\p{L}*', 'vaches?', 'poules?', 'poulets?', 'chevaux', 'cheval', 'canards?', 'poissons?', 'oiseaux?', 'lapins?', 'cochons?', 'moutons?', 'animaux', 'animal', 'souris', 'éléphants?', 'girafes?', 'serpents?', 'grenouilles?', 'abeilles?', 'insectes?', 'singes?', 'ours', 'loups?', 'renards?', 'escargots?', 'pingouins?', 'dauphins?', 'requins?', 'baleines?', 'fourmis', 'mouches?', 'araignées?', 'lions?', 'tigres?', 'zèbres?', 'hiboux', 'perroquets?', 'crocodiles?', 'taureaux?', 'bœufs?', 'boeufs?', 'chèvres?', 'ânes?', 'papillons?', 'mouton\\p{L}*']) },
  { slug: 'ecole', name: 'Blagues d’école', intro: 'Profs, élèves, devoirs et récré : les blagues plates qui sentent la craie.',
    re: words(['écoles?', 'classes?', 'profs?', 'professeurs?', 'élèves?', 'devoirs?', 'cahiers?', 'crayons?', 'maths?', 'mathématiques?', 'bulletins?', 'récré\\p{L}*', 'étudiants?', 'universités?', 'maîtresses?', 'instituteurs?', 'tableaux?', 'leçons?', 'examens?', 'notes?']) },
  { slug: 'nourriture', name: 'Blagues de nourriture', intro: 'Fruits, légumes, fromages et desserts : des blagues plates à croquer.',
    re: words(['pizzas?', 'fromages?', 'pommes?', 'bananes?', 'fraises?', 'citrons?', 'oignons?', 'tomates?', 'gâteaux?', 'soupes?', 'pains?', 'cafés?', 'œufs?', 'oeufs?', 'frites?', 'légumes?', 'fruits?', 'chocolats?', 'bonbons?', 'glaces?', 'salades?', 'carottes?', 'sandwichs?', 'pâtes?', 'restaurants?', 'cuisin\\p{L}*', 'manger', 'mange\\p{L}*', 'repas', 'poires?', 'cerises?', 'champignons?', 'patates?', 'biscuits?', 'beurre', 'lait', 'sucre', 'sel', 'poivre', 'tartes?']) },
  { slug: 'metiers', name: 'Blagues de métiers', intro: 'Électriciens, boulangers, pompiers… et leurs fameux combles : les blagues plates du travail.',
    re: words(['combles?', 'électriciens?', 'boulangers?', 'jardiniers?', 'pompiers?', 'facteurs?', 'médecins?', 'dentistes?', 'policiers?', 'bouchers?', 'coiffeurs?', 'pilotes?', 'plombiers?', 'menuisiers?', 'travail\\p{L}*', 'patrons?', 'bureau', 'employés?', 'métiers?', 'avocats?', 'cuisiniers?', 'mécaniciens?', 'agriculteurs?', 'maçons?', 'peintres?']) },
  { slug: 'informatique', name: 'Blagues d’informatique', intro: 'Ordinateurs, internet et téléphones : les blagues plates pour les accros à l’écran.',
    re: words(['ordinateurs?', 'internet', 'wifi', 'wi-fi', 'téléphones?', 'portables?', 'claviers?', 'applications?', 'logiciels?', 'robots?', 'écrans?', 'clics?', 'bugs?', 'programm\\p{L}*', 'informatiques?', 'web', 'net', 'sites?', 'courriels?', 'e-?mails?', 'pirates?', 'données', 'fichiers?', 'mot de passe', 'connect\\p{L}*', 'jeux? vidéos?']) },
  { slug: 'sport-loisirs', name: 'Blagues de sport et de loisirs', intro: 'Hockey, natation, musique et jeux : les blagues plates qui bougent.',
    re: words(['football', 'foot', 'hockey', 'tennis', 'sports?', 'sportifs?', 'basket\\p{L}*', 'nage\\p{L}*', 'plong\\p{L}*', 'ski\\p{L}*', 'vélos?', 'golf', 'jeux?', 'musique', 'chansons?', 'guitares?', 'pianos?', 'chant\\p{L}*', 'danse\\p{L}*', 'cinéma', 'films?', 'ballons?', 'équipes?', 'courir', 'course', 'pêche', 'livres?']) },
  { slug: 'sante', name: 'Blagues de docteur et de santé', intro: 'Chez le docteur, à l’hôpital ou à la pharmacie : des blagues plates qui font du bien.',
    re: words(['docteurs?', 'médecins?', 'hôpital', 'malades?', 'dentistes?', 'infirmi\\p{L}*', 'pharmac\\p{L}*', 'santé', 'rhume', 'toux', 'fièvre', 'médicaments?', 'patients?', 'mal', 'dents?', 'yeux', 'œil', 'oeil', 'dos', 'ventre', 'tête']) },
  { slug: 'nature', name: 'Blagues de nature et de météo', intro: 'Soleil, pluie, neige, mer et forêt : les blagues plates au grand air.',
    re: words(['arbres?', 'fleurs?', 'soleil', 'pluie', 'pleut', 'neige', 'lune', 'étoiles?', 'mer', 'plage', 'montagnes?', 'nuages?', 'forêt', 'vent', 'jardin', 'rivière', 'lac', 'océan', 'ciel', 'orage', 'tempête', 'froid', 'chaud', 'hiver', 'été', 'printemps', 'automne', 'feuilles?', 'herbe', 'terre']) },
  { slug: 'noel', name: 'Blagues de Noël', intro: 'Père Noël, sapin et cadeaux : les blagues plates qui sentent le sapin.',
    re: words(['noël', 'noel', 'sapins?', 'cadeaux?', 'lutins?', 'rennes?', 'réveillon', 'bûche', 'guirlandes?', 'pâques', 'halloween', 'citrouilles?']) },
  { slug: 'voyage-transports', name: 'Blagues de voyage et de transports', intro: 'Avions, trains, voitures et vacances : les blagues plates qui prennent la route.',
    re: words(['avions?', 'trains?', 'voitures?', 'bus', 'autobus', 'bateaux?', 'routes?', 'taxis?', 'aéroports?', 'voyag\\p{L}*', 'vacances', 'hôtels?', 'camions?', 'motos?', 'gares?', 'valises?', 'pays', 'villes?', 'france', 'québec', 'canada', 'paris', 'montréal']) },
  { slug: 'maison', name: 'Blagues de maison', intro: 'Chaises, portes, frigos et lits : les blagues plates qui traînent à la maison.',
    re: words(['maisons?', 'lits?', 'chaises?', 'portes?', 'fenêtres?', 'tables?', 'frigos?', 'lampes?', 'miroirs?', 'canapés?', 'toits?', 'murs?', 'chambres?', 'salon', 'salle de bain', 'douche', 'baignoire', 'balai', 'aspirateur', 'horloge', 'clés?', 'serrure', 'tapis', 'télé', 'télévision']) },
  { slug: 'toc-toc', name: 'Blagues « Toc toc »', intro: 'Toc toc ! Qui est là ? Les blagues plates qui frappent à la porte.',
    re: /toc,?\s*toc/iu },
  { slug: 'courtes', name: 'Blagues courtes', intro: 'Une question, une chute : les blagues plates les plus courtes, parfaites à raconter vite.',
    test: (text) => text.replace(/\s+/g, ' ').length <= 70 },
];

const BY_SLUG = new Map(THEMES.map((t) => [t.slug, t]));

// Up to 3 keyword themes for a joke text, in the order of the list above, plus « courtes » when it is short
// (length is a fact, not a topic: it does not use one of the 3 slots).
function themesOf(text) {
  const out = [];
  for (const theme of THEMES) {
    if (theme.test || out.length >= 3) continue;
    if (theme.re.test(text)) out.push(theme.slug);
  }
  for (const theme of THEMES) if (theme.test && theme.test(text)) out.push(theme.slug);
  return out;
}

module.exports = { THEMES, BY_SLUG, MIN_JOKES, themesOf };
