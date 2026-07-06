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
