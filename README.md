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
- **Jokes are never written by an AI.** They come only from the APIs above and the local list; Groq is used
  only to *refuse* a joke (moderation), never to create one.
- No service worker cache. The home page and the API are `no-store`; assets use a `?v=<fingerprint>` URL
  (new on every deploy) and are cached for good, so you still always get the latest version.

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

## Search engines and sharing (SEO)

- The home page has today's joke **in its HTML** (not only loaded by JavaScript), plus canonical, Open Graph,
  Twitter Card and JSON-LD tags.
- Every past joke has a permanent page `/blague/<YYYY-MM-DD>-<slug>` (setup visible, answer behind « Voir la réponse »,
  previous/next links, share buttons). Today's link redirects to `/` until tomorrow. Removed (reported) jokes and
  the local fallback list get no page.
- `/blagues` (latest jokes + months) and `/blagues/<YYYY-MM>` list the archive. `sitemap.xml` and `robots.txt` are generated.
- **Only revealed jokes are published.** A joke gets a page only once it has been the joke of the day and its
  period is over: there is no extra library, and no joke is ever written by an AI.
- **Themes** (`themes.js`, plain keyword rules): `/blagues/theme/<slug>` (animals, school, food, jobs, computing…,
  « courtes », « Toc toc »). A theme page exists, and is in the sitemap, only once it has 5 jokes.
  `/blagues/meilleures` ranks the jokes of the day by visitor rating (needs 5 rated jokes). `/blagues` is paginated
  (`/blagues/page/<n>`, 50 per page).
- To take a published joke down, add its id to `banned` in `/data/jokes.json` (a « Signaler cette blague » e-mail link is on every page).
- `/og/<date>.png` is the 1200 × 630 share image (the setup only, never the answer).
- Past-joke pages are cacheable by a CDN for a day (`s-maxage`): put Cloudflare in front and add a cache rule for
  `/blague/*`, `/blagues*` and `/og/*`. Submit `https://<your domain>/sitemap.xml` in Google Search Console and Bing Webmaster.
- The share button shares the joke's permanent link with `?src=partage`. Any link can carry `?src=<name>`
  (e.g. `?src=tiktok`): such visits count as human in `/admin` under « Liens partagés ». Visits from the social
  networks in `SOCIAL_REFERRERS` count under « Réseaux sociaux ».

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

To keep e-mails out of spam: add a DMARC record in your DNS (`TXT _dmarc.yourdomain.com` =
`v=DMARC1; p=none;`), turn off click and open tracking for the domain in Resend, and set
`EMAIL_REPLY_TO` to a real mailbox. The startup report warns when DMARC is missing.

### AI check of each joke (Groq)

Set `GROQ_API_KEY` (free at [console.groq.com](https://console.groq.com)) and every new joke is checked by a
Groq-hosted model (`GROQ_MODEL`, default `llama-3.3-70b-versatile`) after the word filter: anything that could
offend students (sexual, stereotypes, violence, drugs, politics…) is refused and never picked again. If Groq is
unreachable, the joke is kept (word filter only) and a warning is logged.

### QR codes per place and ratings

- In `/admin` → **Codes QR par lieu**, name a QR code (e.g. a school): it points to `QR_URL?qr=<name>` and
  its scans are counted apart (per day, uniques). Its page has the QR (PNG/SVG), label (PNG/PDF) and poster.
  A place can have **lots** (one per batch of labels sent): each lot has its own 4-digit code, label count,
  note and stats; the place page adds its lots up, and the general stats count them all as that place.
- After the punchline, a dismissible pop-up asks how funny the joke is (1–10), once per device and joke (Turnstile after the tap).
  Averages are shown in `/admin`.

### Instagram (Meta for Developers)

Every day at noon (right when the joke changes), the **question** is posted on Instagram (e.g. @blaguedujour.lol):
a 1080 × 1350 JPEG of the setup (`/ig/<date>.jpg`) and a caption that says the answer is on the site, « lien dans la bio ».
The answer is never posted. A one-liner joke is posted whole, with « lien dans la bio » for more.
A **story** (1080 × 1920, `/ig/<date>-story.jpg`) is posted right after, with the site's address drawn as a button
(`INSTAGRAM_STORY`, `INSTAGRAM_STORY_TEASER`). The API cannot add a clickable link sticker to a story: add one by hand
in the app if you want it (Story → Ajouter → Lien).

1. The Instagram account must be **professional** (Business or Creator): Instagram app → Settings → Account type.
2. On [developers.facebook.com](https://developers.facebook.com) → My Apps → Create app → use case
   « Manage messaging & content on Instagram ».
3. In the app: Use cases → Instagram API → Customize → **API setup with Unified login** (newer apps; older apps have
   « API setup with Instagram login ») → **Create new configuration**, pick the Instagram account and keep
   `instagram_basic` + `instagram_content_publish` → then generate the access token (log in with the Instagram account).
4. Paste the token in `INSTAGRAM_ACCESS_TOKEN` (`.env` or /admin → Réglages). The account id is found by itself
   (`/me/assigned_instagram_accounts`). A Unified-login token (system user, `EAA…`) never expires; an Instagram-login
   token (`IG…`, 60 days) is renewed every week (kept in `/data/instagram.json`).
5. Put the site's address (`https://blaguedujour.lol`) as the link in the Instagram bio.

- Meta downloads the image from the site: `PUBLIC_URL` must be **https** and reachable from the Internet. With Cloudflare,
  do not block `facebookexternalhit` (Bot Fight Mode / WAF) on `/ig/*`.
- The app can stay in development mode: only its own account (a tester) posts. No App Review is needed for that.
- A Facebook-Login Page token also works (the account linked to the Page is used). With several accounts, set `INSTAGRAM_USER_ID`.
- If a post fails it is retried (5, 15, 30, 60, 120 min). After downtime, a missed post is still made if it is less than
  6 h past noon. /admin → Réglages shows the account, the last post and the last error, and has a
  « Publier la blague du jour sur Instagram maintenant » button. Instagram allows 100 API posts per 24 h.
- A joke removed by reports after it was posted stays on Instagram: delete the post by hand in the app.
- Caption: `INSTAGRAM_CAPTION` (`{question}`, `{lien}` = the site's address, `\n` for a new line). Text on the image: `INSTAGRAM_TEASER`.

### Anti-robot, reports and Québec privacy law (Loi 25)

- **Cloudflare Turnstile** (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`) protects the e-mail sign-up and
  the report button. Without keys, both work without it.
- **Report button**: one report per device (random id kept by the browser *and* hashed IP + browser, both
  must be new), Turnstile required. After `REPORT_THRESHOLD` (10) reports the joke is removed: replaced by a
  new one if it has been shown for less than `REPORT_REPLACE_HOURS` (6 h), otherwise shown as unavailable
  until the next one. A removed joke is never picked again.
- **Loi 25**: `/confidentialite` (privacy policy) and `/conditions` (terms, with the disclaimer about joke
  content). Set `PRIVACY_OFFICER` and `PRIVACY_EMAIL`. E-mail sign-up requires ticking the consent box;
  unconfirmed addresses are deleted after 30 days; no cookies, no third-party geolocation (country/city
  only from Cloudflare headers); the IP address is never stored.

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

Every setting can also be changed in **/admin → Réglages**. A value saved there wins over the
`.env` (stored in `/data/settings.json`), applies at once, and can be reset to the `.env` value.
Only the VAPID keys need a restart.

## Admin (`/admin`)

Hidden page (no link anywhere, `noindex`), protected by `ADMIN_PASSWORD` (empty = the page does
not exist). It shows:

- **Human visits** per day, with countries, cities, sites, devices. A visit counts as human when
  it comes from the QR code (`?qr`), from the installed app (PWA), or from a search engine listed
  in `HUMAN_REFERRERS` (Google, Bing, DuckDuckGo… by default), from a social network in `SOCIAL_REFERRERS`, or from a link
  tagged `?src=<name>`. Other visits are counted apart as "non vérifiées",
  and known bots as "robots écartés". IPs are never stored.
- **Label requests** made on `/ads`, with a "Livré" button once delivered.
- **Downloads**: the QR code (PNG 2048 px, SVG), thermal labels 1 × 3 in (PDF, one label per
  page, as many as you want; or one label as a 300 dpi PNG, `?dpi=` to change it) and a poster with 4 copies on one Letter/A4 sheet (PDF).

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
