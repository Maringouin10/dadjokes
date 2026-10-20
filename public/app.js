(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    card: $('card'), joke: $('joke'), date: $('date'),
    next: $('next'), source: $('source'), share: $('share'), toast: $('toast'),
    flip: $('flip'), flipInner: $('flip-inner'), setup: $('setup'), punchline: $('punchline'),
    front: $('front'), back: $('back'),
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
    if (data.punchline) {
      els.setup.textContent = data.setup;
      els.punchline.textContent = data.punchline;
      els.card.hidden = true;
      els.flip.hidden = false;
      resetCard();
    } else {
      els.joke.textContent = data.joke;
      els.card.hidden = false;
      els.flip.hidden = true;
    }
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

  // ---------- Flip card: swipe, tap or keyboard ----------

  // Continuous angle: each flip adds or removes 180°, so the card always turns the way it was pushed.
  let angle = 0;
  let flipped = false;
  let lastSwipe = 0;

  function applyAngle() {
    flipped = Math.abs(angle / 180) % 2 === 1;
    els.flipInner.style.transform = `rotateY(${angle}deg)`;
    els.flip.setAttribute('aria-pressed', String(flipped));
    els.flip.setAttribute('aria-label', flipped
      ? 'Réponse affichée. Retourner la carte pour revoir la question'
      : 'Retourner la carte pour voir la réponse');
    els.front.setAttribute('aria-hidden', String(flipped));
    els.back.setAttribute('aria-hidden', String(!flipped));
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let running = null;

  function stopAnimation() {
    if (!running) return;
    running.cancel();
    running = null;
    els.flip.classList.remove('is-animating');
  }

  // `from` is where the card is now: its resting angle, or wherever a swipe left it.
  function turn(direction, from = angle) {
    stopAnimation();
    const animate = !reducedMotion.matches && window.FlipAnimations;
    if (animate) els.flip.classList.add('is-animating');
    angle += direction < 0 ? -180 : 180;
    applyAngle();
    if (!animate) return;
    const { anim } = window.FlipAnimations.play(els.flipInner, from, angle, { particles: flipped });
    running = anim;
    anim.finished.then(() => { if (running === anim) stopAnimation(); }, () => {});
  }

  function resetCard() {
    stopAnimation();
    angle = 0;
    applyAngle();
  }

  let drag = null;

  els.flip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    stopAnimation();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, dx: 0, active: false };
  });

  els.flip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
      drag.active = true;
      els.flip.setPointerCapture(e.pointerId);
      els.flip.classList.add('is-dragging');
    }
    drag.dx = dx;
    drag.live = angle + Math.max(-180, Math.min(180, dx * 0.6));
    const live = angle + Math.max(-180, Math.min(180, dx * 0.6));
    els.flipInner.style.transform = `rotateY(${live}deg)`;
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { active, dx, t, live } = drag;
    drag = null;
    els.flip.classList.remove('is-dragging');
    if (!active) return; // a plain tap is handled by the click event
    lastSwipe = Date.now();
    const speed = Math.abs(dx) / Math.max(1, e.timeStamp - t);
    if (Math.abs(dx) > 70 || (Math.abs(dx) > 30 && speed > 0.5)) turn(dx, live);
    else applyAngle(); // not far enough: snap back
  }

  els.flip.addEventListener('pointerup', endDrag);
  els.flip.addEventListener('pointercancel', endDrag);

  els.flip.addEventListener('click', () => {
    if (Date.now() - lastSwipe < 400) return; // the click that ends a swipe
    turn(1);
  });

  els.flip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); turn(1); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      turn(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  // ---------- Share ----------

  let toastTimer = null;
  function toast(message) {
    els.toast.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.textContent = ''; }, 2500);
  }

  // navigator.clipboard only exists on HTTPS/localhost; this works on plain HTTP too.
  function legacyCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }

  async function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    }
    return legacyCopy(text);
  }

  els.share.addEventListener('click', async () => {
    if (!current) return;
    const body = current.punchline ? `${current.setup}\n… ${current.punchline}` : current.joke;
    const text = `${body}\n\n— La blague plate du jour`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'La blague plate du jour', text, url: location.origin });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user closed the share sheet
      }
    }
    toast(await copy(`${text}\n${location.origin}`)
      ? 'Blague copiée dans le presse-papier'
      : 'Impossible de copier la blague');
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
