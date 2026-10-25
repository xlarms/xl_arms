# XL Arms — Fresh Netlify Site (Starter Build)

**Status: STARTER, not launch-ready.** Search, filters, category/brand/caliber facets, product pages and the FFL notice work with 8 sample products. Real data, real images and real checkout are not wired yet — on purpose, so nothing fake can take a real order.

## How to preview (same as Earth's Dawn: extract first, then open)

1. Extract the whole ZIP — do not open index.html from inside the ZIP.
2. Open the extracted folder's `index.html` in a browser, or serve it locally:
   `python3 -m http.server 8000` then open http://localhost:8000
   (Direct file:// opening can block fetch of data/products.json in some browsers — the local server avoids that.)
3. Try these searches to see the ranking fix:
   - `Glock 19` → Glock 19 first, not every Glock and every 9mm equally
   - `9 mm` → 9mm products
   - `G19` → Glock 19 (synonym expansion)
   - `GLK19G5` → exact SKU first
   - `Glock 17` → shows out-of-stock, in-stock filter hides it

## What is in the package

- `index.html` — homepage + shop + search + facets
- `product.html?sku=GLK19G5` — product page with spec table + FFL notice for firearms
- `assets/app.js` — search ranking, synonyms, caliber canonicalisation, autocomplete suggestions
- `assets/style.css` — clean, mobile-friendly layout
- `data/products.json` — SAMPLE catalog + the exact schema the RSR importer must produce
- `netlify.toml` — publish root, functions dir, /api/products redirect
- `netlify/functions/get-products.js` — starter API (serves sample file; production reads the real store)
- `netlify/functions/rsr-import-background.js` — importer skeleton with the full production steps documented, no credentials

## What still blocks launch (in order)

1. **DONE 2026-10-25 — RSR FTP mapping.** All files mapped from Jonathan's screenshots/samples: inventory (76 fields), attributes (52 fields, attributes-all primary), product-xref, restrictions, messages, retail-map, sell descriptions, FFL dealers, fulfillment (reference only), images (sharded, high-res mirrors). Full map: see the delivered FTP map file.
2. **DONE 2026-10-25 — Pricing, catalog, stock (Jonathan's decisions).** Sell at MAP, plus price-match offer, plus FFL transfer fee up to $25 if proven (proof/reimbursement details still to be written). Full RSR catalog, no exclusions. Stock = main inventory only.
3. **NEW — Real importer (this build).** `netlify/functions/rsr-import.js` is the real parser/normalizer, tested on Jonathan's sample rows (`node scripts/test-importer.js` — PASS). `rsr-import-background.js` is the Netlify wrapper: download from FTP, build, validate, publish atomically. To run it live, install `basic-ftp` and set RSR FTP env vars in Netlify — no credentials in code.
4. **Payment gateway — KEPT LAST (Jonathan).** Firearms-friendly, with written approval. Do not reuse Earth's Dawn Stripe setup without that check. No checkout is wired in this package.
5. **FFL checkout flow** — dealer picker / confirmation, state restrictions, age gates. Dealer data and restriction rules are already in the importer; the checkout UI waits for payment.
6. **Real images** — importer pulls all RSR images per product into Wasabi, Bunny serves them; this starter uses a placeholder until image sync is configured.

## Deploy notes (when ready)

- Create a NEW Netlify site for this folder. Keep live xlarms.us untouched until the new site passes the search/stock/image checks.
- Set RSR / Wasabi / Bunny / store credentials only in Netlify environment variables — never in code or in chat.
- After the importer is real, test: one in-stock firearm, one out-of-stock item, one ammo item, one search with a misspelling, and one zero-result search — before switching DNS.
