(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    card: $('card'), joke: $('joke'), date: $('date'),
    next: $('next'), source: $('source'), share: $('share'),
  };
  let current = null;
  let refreshTimer = null;
  let countdownTimer = null;

  function formatDate(isoDay) {
    const [y, m, d] = isoDay.split('-').map(Number);
    return new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, d)));
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
    if (m > 0) return `${m} min`;
    return 'moins d’une minute';
  }

  function renderSource(data) {
    els.source.textContent = 'Source : ';
    if (data.sourceUrl) {
      const a = document.createElement('a');
      a.href = data.sourceUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = data.source;
      els.source.append(a);
    } else {
      els.source.append(data.source);
    }
    els.source.append(' · Nouvelle blague à minuit, heure de New York');
  }

  function render(data) {
    current = data;
    els.card.setAttribute('aria-busy', 'false');
    els.joke.textContent = data.joke;
    els.date.textContent = formatDate(data.date);
    renderSource(data);
    els.share.hidden = false;
    scheduleRefresh(new Date(data.nextChangeAt).getTime());
  }

  function updateCountdown(at) {
    els.next.textContent = `Prochaine blague dans ${formatCountdown(at - Date.now())}`;
  }

  function scheduleRefresh(at) {
    clearTimeout(refreshTimer);
    clearInterval(countdownTimer);
    updateCountdown(at);
    countdownTimer = setInterval(() => updateCountdown(at), 30 * 1000);
    // Fetch the new joke a couple of seconds after midnight New York time.
    refreshTimer = setTimeout(load, Math.max(1000, at - Date.now() + 2000));
  }

  async function load() {
    try {
      const res = await fetch('/api/joke', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      render(await res.json());
    } catch (err) {
      if (!current) {
        els.card.setAttribute('aria-busy', 'false');
        els.joke.innerHTML = '<span class="placeholder">Impossible de charger la blague du jour. Vérifie ta connexion.</span>';
      }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(load, 60 * 1000);
    }
  }

  els.share.addEventListener('click', async () => {
    if (!current) return;
    const text = `${current.joke}\n\n— La blague plate du jour`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'La blague plate du jour', text, url: location.origin });
      } else {
        await navigator.clipboard.writeText(`${text}\n${location.origin}`);
        els.share.textContent = 'Copié';
        setTimeout(() => { els.share.textContent = 'Partager'; }, 1600);
      }
    } catch { /* user cancelled */ }
  });

  // Coming back to the app after a while: make sure the joke is still today's.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && current
        && Date.now() >= new Date(current.nextChangeAt).getTime()) load();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  load();
})();
