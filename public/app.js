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
    els.source.append(' · Nouvelle blague à midi en semaine, à minuit le week-end (heure de New York)');
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
      revealFromLink();
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
    // Fetch the new joke a couple of seconds after the change (noon on weekdays, midnight on weekends).
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

  // Links from the daily e-mail ("Retourner la carte") open the site with ?reveal=1: flip once.
  let revealPending = new URLSearchParams(location.search).has('reveal');
  function revealFromLink() {
    if (!revealPending) return;
    revealPending = false;
    const url = new URL(location.href);
    url.searchParams.delete('reveal');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    setTimeout(() => { if (!flipped) turn(1); }, 700);
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
    toastTimer = setTimeout(() => { els.toast.textContent = ''; }, 2500 + message.length * 40);
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

  // ---------- Push notifications ----------

  const pushButton = $('push');
  const isIos = /iP(hone|ad|od)/.test(navigator.platform)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let config = null;

  function urlBase64ToUint8Array(base64) {
    const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  }

  function setPushState(on) {
    pushButton.setAttribute('aria-pressed', String(on));
    pushButton.textContent = on ? 'Notifications ✓' : 'Notifications';
  }

  // Filled in at load time, so a click can ask for permission straight away:
  // Safari and Firefox ignore the request if anything is awaited before it.
  let pushSub = null;

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function togglePush() {
    if (!window.isSecureContext) {
      toast('Les notifications demandent une connexion sécurisée (HTTPS).');
      return;
    }
    if (!pushSupported) {
      toast(isIos && !isStandalone
        ? 'Sur iPhone : Partager → « Sur l’écran d’accueil », puis ouvre l’appli pour activer les notifications.'
        : 'Ce navigateur ne gère pas les notifications.');
      return;
    }
    pushButton.disabled = true;
    try {
      if (pushSub) {
        const old = pushSub;
        pushSub = null;
        setPushState(false);
        await postJson('/api/push/unsubscribe', { endpoint: old.endpoint }).catch(() => {});
        await old.unsubscribe().catch(() => {});
        toast('Notifications désactivées');
        return;
      }
      const permission = await Notification.requestPermission(); // first await: still inside the click
      if (permission !== 'granted') {
        toast('Notifications refusées. Tu peux les autoriser dans les réglages du navigateur.');
        return;
      }
      if (!config) throw new Error('config not loaded');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.pushPublicKey),
      });
      await postJson('/api/push/subscribe', { subscription: sub.toJSON() });
      pushSub = sub;
      setPushState(true);
      toast('Notifications activées');
    } catch (err) {
      console.error(err);
      toast(Notification.permission === 'denied'
        ? 'Notifications bloquées. Autorise-les dans les réglages du navigateur.'
        : `Impossible d’activer les notifications : ${err.message}`);
    } finally {
      pushButton.disabled = false;
    }
  }

  pushButton.addEventListener('click', togglePush);

  // ---------- E-mail ----------

  const emailButton = $('email');
  const dialog = $('email-dialog');
  const form = $('email-form');
  const input = $('email-input');
  const status = $('email-status');
  const submit = $('email-submit');

  function setStatus(text, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  emailButton.addEventListener('click', () => {
    setStatus('');
    submit.hidden = false;
    input.disabled = false;
    $('email-cancel').textContent = 'Annuler';
    dialog.showModal();
  });
  $('email-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // tap outside

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.checkValidity()) { setStatus('Entre une adresse e-mail valide.', true); return; }
    submit.disabled = true;
    setStatus('Envoi…');
    try {
      await postJson('/api/email/subscribe', { email: input.value });
      setStatus('C’est presque fini : clique sur le lien reçu par e-mail pour confirmer.');
      submit.hidden = true;
      input.disabled = true;
      $('email-cancel').textContent = 'Fermer';
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  async function setupSubscriptions() {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      config = await res.json();
    } catch { return; }
    emailButton.hidden = !config.email;
    // Shown where push works, or with an explanation where it could (HTTPS, iPhone home screen).
    pushButton.hidden = !(pushSupported || (isIos && !isStandalone) || !window.isSecureContext);
    if (pushSupported && window.isSecureContext) {
      navigator.serviceWorker.ready
        .then((reg) => reg.pushManager.getSubscription())
        .then((sub) => {
          pushSub = sub;
          setPushState(Boolean(sub));
          // Keep the server in sync (e.g. after its data volume was reset).
          if (sub) postJson('/api/push/subscribe', { subscription: sub.toJSON() }).catch(() => {});
        })
        .catch(() => {});
    }
  }

  // Coming back to the app after a while: make sure the joke is still today's.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && current
        && Date.now() >= new Date(current.nextChangeAt).getTime()) load();
  });

  // No caching anywhere: remove what older versions of the site stored.
  if ('caches' in window) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  load();
  setupSubscriptions();
})();
