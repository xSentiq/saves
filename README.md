# 🗃️ Peak Vault

A private stash for everything good we send each other on Discord, like images, videos, memes, YouTube links, and random files, rated by both of us on a passcode-locked site.

Saving is done by **mreow** 🐱, our Discord app.

**Site:** <https://vault.faggot.world/>

```
Discord DM ──right-click → Apps → mreow → "Save to Vault"──▶ vault-discord (Supabase Edge Function)
                                                      │ downloads attachments, reads links/YouTube
                                                      ▼
                                   Supabase: vault_items + vault_ratings + private "vault" bucket
                                                      ▲
         GitHub Pages site (site/) ──passcode──▶ vault-api (Supabase Edge Function)
```

* **Saving:** mreow is a *user-installed* Discord app, so it works in DMs. Right-click any message, choose **Apps → Save to Vault**, and it saves every attachment (re-uploaded, since Discord links expire), every link, and every YouTube video. Forwarded messages work too. Click once and everything after that is automatic.
* **Why not fully automatic in DMs?** Discord doesn't let bots read DMs between two users. The only way would be a selfbot on your own token, which breaks Discord's ToS and gets accounts banned.
* **The site:** a static page on GitHub Pages. Nothing is readable without the passcode. The database has RLS on with no public policies, the bucket is private, and files are served through short-lived signed URLs. Wrong passcodes are rate-limited (8 per 15 minutes per IP).
* **Ratings:** each of us gives 1–5★ and the site shows both plus the average. You can sort by newest, top rated, not rated by me yet, or biggest disagreement.

## Repo layout

| Path | What |
|---|---|
| `site/` | The website (plain HTML/JS, no build step) |
| `supabase/functions/vault-discord/` | Discord interactions endpoint ("Save to Vault", `/vault link`, `/vault random`) |
| `supabase/functions/vault-api/` | Passcode login, list, rate, notes, remove, storage meter, bulk import |
| `supabase/migrations/` | Tables + private storage bucket |
| `scripts/register-commands.mjs` | Registers the Discord commands |
| `.github/workflows/` | Pages deploy, command registration, optional Supabase deploy |

The backend is already deployed to Supabase project `pllihkdrfnvriexwbdst`.

## Setup (one time, ~10 minutes)

### 1. Discord app
1. Go to <https://discord.com/developers/applications>, click **New Application**, and name it **mreow**. Give it a cat avatar while you're there.
2. On **General Information**, copy the **Application ID** and the **Public Key**.
3. On **Installation**, tick **User Install**. Set the install link to *Discord Provided Link* and add the `applications.commands` scope under User Install.
4. On **Bot**, click **Reset Token** and copy the bot token. It's only used once, to register the commands. Never put it in the code.

### 2. Supabase secrets
In Supabase, open the project, then **Edge Functions → Secrets**, and add:

| Name | Value |
|---|---|
| `VAULT_PASSCODE` | the passcode only we know (make it long) |
| `DISCORD_PUBLIC_KEY` | the Public Key from step 1 |
| `ALLOWED_DISCORD_USER_IDS` | our two Discord user IDs, comma-separated |
| `VAULT_NAMES` | `Sentiq,furfyl` (names on the login screen; 1st = 🐱, 2nd = 🐶) |
| `VAULT_SITE_URL` | optional, defaults to `https://vault.faggot.world/` |
| `DISCORD_BOT_TOKEN` | the bot token, only needed for **Import** (it refreshes expired file links from old DMs) |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key, finds the YouTube version of saved Spotify songs (console.cloud.google.com → enable *YouTube Data API v3* → Credentials → Create API key) |

Don't know your Discord ID? Leave `ALLOWED_DISCORD_USER_IDS` empty for now. The first time you use **Save to Vault**, mreow replies with your ID.

### 3. Point Discord at the endpoint
In the Developer Portal, go to **General Information → Interactions Endpoint URL** and enter:

```
https://pllihkdrfnvriexwbdst.supabase.co/functions/v1/vault-discord
```

Save. Discord sends a test ping, and it only saves once `DISCORD_PUBLIC_KEY` is set correctly.

### 4. GitHub
1. Under **Settings → Pages → Source**, choose **GitHub Actions**. Every push to `site/` then redeploys the site.
2. Under **Settings → Secrets and variables → Actions**, add `DISCORD_APP_ID` and `DISCORD_BOT_TOKEN`.
3. Under **Actions → Register Discord commands → Run workflow**, run it once.

### 5. Install it (both of us)
Open the install link from **Installation** in the Developer Portal and choose **Add to My Apps**. After that, right-click a message in your DM, then go to **Apps → mreow → Save to Vault**.

## Features

* **Save to Vault**: right-click a message → Apps → mreow → Save to Vault.
* **`/vault random [type]`**: mreow posts a random saved thing into the chat for both of you, with ratings and notes. Pick a type (image, video, YouTube, link, audio, quote) or leave it on anything.
* **`/vault link`**: the site link, only you see it.
* **Notes**: one shared note per item (both edit) and one personal note each (both read, only the owner edits).
* **Tags**: add tags to any item with **+ tag** (type several separated by commas, existing tags autocomplete). Click a tag to filter; pick several to narrow down. Sort by **By tag (A–Z)**. Both of you can edit tags.
* **Colour themes**: the 🎨 button in the header switches between the default look and 10 extra themes. Your pick is saved in a cookie in that browser (`site/themes.js` has the colours).
* **Storage meter**: shows how much of the 1 GB is used, split by type. Turns yellow at 70% and red at 90%.
* **Reactions**: click **☺+** on a card to react with an emoji (presets or any emoji you type). Click a reaction to add or remove yours; hover to see who reacted. `/vault random` shows them too.
* **Tier list**: switch the view to **Tier list** and drag saves into S / A / B / C / F (on phones: hold a moment, then drag). Click a tile to open it. Keyboard: focus a tile and press S, A, B, C, F, or U to unrank. The tier list is shared between both of you.
* **Music player**: the 🎵 button plays all the music in the vault at random (audio files, YouTube songs and Spotify links), with shuffle, previous / next and lock-screen controls. Music is detected automatically: audio files (not voice messages), YouTube Music links, "Artist - Topic" channels, and titles like "OST", "remix", "lyrics" or "Artist - Song". Tag something `#music` to add it or `#notmusic` to leave it out. Cards with music get a **▶ play** button.
* **Spotify links**: play through the matching song on YouTube (no Spotify login, no 30 s previews). The vault finds the YouTube version automatically (prefers the official "Artist - Topic" upload, avoids live / cover / sped up versions). Each Spotify card shows "▶ plays as …"; click **change** to paste a different YouTube link, or leave it empty to search again. Needs the `YOUTUBE_API_KEY` secret (free, about 100 songs a day).
* **Expiring Discord links**: Discord file links (`cdn.discordapp.com/attachments/...`) stop working after about a day. When mreow saves a message with one, it stores the file itself right away. Older saved links get rescued in the background whenever the site is open (needs `DISCORD_BOT_TOKEN` once a link has already expired). Normal links like YouTube or websites are left alone.
* **Import**: on the site, click **Import** and pick your Discord data package (Settings → Data & Privacy → Request all of my data → Messages). Choose your DM and it saves every file and link from it. The package only has your own messages, so each of you imports your own. Anything already saved is skipped, so it's safe to run again. Needs the `DISCORD_BOT_TOKEN` secret.

After changing commands (like adding `/vault random`), run **Actions → Register Discord commands** again and reload Discord with Ctrl+R.

## Custom domain (vault.faggot.world)

**DNS (Cloudflare):** add a `CNAME` record, name `vault`, target `xsentiq.github.io`, proxy status **DNS only** (grey cloud).

**GitHub:** go to Settings → Pages → Custom domain, enter `vault.faggot.world`, and click Save. Wait for the DNS check to pass and the certificate to be issued (usually 5–30 minutes), then tick **Enforce HTTPS**.

With Actions-based Pages deploys, the domain lives in the repo settings, not in a `CNAME` file.

## Changing things
* **New passcode:** change `VAULT_PASSCODE` in Supabase. Everyone gets logged out.
* **Backend changes:** edit `supabase/` and run the *Deploy Supabase* workflow (needs `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` secrets), or use `supabase functions deploy` locally.
* **Storage:** Supabase free plan = 1 GB total and 50 MB max per file. Anything bigger is saved as info only.
