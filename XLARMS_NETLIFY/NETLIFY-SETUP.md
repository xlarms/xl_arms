# XL Arms — Netlify setup (new site, not the old one)

## 1. Yes — new design, and yes — a NEW Netlify project first

The starter in this folder is already a new design, not a copy of the old
xlarms.us design. It has a new homepage/shop, new search with facets, and new
product pages with the FFL notice. Final branding polish (logo, colours,
hero) comes after the importer works — send the XL Arms logo / colours if
you have a preferred look, otherwise the clean starter design is the base.

Do NOT touch the live xlarms.us site or its old hosting yet. The plan is:

1. Create a NEW Netlify site from this folder (below). It gets a temporary
   `something.netlify.app` address.
2. Test on that temporary address: search, stock, images, restrictions.
3. Only when it passes, point the `xlarms.us` domain to the new Netlify
   site (Domain settings in Netlify, then DNS at your domain registrar).
4. Only then is the old setup retired. Until step 3, the old site stays
   live as your safety net — so yes, you are totally leaving the old setup
   in the end, but not on day one.

## 2. How basic-ftp gets installed — you do NOT install it in Netlify's dashboard

`basic-ftp` is a Node package, listed in `package.json` in this folder.
Netlify installs it automatically when it builds the site — you never
click an "install package" button in Netlify.

Recommended route (cleanest):
1. Git repo — DONE 2026-10-25 (Jonathan, screenshot verified):
   `github.com/xlarms/xl_arms` — user `xlarms`, repo `xl_arms`, branch `main`,
   1 commit ("Add files via upload"). NOTE: this repo is PUBLIC, not Private
   as originally suggested. That is not a password leak — no credentials are
   in this code — but anyone can read the code. To make it Private later:
   GitHub repo → Settings → General → Danger Zone → Change visibility.
   CORRECTION 2026-10-25 (Jonathan): the first upload was NOT the latest
   package — it did not include the Wasabi/Bunny guide, package.json,
   .gitignore, or the real importer. He will delete that upload and
   re-upload the latest package (this zip).
   HOW TO DELETE THE OLD UPLOAD (GitHub web, no command line):
   - Cleanest: repo → Settings → General → Danger Zone → Delete this
     repository, then recreate `xl_arms` and upload fresh. This is safe
     here because the source files are still in the Muse zip — nothing
     is lost by deleting the GitHub copy.
   - Or file-by-file: open `XLARMS_NETLIFY/`, open each file, top right
     → Delete file, commit. Tedious for ~15 files, so repo delete is
     usually faster.
   RE-UPLOAD THE LATEST — DO IT AT THE REPO ROOT THIS TIME (recommended):
   Extract this zip, then in GitHub Add file → Upload files, drag in the
   EXTRACTED CONTENTS (index.html, netlify/, package.json, .gitignore,
   NETLIFY-SETUP.md, etc. — not the zip itself, not node_modules).
   Do NOT put them inside a `XLARMS_NETLIFY/` folder again. At the root,
   the Netlify settings below are the simple ones.
   If you instead re-upload inside `XLARMS_NETLIFY/` again, use the
   alternative settings in brackets below.
2. In Netlify: Add new site → Import an existing project → GitHub →
   pick `xlarms/xl_arms` (authorize Netlify to read GitHub if asked).
3. Netlify settings — for a ROOT upload (recommended):
   - Base directory: (leave blank)
   - Build command: leave blank (static site) or `npm install` if Netlify asks.
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
   [Alternative, only if files are inside XLARMS_NETLIFY/ again:
   Base directory: `XLARMS_NETLIFY`, Publish: `.`, Functions:
   `netlify/functions` — both relative to that base. If Base is left
   blank with a nested upload, Netlify finds no index.html / package.json
   / netlify.toml at the root and the deploy fails or publishes empty.]
4. Deploy. Netlify runs `npm install`, reads `package.json` (inside
   XLARMS_NETLIFY/), and bundles `basic-ftp` into the importer function
   automatically.

If you use drag-and-drop zip upload instead, Netlify does NOT run
`npm install` for you. In that case, on your own computer first run
`npm install` in this folder, then include the resulting `node_modules`
folder in the zip you upload — or use the Netlify CLI (`netlify deploy`),
which bundles functions for you. Git is the simplest way to avoid this trap.

Test locally first (optional, no Netlify needed):
`node scripts/test-importer.js` — should print PASS.

## 3. How to set the RSR FTP login in Netlify — never in code, never in chat

In Netlify, after you create the new site:
1. Open the site → Site configuration (or Site settings) → Environment variables.
2. Add a variable, one at a time. Scope: All scopes (or Production + Functions).
   - `RSR_FTP_HOST` — the FTP host RSR gave you (host only, no `ftp://`, no password)
   - `RSR_FTP_USER` — your RSR FTP username
   - `RSR_FTP_PASS` — your RSR FTP password (this is often DIFFERENT from the
     rsrgroup.com website password — use the FTP one)
   - `RSR_FTP_DIR` — `ftpdownloads`
   - Later, when image sync is configured: `WASABI_BUCKET`, `WASABI_KEY`,
     `WASABI_SECRET`, `WASABI_REGION`, `BUNNY_PULL_ZONE`, `BUNNY_API_KEY`
3. Save, then redeploy the site (or trigger the importer function). Functions
   read these as `process.env.RSR_FTP_HOST` etc. — the values are encrypted
   in Netlify and are never shown in code, logs, or chat.
4. Do NOT paste the FTP password in chat, in a file, or in `netlify.toml`.

## 4. Bunny and Wasabi — when do they get updated? NOT now

Leave your current Bunny / Wasabi exactly as they are. They are working
for the old site — images ARE showing there — and touching them now
could break the live site for no benefit.

The order is:
1. New Netlify site created, catalog importer working (prices, stock,
   text) — Bunny/Wasabi not involved yet.
2. Image-sync step, AFTER the catalog works and BEFORE you switch DNS:
   importer downloads each changed RSR image (standard from
   /ftp_images/, high-res from /ftp_highres_images/ for product pages),
   uploads it to Wasabi as `products/<RSR>/1.jpg, 2.jpg…`, then purges
   Bunny's cache ONLY for those changed RSR numbers. Bunny then pulls
   the fresh file from Wasabi on the next request.
3. Check images on the temporary `*.netlify.app` address.
4. Only then switch `xlarms.us` DNS to the new site.

For testing, use a separate Wasabi folder/bucket (or a new Bunny pull
zone) for the new site, so testing never purges the old site's cached
images. After the switch, the old zone/bucket can be retired.
Wasabi/Bunny logins go in Netlify the same way as the FTP login:
Site configuration → Environment variables →
`WASABI_BUCKET`, `WASABI_KEY`, `WASABI_SECRET`, `WASABI_REGION`,
`BUNNY_PULL_ZONE`, `BUNNY_API_KEY` — never in code or chat.

## 5. What is NOT ready yet (kept last, on purpose)

- Payment / checkout: no gateway is wired until a firearms-friendly gateway
  gives written approval (Stripe or another — to be checked).
- Price-match wording and the $25 FFL-fee proof/reimbursement method:
  the offers are decided, the exact site wording is still to be written.
- Scheduled runs: once a manual importer run works on the new site, add a
  scheduled trigger for it (Netlify Scheduled Functions). Do not schedule
  it before the first manual run passes.
