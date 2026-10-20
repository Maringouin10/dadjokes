// 20 ways to turn the card over. One is picked at random on every flip.
//
// Each animation is a list of frames. In a frame:
//   o     offset in the animation (0 → 1)
//   p     how far the card has turned from its start angle to its target (0 → 1)
//   spin  extra full turns, in the direction of the flip
//   tx    horizontal shift in px, mirrored for flips to the left
//   ty, tz, rx, rz, s, sx, sy   translate (px), rotateX / rotateZ (deg), scale
//   e     easing of the segment that starts at this frame
// p and spin carry over from the previous frame when left out; everything else defaults to rest.
// Every animation ends on p: 1 so the card lands exactly on its face.
(() => {
  'use strict';

  const SMOOTH = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
  const IN = 'cubic-bezier(0.5, 0, 0.75, 0)';
  const OUT = 'cubic-bezier(0.25, 1, 0.5, 1)';
  const IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)';

  const ANIMATIONS = [
    { name: 'Classique', duration: 550, frames: [
      { o: 0, p: 0, e: SMOOTH }, { o: 1, p: 1 },
    ] },
    { name: 'Ressort', duration: 900, frames: [
      { o: 0, p: 0, e: 'ease-in' }, { o: 0.45, p: 1.12, e: IN_OUT },
      { o: 0.7, p: 0.95, e: IN_OUT }, { o: 0.85, p: 1.03, e: IN_OUT }, { o: 1, p: 1 },
    ] },
    { name: 'Saut', duration: 750, frames: [
      { o: 0, p: 0, e: OUT }, { o: 0.45, p: 0.5, ty: -70, s: 1.04, e: IN },
      { o: 0.85, p: 1, ty: 6, sx: 1.02, sy: 0.97, e: OUT }, { o: 1, p: 1 },
    ] },
    { name: 'Double tour', duration: 950, frames: [
      { o: 0, p: 0, e: IN_OUT }, { o: 1, p: 1, spin: 1 },
    ] },
    { name: 'Toupie', duration: 1200, particles: { emojis: ['✨', '⭐'], at: 0.8 }, frames: [
      { o: 0, p: 0, e: 'cubic-bezier(0.1, 0.6, 0.2, 1)' }, { o: 1, p: 1, spin: 2 },
    ] },
    { name: 'Recul', duration: 800, frames: [
      { o: 0, p: 0, e: IN_OUT }, { o: 0.5, p: 0.5, s: 0.7, e: IN_OUT }, { o: 1, p: 1 },
    ] },
    { name: 'Zoom', duration: 700, frames: [
      { o: 0, p: 0, e: IN_OUT }, { o: 0.5, p: 0.5, s: 1.12, tz: 80, e: IN_OUT }, { o: 1, p: 1 },
    ] },
    { name: 'Vacille', duration: 1000, frames: [
      { o: 0, p: 0, e: SMOOTH }, { o: 0.45, p: 1, e: IN_OUT }, { o: 0.6, rz: -4, e: IN_OUT },
      { o: 0.75, rz: 3, e: IN_OUT }, { o: 0.88, rz: -1.5, e: IN_OUT }, { o: 1 },
    ] },
    { name: 'Chute', duration: 950, particles: { emojis: ['💥'], at: 0.5, count: 5 }, frames: [
      { o: 0, p: 0, e: IN }, { o: 0.5, p: 1, ty: 40, e: OUT }, { o: 0.7, ty: -14, e: IN },
      { o: 0.85, ty: 5, e: OUT }, { o: 1 },
    ] },
    { name: 'Bascule', duration: 750, frames: [
      { o: 0, p: 0, e: IN_OUT }, { o: 0.5, p: 0.5, rx: 30, s: 0.95, e: IN_OUT }, { o: 1, p: 1 },
    ] },
    { name: 'Suspense', duration: 1700, particles: { emojis: ['🦗'], at: 1, count: 4 }, frames: [
      { o: 0, p: 0, e: OUT }, { o: 0.3, p: 0.46, s: 1.02 }, { o: 0.75, p: 0.54, s: 1.03, e: IN }, { o: 1, p: 1 },
    ] },
    { name: 'Gelée', duration: 1000, frames: [
      { o: 0, p: 0, e: IN }, { o: 0.45, p: 1, e: OUT }, { o: 0.6, sx: 1.08, sy: 0.92, e: IN_OUT },
      { o: 0.75, sx: 0.95, sy: 1.05, e: IN_OUT }, { o: 0.88, sx: 1.02, sy: 0.98, e: IN_OUT }, { o: 1 },
    ] },
    { name: 'Balancier', duration: 1000, frames: [
      { o: 0, p: 0, e: IN_OUT }, { o: 0.25, p: 0.3, rz: 8, e: IN_OUT }, { o: 0.5, p: 0.6, rz: -8, e: IN_OUT },
      { o: 0.75, p: 0.9, rz: 4, e: IN_OUT }, { o: 1, p: 1 },
    ] },
    { name: 'Pile ou face', duration: 1300, particles: { emojis: ['🎉', '✨', '🪙'], at: 0.85 }, frames: [
      { o: 0, p: 0, e: OUT }, { o: 0.45, p: 0.6, spin: 1, ty: -160, s: 0.85, e: IN },
      { o: 0.82, p: 1, spin: 2, e: OUT }, { o: 0.91, ty: -12, e: IN }, { o: 1 },
    ] },
    { name: 'Secousse', duration: 1000, frames: [
      { o: 0, p: 0 }, { o: 0.08, tx: -10 }, { o: 0.16, tx: 10 }, { o: 0.24, tx: -8 }, { o: 0.32, tx: 6 },
      { o: 0.4, e: SMOOTH }, { o: 1, p: 1 },
    ] },
    { name: 'Hésitation', duration: 1150, frames: [
      { o: 0, p: 0, e: OUT }, { o: 0.25, p: 0.3, e: IN_OUT }, { o: 0.45, p: 0.08, e: IN_OUT }, { o: 1, p: 1 },
    ] },
    { name: 'Spirale', duration: 950, frames: [
      { o: 0, p: 0, e: IN_OUT }, { o: 0.5, p: 0.5, rz: 180, s: 0.75, e: IN_OUT }, { o: 1, p: 1, rz: 360 },
    ] },
    { name: 'Glissade', duration: 850, frames: [
      { o: 0, p: 0, e: IN_OUT }, { o: 0.5, p: 0.5, tx: 70, rz: 3, e: IN_OUT }, { o: 1, p: 1 },
    ] },
    { name: 'Battement', duration: 1050, particles: { emojis: ['😂', '🤣'], at: 0.55 }, frames: [
      { o: 0, p: 0, e: SMOOTH }, { o: 0.45, p: 1, e: OUT }, { o: 0.57, s: 1.06, e: IN_OUT },
      { o: 0.68, e: IN_OUT }, { o: 0.8, s: 1.04, e: IN_OUT }, { o: 1 },
    ] },
    { name: 'Ba-dum-tss', duration: 1150, particles: { emojis: ['🥁'], at: 0.88, count: 6 }, frames: [
      { o: 0, p: 0, e: SMOOTH }, { o: 0.45, p: 1 }, { o: 0.53, ty: 5, s: 0.98 }, { o: 0.6 },
      { o: 0.69, ty: 5, s: 0.98 }, { o: 0.76 }, { o: 0.88, s: 1.05, rz: -2, e: OUT }, { o: 1 },
    ] },
  ];

  function transform(frame, from, to, dir) {
    const ry = from + (to - from) * frame.p + dir * 360 * frame.spin;
    const sx = frame.sx ?? frame.s ?? 1;
    const sy = frame.sy ?? frame.s ?? 1;
    return `translate3d(${dir * (frame.tx ?? 0)}px, ${frame.ty ?? 0}px, ${frame.tz ?? 0}px) `
      + `rotateZ(${frame.rz ?? 0}deg) rotateX(${frame.rx ?? 0}deg) rotateY(${ry}deg) scale(${sx}, ${sy})`;
  }

  function keyframes(animation, from, to) {
    const dir = to >= from ? 1 : -1;
    let p = 0;
    let spin = 0;
    return animation.frames.map((frame) => {
      p = frame.p ?? p;
      spin = frame.spin ?? spin;
      const kf = { offset: frame.o, transform: transform({ ...frame, p, spin }, from, to, dir) };
      if (frame.e) kf.easing = frame.e;
      return kf;
    });
  }

  function burst(origin, { emojis, count = 10 }) {
    const rect = origin.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = 'particles';
    layer.setAttribute('aria-hidden', 'true');
    document.body.append(layer);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let left = count;
    for (let i = 0; i < count; i++) {
      const span = document.createElement('span');
      span.textContent = emojis[i % emojis.length];
      span.style.left = `${cx}px`;
      span.style.top = `${cy}px`;
      layer.append(span);
      const a = Math.random() * Math.PI * 2;
      const d = 110 + Math.random() * Math.min(220, rect.width / 2);
      const x = Math.cos(a) * d;
      const y = Math.sin(a) * d - 60;
      const r = (Math.random() - 0.5) * 120;
      span.animate([
        { transform: 'translate(-50%, -50%) scale(0.4)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.1)', opacity: 1, offset: 0.15 },
        { transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) rotate(${r}deg) scale(1)`, opacity: 0 },
      ], { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' })
        .finished.finally(() => { if (--left === 0) layer.remove(); });
    }
  }

  let last = -1;

  // Plays a random animation (never the same twice in a row) from angle `from` to angle `to`.
  // `?anim=N` in the URL forces animation N (1-20), handy to try them one by one.
  function play(element, from, to, { particles = true } = {}) {
    const forced = Number(new URLSearchParams(location.search).get('anim'));
    let index = forced >= 1 && forced <= ANIMATIONS.length ? forced - 1 : Math.floor(Math.random() * ANIMATIONS.length);
    if (!forced && index === last) index = (index + 1 + Math.floor(Math.random() * (ANIMATIONS.length - 1))) % ANIMATIONS.length;
    last = index;
    const animation = ANIMATIONS[index];
    const anim = element.animate(keyframes(animation, from, to), { duration: animation.duration, fill: 'forwards' });
    if (particles && animation.particles) {
      setTimeout(() => burst(element, animation.particles), animation.duration * animation.particles.at);
    }
    return { anim, name: animation.name };
  }

  window.FlipAnimations = { play, count: ANIMATIONS.length };
})();
