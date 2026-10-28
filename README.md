# Dad Jokes

A minimal website that shows **one new dad joke every day**, in New York time
(`America/New_York`, DST-aware): it changes **every day at noon**, weekends included,
and stays the same for everyone until the next day at noon.
The source of the joke is shown in small print at the bottom of the screen.

- Jokes are **in French**. They come from the free [JokeAPI](https://jokeapi.dev) (French
  jokes, no key needed), filtered to drop crude or mean ones. If you set `BLAGUES_API_TOKEN`
  (free key from [blagues-api.fr](https://www.blagues-api.fr)), Blagues API is used first.
  A small local list is used if every API is unreachable.
- Two-part jokes show the setup on a card you swipe (or tap) to flip to the punchline. Each flip
  plays one of 20 animations at random (`?anim=1`…`?anim=20` in the URL forces one, to try them).
- A clock button (top right) shows the jokes of the last 7 days, punchlines hidden until tapped.
- Each day's joke is stored in `/data/jokes.json`, so it survives restarts and never repeats.
- Sober, Apple-style design (system font, light/dark mode, 44 pt touch targets, safe areas,
  reduced motion), responsive, and installable as a PWA (manifest, service worker).
- Nothing is cached (no-store headers, no service worker cache): you always get the latest version.

## Run

```sh
docker compose up -d --build
```

Then open <http://localhost:8002>.

Optional, better French jokes:

```sh
BLAGUES_API_TOKEN=your_token docker compose up -d --build
```

Without Docker: `node server.js` (Node 20+, no dependencies).

## Notifications

People can get each new joke by **push notification** and/or **e-mail** (buttons under the card).
Both are sent once per joke, right when it changes.

### Push (PWA)

- Works in Chrome, Edge, Firefox and Safari, and on iPhone/iPad (iOS 16.4+) **only once the site
  is added to the home screen** (Share → Add to Home Screen) and opened from there.
- **Requires HTTPS** (browsers block push on plain `http://<ip>`). Put the site behind a reverse
  proxy with a certificate (Caddy, Nginx + Let's Encrypt, Cloudflare Tunnel…).
- VAPID keys are generated on first start and kept in `/data/vapid.json` (or set
  `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`). Set `VAPID_SUBJECT` to your e-mail address.

### E-mail (Resend)

1. Create an account on [resend.com](https://resend.com), verify your domain, create an API key.
2. Set the variables (e.g. in a `.env` file next to `docker-compose.yml`):

```env
PUBLIC_URL=https://blague.yourdomain.com
RESEND_API_KEY=re_xxxxxxxx
EMAIL_FROM=La blague plate du jour <blague@yourdomain.com>
VAPID_SUBJECT=you@yourdomain.com
```

Sign-up uses double opt-in (a confirmation link is e-mailed first). Every e-mail has an
unsubscribe link and one-click `List-Unsubscribe` headers. The e-mail button only shows when
all three e-mail variables are set. Subscribers are stored in `/data/subscribers.json`.

### Troubleshooting

At startup the server prints what is configured and what is wrong (missing variable, invalid
Resend key, unverified domain, no HTTPS…):

```sh
docker compose logs dadjokes | grep -A8 '\[config\]'
```

## Settings

Every setting (texts, schedule, admin password, QR code, labels, posters…) comes from a `.env`
file next to `docker-compose.yml`. Copy `.env.example` to `.env`: it lists every variable with
its default value. Without Docker, `node server.js` reads the same `.env`.

## Admin (`/admin`)

Hidden page (no link anywhere, `noindex`), protected by `ADMIN_PASSWORD` (empty = the page does
not exist). It shows:

- **Human visits** per day, with countries, cities, sites, devices. A visit counts as human when
  it comes from the QR code (`?qr`), from the installed app (PWA), or from a search engine listed
  in `HUMAN_REFERRERS` (Google by default). Other visits are counted apart as "non vérifiées",
  and known bots as "robots écartés". IPs are never stored.
- **Label requests** made on `/ads`, with a "Livré" button once delivered.
- **Downloads**: the QR code (PNG 2048 px, SVG), thermal labels 1 × 3 in (PDF, one label per
  page, as many as you want) and a poster with 4 copies on one Letter/A4 sheet (PDF).

## Label requests (`/ads`)

For the people who stick labels around: they enter how many labels they need and their locker
number; the request shows up in `/admin`. Stored in `/data/label-requests.json`.

## API

`GET /api/joke`

```json
{
  "date": "2026-10-20",
  "timeZone": "America/New_York",
  "joke": "…",
  "source": "JokeAPI",
  "sourceUrl": "https://jokeapi.dev",
  "nextChangeAt": "2026-10-21T04:00:00.000Z"
}
```
