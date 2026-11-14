'use strict';

// Music for the Instagram videos: MP3s uploaded in /admin → Réglages, kept in /data/music.
// Each day one of them is picked at random (not the same as the day before when there are several),
// and the question image + that music become a short MP4 (ffmpeg), served at /ig/<day>-<kind>.mp4
// for Meta to download.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 50;

function createMusic({ dataDir }) {
  const dir = path.join(dataDir, 'music');
  const videoDir = path.join(dataDir, 'ig-videos');
  let ffmpegOk = null;

  // ---------- Files ----------

  // A safe file name from what the browser sent: letters, digits, - and _ only, always .mp3.
  function cleanName(name) {
    const base = String(name || '').replace(/\.mp3$/i, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return `${base || 'musique'}.mp3`;
  }

  const isMp3 = (buf) => buf.length > 4 && (buf.subarray(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));

  function list() {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort()
        .map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size }));
    } catch {
      return [];
    }
  }

  // Path of a stored track, or null (never leaves the music folder).
  function file(name) {
    if (typeof name !== 'string' || name !== path.basename(name) || !name.endsWith('.mp3')) return null;
    const p = path.join(dir, name);
    return fs.existsSync(p) ? p : null;
  }

  async function add(originalName, buf) {
    if (!isMp3(buf)) throw new Error(`${originalName} : ce n’est pas un fichier MP3`);
    if (buf.length > MAX_BYTES) throw new Error(`${originalName} : trop gros (20 Mo maximum)`);
    if (list().length >= MAX_FILES) throw new Error(`${MAX_FILES} musiques maximum : supprimes-en une`);
    await fsp.mkdir(dir, { recursive: true });
    let name = cleanName(originalName);
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = cleanName(`${originalName.replace(/\.mp3$/i, '')}-${i}`);
    await fsp.writeFile(path.join(dir, name), buf);
    return name;
  }

  async function remove(name) {
    const p = file(name);
    if (p) await fsp.unlink(p);
  }

  // Reads a multipart/form-data upload (one or more files in the field "files") without dependencies.
  function readUpload(req) {
    return new Promise((resolve, reject) => {
      const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] || '');
      if (!m) return reject(Object.assign(new Error('Envoi invalide'), { status: 400 }));
      const boundary = Buffer.from(`--${m[1] || m[2]}`);
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES * 5 + 65536) { req.destroy(); return reject(Object.assign(new Error('Envoi trop gros (100 Mo maximum à la fois)'), { status: 413 })); }
        chunks.push(c);
      });
      req.on('error', reject);
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const files = [];
        let start = body.indexOf(boundary);
        while (start !== -1) {
          const next = body.indexOf(boundary, start + boundary.length);
          if (next === -1) break;
          const part = body.subarray(start + boundary.length + 2, next - 2); // skip CRLF after boundary, before next
          const headEnd = part.indexOf('\r\n\r\n');
          if (headEnd !== -1) {
            const head = part.subarray(0, headEnd).toString('utf8');
            const filename = /filename="([^"]*)"/i.exec(head);
            if (filename && filename[1]) files.push({ name: path.basename(filename[1]), data: part.subarray(headEnd + 4) });
          }
          start = next;
        }
        resolve(files);
      });
    });
  }

  // ---------- Pick of the day ----------

  // picks: { day: name } kept by the caller (instagram.json), so both videos of a day and the retries
  // use the same track.
  function pick(day, picks) {
    const tracks = list().map((t) => t.name);
    if (!tracks.length) return null;
    if (picks[day] && tracks.includes(picks[day])) return picks[day];
    const previous = picks[Object.keys(picks).filter((d) => d < day).sort().pop()];
    const choices = tracks.length > 1 ? tracks.filter((t) => t !== previous) : tracks;
    picks[day] = choices[crypto.randomInt(choices.length)];
    for (const old of Object.keys(picks).sort().slice(0, -60)) delete picks[old];
    return picks[day];
  }

  // ---------- Video ----------

  function run(cmd, args, timeout = 120e3) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} : ${(stderr || err.message).toString().trim().split('\n').slice(-2).join(' ')}`));
        else resolve(stdout.toString());
      });
    });
  }

  async function ffmpegAvailable() {
    if (ffmpegOk === null) ffmpegOk = await run('ffmpeg', ['-version'], 10e3).then(() => true, () => false);
    return ffmpegOk;
  }

  async function duration(p) {
    try {
      const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', p], 20e3);
      return Number(out) || 0;
    } catch {
      return 0;
    }
  }

  const videoPath = (day, kind) => path.join(videoDir, `${day}-${kind}.mp4`);

  // Still image + music → H.264/AAC MP4 (what Instagram wants for Reels and stories), with fades.
  // The music starts at a random point of the track when it is long enough.
  async function render(day, kind, jpeg, track, seconds) {
    await fsp.mkdir(videoDir, { recursive: true });
    const img = path.join(videoDir, `${day}-${kind}.jpg`);
    const out = videoPath(day, kind);
    await fsp.writeFile(img, jpeg);
    const audio = file(track);
    if (!audio) throw new Error(`musique introuvable : ${track}`);
    const length = await duration(audio);
    const offset = length > seconds + 10 ? Math.floor(Math.random() * Math.min(60, length - seconds - 5)) : 0;
    await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-loop', '1', '-framerate', '30', '-i', img,
      '-ss', String(offset), '-i', audio,
      '-t', String(seconds),
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '30',
      '-vf', 'scale=1080:1920,format=yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
      '-af', `afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, seconds - 1.5)}:d=1.5`,
      '-movflags', '+faststart',
      out,
    ], 180e3);
    await fsp.unlink(img).catch(() => {});
    // Old videos are not needed once posted: keep the last 6 files.
    const files = (await fsp.readdir(videoDir)).filter((f) => f.endsWith('.mp4')).sort();
    for (const old of files.slice(0, -6)) await fsp.unlink(path.join(videoDir, old)).catch(() => {});
    return out;
  }

  // Served at /ig/<day>-<kind>.mp4 (only once rendered).
  function video(day, kind) {
    const p = videoPath(day, kind);
    return fs.existsSync(p) ? p : null;
  }

  return { list, file, add, remove, readUpload, pick, render, video, ffmpegAvailable, MAX_BYTES };
}

module.exports = { createMusic };
