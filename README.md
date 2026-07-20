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

## Opt-in nurture sequence (email + SMS)

Every landing-page signup and CSV-imported contact gets enrolled in a
drip automatically (`src/sequences.js`):

- **Email (Resend):** Gold Owner's Guide PDF link immediately → jewelry
  care tips after 2 days → soft nudge to `/shop/` after 5 days.
- **SMS (Semaphore):** one welcome text immediately, if a phone number
  is present. Separate from this: `src/priceAlerts.js` already sends
  price-move alerts by email/SMS to anyone who opted into that channel
  — that part isn't a fixed drip, it fires whenever gold moves ≥1.5%
  in a day.

**CSV import:** `/admin/contacts.html` → upload a CSV with
`name, email, phone, channel` columns → each row is imported and
enrolled, with an optional "send first message at" time so a bulk
import doesn't fire drip emails at 2am.

### Resend vs Smartlead.ai — which one do you actually need?

These solve different problems, and the answer depends on *who's on
the list*:

- **Resend** is a transactional/opt-in email API — built for sending
  to people who already gave you permission (signed up on your site,
  bought something, etc). This is what's wired into `src/emailSender.js`
  and used above, because every contact in your `optins` table either
  filled out the form themselves or was imported by you as an existing
  customer/lead — not a cold, unsolicited list.

- **Smartlead.ai** is built for cold outreach at scale — high-volume
  sending to people who *haven't* opted in, with mailbox warmup pools
  and inbox rotation specifically because that kind of sending gets
  flagged as spam without it. It's the right tool if you plan to email
  prospects who've never interacted with Riolendel — e.g. sourcing a
  list of jewelry shoppers and cold-emailing them.

**If you're only doing the opt-in nurture sequence above, Resend is
the correct (and only) tool — Smartlead would be solving a problem you
don't have.** If you later want to run actual cold outreach to a
purchased or scraped list, that's a separate system from what's built
here, and worth setting up on its own — mixing cold-outreach volume
into the same sending domain as your opt-in nurture emails can hurt
deliverability for the legitimate list too. Also worth checking
Philippine data privacy rules (the Data Privacy Act of 2012, which the
opt-in form's consent language already references) before cold-emailing
any list you didn't collect direct consent for.

## Affiliate shop, video warm-up & cross-posting

Three admin-only tools live under `/admin/` (protected by `ADMIN_TOKEN`):

- **`/admin/videos.html`** — add TikTok video references (for content
  research, not downloading) and 18K gold affiliate products (shown on
  the public `/shop/` page). Also has the **Warm-Up & Schedule** tab,
  with two ways to get a video: upload a file you already have, or
  generate one from a product photo via Runway's image-to-video API
  (`src/videoGenerator.js`) — no watermark, since it's generated fresh
  rather than reposted from Shopee/TikTok Shop, which stamp their own
  branding onto every video. Either path extracts 2–4 JPEG stills via
  ffmpeg, and you can schedule a two-phase campaign — stills post
  immediately (no link, just to warm up engagement), then the real
  video + your affiliate link auto-posts 1–2 days later via
  `src/scheduler.js`. This matters because Shopee/TikTok Shop affiliate
  links carry session-timed tracking tokens that can expire before an
  immediate post gets real engagement.
- **`/admin/social.html`** — one-off cross-posting to Facebook,
  Instagram, TikTok, and Shopee from a single compose box.

**Runway API note:** this integration was built without live access to
test against Runway's current API, since exact field names can shift
between model generations. If video generation fails with a schema
error, check `https://docs.dev.runwayml.com` against the request shape
in `src/videoGenerator.js`'s `createTask()` and adjust field
names/enums to match — the polling/download logic around it shouldn't
need to change.

**ffmpeg requirement:** frame extraction needs `ffmpeg`/`ffprobe` on
the host. This repo includes `nixpacks.toml` so Railway's builder
installs it automatically — no action needed on Railway. Running
elsewhere (Docker, VPS), make sure `ffmpeg` is on `PATH`.

**Platform API setup:** see `.env.example` for `FB_PAGE_ID`,
`IG_USER_ID`, `TIKTOK_ACCESS_TOKEN`, etc. Facebook is the fastest to
get working; Instagram and TikTok both require Meta/TikTok app review
before they post automatically — until approved, the dashboard falls
back to a "copy text" mode for those platforms so nothing blocks you.

**Uploaded files & persistence:** videos and extracted frames are
saved under `public/uploads/`. On Railway this is ephemeral storage —
files survive restarts within a deploy but are wiped on redeploy.
Attach a Railway Volume mounted at `public/uploads` if you need these
to persist long-term, or move to S3/Cloudinary for production use.

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

## AI chatbot (needs ANTHROPIC_API_KEY)

A floating chat widget on the landing page answers gold questions via
`/api/chat`, powered by Claude Haiku (`claude-haiku-4-5`, $1/$5 per
million input/output tokens, pay-as-you-go). Setup: get a key at
console.anthropic.com, add `ANTHROPIC_API_KEY` to Railway variables.

Cost controls already built in: 20 messages/IP per 10 minutes, replies
capped at 400 tokens, history capped at 8 messages, message length
capped at 1,000 chars. Typical cost at low traffic: cents per day.
Still, set a monthly spend limit in the Anthropic console as a backstop.

Guardrails in the system prompt: education only, no investment advice,
no platform recommendations, flags guaranteed-return claims as scam
signals, never collects personal info in chat, PH/Taglish friendly.

## Lead agent (scores + drafts, human review required)

`GET /api/admin/lead-report?token=YOUR_ADMIN_TOKEN` returns every
opted-in lead, scored and tiered (A/B/C), each with a personalized
draft email written by Claude — sorted best-first, ready for your
review. Add `&drafts=0` to skip AI drafting (free, instant, scoring
only). Set `ADMIN_TOKEN` in Railway variables (any long random string).

**Deliberate design choice:** the agent scores using only first-party
signals — channel choice, email domain, signup recency — and does NOT
web-research individual subscribers. Their consent covers receiving
updates, not being profiled around the internet; researching them would
exceed the consented purpose under the PH Data Privacy Act. First-party
scoring gets you 90% of the prioritization value with none of the
legal exposure.

**Nothing is auto-sent.** The report is a review list. Copy the drafts
you like into your email tool (or wire notify.js to a provider and add
a send step once you've reviewed a few batches and trust the output).
