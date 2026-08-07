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

**Cron secret** — any long random string. Mash the keyboard if you like.

**Encryption key** — this one must be a specific format. Ask your assistant:

> Generate a random 32-byte base64 string for me.

It will look something like `k3Jd9...==` and be about 44 characters.

> **Keep the encryption key.** If you lose it you don't lose your pet's health
> data — only the saved login for your tracker, which you'd re-enter in Setup.

## Step 2 — Deploy

Click **Deploy with Vercel** in the README. It will:

1. Ask you to sign in and copy the project to your GitHub account.
2. Offer to add a **Neon** database — accept. This is the free Postgres that
   stores your data.
3. Ask for the three values from Step 1.

Then it builds for a couple of minutes and gives you a web address.

## Step 3 — Open your site and finish setup

Open the address. It will ask for the dashboard password from Step 1.

Go to **Setup** and:

- Set your pet's **timezone** — this decides which day each reading belongs to,
  so set it once and leave it.
- Choose **metric or imperial** units, and dog or cat.
- Optionally add **email alerts**. Sending through your own Gmail is simplest:
  it needs a Google *App Password*, not your normal password, and the form
  links to the page that generates one.
- Then connect a **data source** (see below).

## Step 4 — Choose where the data comes from

| Source | What it is |
|---|---|
| **CSV file** | Upload a spreadsheet. Good for data you already have. |
| **EU Data Act export** | Your tracker vendor's own official export. EU residents only. |
| **Tractive account** | Reads your account directly, every day, automatically. **Read the warning on that page before enabling it.** |

The Tractive option is the only one that updates by itself, and it is the only
one with a risk attached — Tractive's terms allow them to cancel a subscription
for automated access. The setup page shows you the exact wording and makes you
confirm. That decision is yours, and it's a real one: it's the same subscription
that helps you find your pet if they go missing.

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
| Alerts configured but no emails arriving | Resend's shared sender only delivers to the address that owns the Resend account. To send anywhere else you must verify your own domain. |
| "Could not decrypt the stored credential" | The encryption key changed. Re-enter your source login in Setup. |
| Last collection is days old | The daily job stopped. Check /status for the recorded error. |
| Charts show gaps | Normal if the collar was off or charging. Check the wear-time chart first — it explains dips in everything else. |

## A caution worth repeating

Pawline notices when numbers change. It cannot tell you why, and it cannot
diagnose anything. A quiet dashboard is not evidence your pet is well. If you
are worried about your pet, talk to a vet — that is true whatever this app says.
