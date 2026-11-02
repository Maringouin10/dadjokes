// Counts one visit per browser session. The server only counts it as human when it comes
// from the QR code (?qr), from the installed app (PWA) or from a search engine.
(() => {
  'use strict';
  if (navigator.webdriver) return;
  try { if (sessionStorage.getItem('visit')) return; } catch { /* storage blocked */ }

  const url = new URL(location.href);
  // ?qr = main QR code, ?qr=<name> = a QR code made for one place (a school…).
  const qr = url.searchParams.has('qr') ? (url.searchParams.get('qr') || true) : false;
  if (qr) {
    url.searchParams.delete('qr'); // shared links must not count as scans
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
  const pwa = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  // Random id kept by the installed app only, so the admin can count installs (no personal data).
  let install = null;
  if (pwa) {
    try {
      install = localStorage.getItem('install-id');
      if (!install) {
        install = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('install-id', install);
      }
    } catch { /* storage blocked */ }
  }

  fetch('/api/visit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qr, pwa, install, ref: document.referrer }),
    keepalive: true,
  }).then((res) => {
    if (res.ok) try { sessionStorage.setItem('visit', '1'); } catch { /* storage blocked */ }
  }).catch(() => { /* stats are best effort */ });
})();
