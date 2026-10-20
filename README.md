# Dad Jokes

A minimal website that shows **one new dad joke every day**. The joke changes at
**midnight New York time** (`America/New_York`, DST-aware) and stays the same all day
for everyone. The source of the joke is shown in small print at the bottom of the screen.

- Jokes come from the public [icanhazdadjoke.com](https://icanhazdadjoke.com/api) API,
  with the [Official Joke API](https://github.com/15Dkatz/official_joke_api) as backup and a
  small local list if both are unreachable.
- Each day's joke is stored in `/data/jokes.json`, so it survives restarts and never repeats.
- Sober, Apple-style design (system font, light/dark mode, 44 pt touch targets, safe areas,
  reduced motion), responsive, and installable as a PWA (manifest, service worker, offline).

## Run

```sh
docker compose up -d --build
```

Then open <http://localhost:8002>.

Without Docker: `node server.js` (Node 20+, no dependencies).

## API

`GET /api/joke`

```json
{
  "date": "2026-10-20",
  "timeZone": "America/New_York",
  "joke": "…",
  "source": "icanhazdadjoke.com",
  "sourceUrl": "https://icanhazdadjoke.com/j/…",
  "nextChangeAt": "2026-10-21T04:00:00.000Z"
}
```
