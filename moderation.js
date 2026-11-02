'use strict';

// Second check on each new joke, after the word filter: a Groq-hosted model says whether it could
// offend (the site is seen by students). Without GROQ_API_KEY, it is off.
const config = require('./config');

const PROMPT = `Tu vérifies des blagues avant qu’elles soient affichées sur un site grand public, lu aussi par des élèves
du secondaire au Québec. Refuse la blague si elle peut raisonnablement offenser ou mettre mal à l’aise :
- contenu sexuel, sous-entendus, vulgarité ou grossièretés;
- moquerie ou stéréotype visant un groupe : origine, nationalité, couleur de peau, religion, sexe ou genre,
  orientation sexuelle, handicap, maladie, apparence ou poids, âge, classe sociale, blondes, etc.;
- violence, mort, suicide, maltraitance, drogue, alcool, armes, terrorisme;
- politique ou sujets d’actualité délicats;
- humiliation d’une personne réelle.
Accepte les jeux de mots et l’humour absurde inoffensifs, même très « plats ».
Réponds seulement en JSON : {"ok": true} ou {"ok": false, "raison": "explication courte"}.`;

const enabled = () => Boolean(config.GROQ_API_KEY);

// Returns { ok: true } / { ok: false, reason } / { ok: null, error } when Groq could not answer.
async function moderate(text) {
  if (!enabled()) return { ok: true, skipped: true };
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.GROQ_MODEL,
        temperature: 0,
        max_tokens: 120,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: `Blague :\n"""\n${text}\n"""` },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    const answer = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    if (typeof answer.ok !== 'boolean') throw new Error('réponse illisible');
    return answer.ok ? { ok: true } : { ok: false, reason: String(answer.raison || answer.reason || '').slice(0, 200) };
  } catch (err) {
    return { ok: null, error: err.message };
  }
}

// Startup report line.
async function diagnose() {
  if (!enabled()) return '⚠️  Groq désactivé (GROQ_API_KEY vide) : seules les blagues filtrées par mots-clés';
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${config.GROQ_API_KEY}` }, signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) return '❌ Groq refuse la clé (GROQ_API_KEY invalide)';
    if (!res.ok) return `❌ Groq répond ${res.status}`;
    const { data = [] } = await res.json();
    return data.some((m) => m.id === config.GROQ_MODEL)
      ? `✅ Groq : vérification des blagues avec ${config.GROQ_MODEL}`
      : `❌ Groq : le modèle ${config.GROQ_MODEL} n’existe pas (voir console.groq.com/docs/models)`;
  } catch (err) {
    return `❌ Impossible de joindre Groq : ${err.message}`;
  }
}

module.exports = { enabled, moderate, diagnose };
