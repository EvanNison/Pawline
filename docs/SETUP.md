# Setting up Pawline

**This page is written to be pasted to an AI assistant.** If you are not a
developer, open Claude or ChatGPT, paste this whole file, and say:

> Help me set this up. I'm not technical. Walk me through one step at a time
> and wait for me to confirm each one before moving on.

There is no terminal in this guide. Everything happens in a web browser.

---

## What you'll end up with

A private website only you can open, which quietly records your pet's health
data every day, keeps it forever, and emails you if something drifts away from
what's normal *for your pet*.

## What you need first

- A **GitHub** account (free) — stores your copy of the app.
- A **Vercel** account (free) — runs it. You can sign in with GitHub.
- 15 minutes.

You do **not** need to install anything or pay anything.

---

## Step 1 — Make three secret values

You'll paste these into a form in Step 2. Generate each one and keep them
somewhere safe for now (a note app is fine).

**Dashboard password** — anything long you'll remember. This is what stops
strangers reading your pet's data.

**Cron secret** — any long random string. Mash the keyboard if you like. This
stops strangers triggering your data collection.

**Encryption key** — this one must be a specific format. Ask your assistant:

> Generate a random 32-byte base64 string for me.

It will look something like `k3Jd9...==` and be about 44 characters.

> **Keep the encryption key.** If you lose it you don't lose your pet's health
> data — only the saved login for your tracker, which you'd re-enter in Setup.

## Step 2 — Deploy

Click **Deploy with Vercel** in the README. It will:

1. Ask you to sign in and copy the project to your GitHub account.
2. Ask for the three values from Step 1.

Then it builds for a couple of minutes and gives you a web address.

## Step 2b — Add the database

Open the address. It will say the database isn't connected yet. That is the
expected next step, not a fault.

In the Vercel dashboard for your new project:

1. Go to **Storage → Create Database**.
2. Choose **Neon** (Postgres). The free plan is enough.
3. Connect it to this project when asked.

Vercel fills in `DATABASE_URL` for you. Then go to **Deployments**, open the
**⋯** menu on the most recent one, and choose **Redeploy** so it picks the new
setting up. Reload your address and the app will be running.

> Why isn't this automatic? Because a deploy button that half-provisions a
> database and silently fails is worse than one that tells you plainly what to
> click. Two clicks, once.

## Step 3 — Open your site and finish setup

Open the address. It will ask for the dashboard password from Step 1. Every
page asks, and the sign-in lasts 30 days on that device. Changing
`APP_PASSWORD` on Vercel signs every device out, which is what to do if the
link ever spreads further than you meant.

Go to **Setup** and:

- Set your pet's **timezone** — this decides which day each reading belongs to,
  so set it once and leave it.
- Choose **metric or imperial** units, and dog or cat.
- Optionally add **email alerts**. Sending through your own Gmail is simplest:
  it needs a Google *App Password*, not your normal password, and the form
  links to the page that generates one.
- Then connect a **data source** (see below).

## Step 4 — Choose where the data comes from

| Source | What it is | Available |
|---|---|---|
| **Spreadsheet (CSV)** | Upload a file of daily readings, from any tracker or kept by hand. No account, nothing to accept. | Yes — the **Import** page |
| **Tractive account** | Reads your account directly, every day, automatically. **Read the warning on that page before enabling it.** | Yes |
| **EU Data Act export** | Your vendor's own official export. EU residents only. | Not yet |

**Start with Import if you have any data at all.** It carries no risk, works
with any brand, and you will see charts within a minute instead of waiting for
an overnight run. The page tells you what the file should look like and lists
every column name it understands. Anything it cannot read is skipped and shown
to you with the row number, never guessed at.

The **Tractive** option is the one with a risk attached: their terms allow them
to cancel a subscription for automated access. The setup page shows you the
exact wording and makes you tick a box. That decision is yours, and it is a real
one — it is the same subscription that helps you find your pet if they go
missing.

If you are not willing to accept that, use Import. Charts, baselines, alerts and
alert emails all work from imported data — the only thing you give up is the
readings arriving on their own each night, so you re-upload when you have new
data.

> If you import only, the daily job still runs and still checks your stored
> readings for deviations. The Status page will say no source is scheduled,
> which is correct and expected — it means nothing is being *fetched*, not that
> nothing is being *judged*.

## Step 4b — Your history fills in over a few nights

The first collection fetches about a week, not everything your tracker holds.
That is deliberate: no server can pull two years of data inside a single web
request, so Pawline walks backwards a chunk at a time, once per night.

Open **Status** and you will see a line like *"Importing history — 120 days
walked so far, now at 2026-04-01."* Two years takes a few days to fill in. It
resumes on its own if a run fails, and it never re-fetches a day it already has.

You do not have to do anything while this happens. The dashboard works from day
one on whatever has arrived so far.

## Step 5 — Check it works, then wait

Open **Status**. It tells you whether collection is running, whether each
measurement is arriving, and what it cannot yet check. Don't wait for the
overnight run to find out something is wrong.

Then wait about **three weeks**. Pawline deliberately refuses to judge anything
until it has enough history — a "usual range" built from four days is a
confident-looking line that means nothing. It will say so plainly rather than
showing you a reassuring green tick.

---

## If something goes wrong

Open the **/status** page. It shows what's working and what isn't. Copy what it
says and paste it to your assistant along with this file.

> **Do not paste your passwords, your encryption key, your database URL, or
> your cron secret into a chat with an AI assistant** — including to get help.
> The status page is written to be safe to share; those values are not.

### Common problems

| What you see | What it means |
|---|---|
| "Not enough history to judge anything yet" | Working correctly. Come back in three weeks. |
| Alerts configured but no emails arriving | If using Gmail, the App Password is wrong or 2-Step Verification is not fully on. Check the Status page — it names the sending route in use. |
| "No source is enabled for scheduled collection" | Nothing is connected yet. See Step 4. |
| "Could not decrypt the stored credential" | The encryption key changed. Re-enter your source login in Setup. |
| "This site is not protected yet" | `APP_PASSWORD` is not set on Vercel. Pawline is refusing to show your data until it is. Add it in Settings → Environment Variables, then redeploy. |
| It asks for a password you don't recognise | It wants `APP_PASSWORD` from Step 1 — not your Tractive password. |
| Last collection is days old | The daily job stopped. Check /status for the recorded error. |
| Charts show gaps | Normal if the collar was off or charging. Check the wear-time chart first — it explains dips in everything else. |

## A caution worth repeating

Pawline notices when numbers change. It cannot tell you why, and it cannot
diagnose anything. A quiet dashboard is not evidence your pet is well. If you
are worried about your pet, talk to a vet — that is true whatever this app says.
