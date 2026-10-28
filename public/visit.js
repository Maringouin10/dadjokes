// Counts one visit per browser session. The server only counts it as human when it comes
// from the QR code (?qr), from the installed app (PWA) or from a search engine.
(() => {
  'use strict';
  if (navigator.webdriver) return;
  try { if (sessionStorage.getItem('visit')) return; } catch { /* storage blocked */ }

  const url = new URL(location.href);
  const qr = url.searchParams.has('qr');
  if (qr) {
    url.searchParams.delete('qr'); // shared links must not count as scans
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
  const pwa = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  fetch('/api/visit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qr, pwa, ref: document.referrer }),
    keepalive: true,
  }).then((res) => {
    if (res.ok) try { sessionStorage.setItem('visit', '1'); } catch { /* storage blocked */ }
  }).catch(() => { /* stats are best effort */ });
})();
