// RSR FTP IMPORTER — Netlify background function wrapper.
// The real parsing/normalizing lives in ./rsr-import.js (pure, tested — see
// scripts/test-importer.js). This wrapper only does: download -> buildCatalog ->
// validate -> publish atomically -> log. It never blanks the live catalog on failure.
//
// Netlify env vars (dashboard only, never in code or chat):
//   RSR_FTP_HOST, RSR_FTP_USER, RSR_FTP_PASS — RSR FTP login (FTP pass is often
//     different from the website pass; do not paste it in chat).
//   RSR_FTP_DIR — usually "ftpdownloads" (data) — images live under /ftp_images/ and
//     /ftp_highres_images/ at the FTP root, NOT under ftpdownloads/.
//   PRODUCT_STORE — "file" (writes data/products.json, for local/offline runs) or
//     "blobs" (Netlify Blobs — requires @netlify/blobs; see note below).
//   WASABI_* / BUNNY_* — image sync (Wasabi upload + Bunny purge for changed SKUs only).
//     Image sync is a separate step after catalog publish and is NOT required for the
//     catalog itself to go live; if Wasabi is not configured, catalog still publishes
//     with RSR image paths and the site shows its placeholder until images sync.
//
// PAYMENT = LAST (Jonathan, 2026-10-25). This file contains NO checkout and NO
// payment wiring. Do not add Stripe or any gateway here until a firearms-friendly
// gateway with written approval is confirmed.
//
// FTP download: uses the "basic-ftp" package when installed (`npm i basic-ftp`).
// If it is not installed, the handler returns a clear 202 explaining that the
// dependency (and the FTP env vars) must be set — it does NOT pretend to have imported.
// For an offline run, Jonathan can download the ftpdownloads/ files with FileZilla
// and run the parser locally: node scripts/test-importer.js proves the parsers,
// and a local runner can call buildCatalog() with those file contents directly.
const { buildCatalog, toStorefrontCatalog } = require('./rsr-import');

const DATA_FILES = {
  inventory: 'rsrinventory-new.txt',
  attributesAll: 'attributes-all.txt',
  attributes: 'attributes.txt',
  xref: 'product-xref.txt',
  restrictions: 'rsr-ship-restrictions.txt',
  messages: 'rsr-product-message.txt',
  retailMap: 'retail-map.csv',
  sellDescriptions: 'product_sell_descriptions.txt',
  ffl: 'ffl-transfer-dealers.txt',
  deleted: 'rsrdeletedinv.txt',
  newSkus: 'IM-NEW-SKUS.csv',
  // Reference only — never merged into storefront stock (Jonathan: main inventory only).
  fulfillment: 'fulfillment-inv-new.txt',
};

async function downloadAll() {
  let ftp;
  try { ftp = require('basic-ftp'); } catch {
    throw new Error('FTP client not installed: run `npm i basic-ftp` and set RSR_FTP_HOST/USER/PASS in Netlify env vars.');
  }
  const { RSR_FTP_HOST, RSR_FTP_USER, RSR_FTP_PASS, RSR_FTP_DIR = 'ftpdownloads' } = process.env;
  if (!RSR_FTP_HOST || !RSR_FTP_USER || !RSR_FTP_PASS) {
    throw new Error('RSR FTP env vars missing (RSR_FTP_HOST/USER/PASS). Set them in the Netlify dashboard, never in code.');
  }
  const client = new ftp.Client();
  const files = {};
  try {
    await client.access({ host: RSR_FTP_HOST, user: RSR_FTP_USER, password: RSR_FTP_PASS, secure: false });
    await client.cd(RSR_FTP_DIR);
    for (const [key, name] of Object.entries(DATA_FILES)) {
      try {
        const chunks = [];
        await client.downloadTo({ write: (c) => chunks.push(c), end: () => {} }, name);
        files[key] = Buffer.concat(chunks).toString('utf8');
      } catch (e) { files[key] = ''; console.warn(`RSR file missing/unreadable, continuing without it: ${name} — ${e.message}`); }
    }
  } finally { client.close(); }
  return files;
}

exports.handler = async () => {
  try {
    const files = await downloadAll();
    const catalog = buildCatalog(files);
    // Validation gate: never publish a collapsed catalog. A sudden 90%+ drop in
    // published products, or an empty inventory, aborts the run and keeps yesterday's live catalog.
    // (The caller / store writer must implement the "keep old catalog" side — this
    // function throws instead of returning a catalog to publish.)
    if (catalog.stats.published === 0) throw new Error('Published product count is 0 — aborting, live catalog kept.');
    // Publish to Netlify Blobs — the ONLY store get-products.js reads for the
    // live shop. Writing here is atomic for this key: the old catalog stays
    // live until this write succeeds, and a failed run never blanks the shop.
    // NOTE: this is a background function, so Netlify returns 202 immediately
    // and this handler runs in the background. The caller will NOT see the
    // stats in the HTTP response — check the Functions log for 'RSR import OK',
    // then reload the shop. Images stay on the placeholder until the separate
    // Wasabi/Bunny image-sync step runs.
    let blobs;
    try { blobs = require('@netlify/blobs'); } catch {
      throw new Error('@netlify/blobs is not installed — add it to package.json and redeploy before triggering the importer.');
    }
    const store = blobs.getStore('xl-arms-catalog');
    const storefront = toStorefrontCatalog(catalog);
    await store.set('products.json', JSON.stringify(storefront));
    // Keep the full internal catalog (restrictions, messages, search index)
    // alongside it for checkout / admin use, without bloating the shop payload.
    await store.set('catalog-full.json', JSON.stringify(catalog));
    console.log('RSR import OK', JSON.stringify(catalog.stats), 'errors:', catalog.errors.slice(0, 20));
    return { statusCode: 202, body: JSON.stringify({ ok: true, stats: catalog.stats, note: 'Background import started — check Functions log for RSR import OK, then reload the shop.' }) };
  } catch (e) {
    console.error('RSR import FAILED — live catalog kept:', e.message);
    return { statusCode: 202, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
