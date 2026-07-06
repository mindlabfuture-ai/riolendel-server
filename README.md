# Riolendel — Node server

Express server that serves the gold-education landing page, stores
opt-ins in Postgres, and fetches the gold price from GoldAPI.io once a
day (never per-visitor, so your free API quota is never at risk).

## Local development

```bash
npm install
cp .env.example .env
# fill in GOLDAPI_KEY at minimum — DATABASE_URL can stay blank locally
npm run dev
```

Visit `http://localhost:3000`.

Without `DATABASE_URL` set, the app still runs — opt-ins are validated
and accepted but not saved anywhere. That's fine for developing the
front end; you'll want Postgres attached before taking real signups.

## Deploying: GitHub + Railway

1. **Push this project to a new GitHub repo.**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
   git push -u origin main
   ```

2. **Create a Railway project from that repo.**
   Go to railway.com → New Project → Deploy from GitHub repo → select
   it. Railway auto-detects Node.js from `package.json` and deploys on
   every push to `main` from then on — that's your GitHub + Railway
   pipeline, no extra CI config needed.

3. **Add a Postgres database.**
   In your Railway project: New → Database → Add PostgreSQL. Railway
   automatically sets `DATABASE_URL` on your app service — you don't
   need to copy/paste it yourself.

4. **Set your remaining environment variables.**
   On your app service → Variables tab, add:
   - `GOLDAPI_KEY` — your key from goldapi.io
   - `GOLD_PRICE_CRON` — optional, defaults to once daily

5. **Generate a public domain.**
   App service → Settings → Networking → Generate Domain. Point your
   `riolendel.com` DNS at it (Railway's docs cover custom domains) once
   you're happy with it.

6. **Watch the first deploy's logs** for:
   ```
   [db] Connected and tables ready.
   [gold-price] Updated: $4650.00/oz (...)
   [server] Listening on port ...
   ```
   That confirms Postgres and GoldAPI are both wired up correctly.

## Cost reality check

Railway's free trial gives $5 in credits for 30 days. After that, a
service **plus** a Postgres database realistically needs the Hobby
plan — $5/month minimum. There's no permanent free tier that fits this
setup. Budget for that before you rely on this for real opt-ins.

## What's still manual

- The opt-in form saves signups to Postgres, but doesn't send any
  email/SMS yet. You'll want to connect an email service (e.g.
  Postmark, Resend) or PH SMS gateway (e.g. Semaphore, Movider) to
  actually message people who sign up.
- No admin view of collected opt-ins yet — for now, check them via
  Railway's Postgres data tab, or `psql` in with the connection string
  from the Variables tab.

## Historical price chart

The landing page now shows a bar chart of gold's approximate year-end
USD/oz price for the last ~10 years, rendered client-side with Chart.js
(loaded from a CDN — no build step needed). The dataset is a small
hardcoded array in `public/index.html` (search for "Approximate
year-end USD/oz"), since past years' prices don't change — no API
calls needed for this at all. Update that array yourself once a year
when a new year closes out, and consider swapping in exact LBMA figures
if you want more precision than the rounded reference numbers currently
there.

## Price-move alerts (partially built — needs a provider to go live)

`src/priceAlerts.js` compares each day's fetched gold price to the
previous day (stored in a small `gold_price_history` table) and flags
moves of 1.5% or more as "notable." When one happens, it's meant to
alert everyone who opted in, using their chosen channel (email, SMS,
or both — collected via the new radio buttons on the opt-in form).

**What's real:** the detection logic, the subscriber list with channel
preference, and the day-over-day comparison.

**What's a stub:** `src/notify.js` currently just logs what it *would*
send — it isn't wired to a real email or SMS provider yet, since that
needs your own account and API key. To make it live:
1. Sign up for an email provider (Resend or Postmark) and an SMS
   gateway if you want PH SMS (Semaphore or Movider).
2. Add their API keys to your Railway environment variables.
3. Replace the `console.log` calls in `src/notify.js` with the real
   `fetch()` calls (commented examples are already in that file).

**One more honest limitation:** this alerts on the *size* of a price
move, not the *reason* for it. Actually identifying "the news that
caused it" would need either a paid news API or a person glancing at
gold news before the alert goes out and adding a one-line cause. Worth
doing manually at first rather than promising fully automatic
news-linked alerts before that's really wired up.
