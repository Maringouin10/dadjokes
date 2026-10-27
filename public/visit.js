// Counts a visit once per browser session, only after a real human gesture and a small
// proof-of-work (invisible captcha): bots that just load the page are never counted.
(() => {
  'use strict';
  if (navigator.webdriver || !window.crypto?.subtle) return;
  try { if (sessionStorage.getItem('visit')) return; } catch { /* storage blocked */ }

  const gestures = ['pointerdown', 'pointermove', 'touchstart', 'keydown', 'wheel', 'scroll'];
  let started = false;

  async function solve(token, zeros) {
    const prefix = '0'.repeat(zeros);
    const encoder = new TextEncoder();
    for (let nonce = 0; ; nonce++) {
      const hash = await crypto.subtle.digest('SHA-256', encoder.encode(`${token}:${nonce}`));
      const hex = Array.from(new Uint8Array(hash.slice(0, 4)), (b) => b.toString(16).padStart(2, '0')).join('');
      if (hex.startsWith(prefix)) return String(nonce);
      if (nonce % 2000 === 1999) await new Promise((r) => setTimeout(r, 0));
    }
  }

  async function count() {
    try {
      const res = await fetch('/api/visit/challenge', { cache: 'no-store' });
      if (!res.ok) return;
      const { token, zeros } = await res.json();
      const nonce = await solve(token, zeros);
      const sent = await fetch('/api/visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, nonce, human: true, ref: document.referrer }),
      });
      if (sent.ok) {
        try { sessionStorage.setItem('visit', '1'); } catch { /* storage blocked */ }
      }
    } catch { /* stats are best effort */ }
  }

  function onGesture(event) {
    if (!event.isTrusted || started) return;
    started = true;
    for (const name of gestures) window.removeEventListener(name, onGesture, true);
    count();
  }
  for (const name of gestures) window.addEventListener(name, onGesture, { capture: true, passive: true });
})();
