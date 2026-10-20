# Dad Jokes

A minimal website that shows **one new dad joke every day**, in New York time
(`America/New_York`, DST-aware): it changes at **noon from Monday to Friday** and at
**midnight on Saturday and Sunday**, and stays the same for everyone until the next change.
The source of the joke is shown in small print at the bottom of the screen.

- Jokes are **in French**. They come from the free [JokeAPI](https://jokeapi.dev) (French
  jokes, no key needed), filtered to drop crude or mean ones. If you set `BLAGUES_API_TOKEN`
  (free key from [blagues-api.fr](https://www.blagues-api.fr)), Blagues API is used first.
  A small local list is used if every API is unreachable.
- Two-part jokes show the setup on a card you swipe (or tap) to flip to the punchline. Each flip
  plays one of 20 animations at random (`?anim=1`…`?anim=20` in the URL forces one, to try them).
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
