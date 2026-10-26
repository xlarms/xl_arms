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
  // NOTE (slimmed 2026-10-26): fulfillment-inv-new.txt is INTENTIONALLY not
  // downloaded. It is reference-only, buildCatalog never parses it (Jonathan:
  // main inventory only), and downloading it cost ~7 MB of memory plus FTP
  // time on every run. Re-add it here if a future step ever needs it.
};

async function downloadAll() {
  let ftp;
  try { ftp = require('basic-ftp'); } catch {
    throw new Error('FTP client not installed: run `npm i basic-ftp` and set RSR_FTP_HOST/USER/PASS in Netlify env vars.');
  }
  // FIX 2026-10-25: basic-ftp's downloadTo() needs a real Writable stream
  // (or a file path) as its destination — not a plain {write, end} object.
  // The old object caused 'destination.once is not a function' for every
  // file, so every download was skipped and the inventory came back empty.
  const { Writable } = require('stream');
  async function downloadOne(client, name) {
    const chunks = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    });
    await client.downloadTo(writable, name);
    return Buffer.concat(chunks).toString('utf8');
  }
  const { RSR_FTP_HOST, RSR_FTP_USER, RSR_FTP_PASS, RSR_FTP_DIR = 'ftpdownloads' } = process.env;
  // RSR FTP port is 2222, NOT the FTP default 21. Earlier runs connected to
  // :21 (because no port was set) and timed out — that was the 2026-10-25
  // ETIMEDOUT failure, not a password or IP problem. Default is 2222 here,
  // with RSR_FTP_PORT as an override in Netlify if RSR ever changes it.
  const RSR_FTP_PORT = parseInt(process.env.RSR_FTP_PORT || '2222', 10);
  if (!RSR_FTP_HOST || !RSR_FTP_USER || !RSR_FTP_PASS) {
    throw new Error('RSR FTP env vars missing (RSR_FTP_HOST/USER/PASS). Set them in the Netlify dashboard, never in code.');
  }
  const client = new ftp.Client();
  const files = {};
  try {
    // RSR requires EXPLICIT TLS (FTPS) — confirmed by Jonathan 2026-10-25
    // from FileZilla. secure:false (plain FTP) will be dropped. secure:true
    // in basic-ftp is explicit FTPS (AUTH TLS), which matches FileZilla's
    // 'Require explicit FTP over TLS' setting.
    await client.access({ host: RSR_FTP_HOST, user: RSR_FTP_USER, password: RSR_FTP_PASS, port: RSR_FTP_PORT, secure: true });
    await client.cd(RSR_FTP_DIR);
    for (const [key, name] of Object.entries(DATA_FILES)) {
      try {
        files[key] = await downloadOne(client, name);
      } catch (e) { files[key] = ''; console.warn(`RSR file missing/unreadable, continuing without it: ${name} — ${e.message}`); }
    }
  } finally { client.close(); }
  return files;
}

exports.handler = async (event) => {
  try {
    // Netlify Blobs in Lambda-compatibility mode (exports.handler): the
    // Blobs credentials Netlify provides are NOT loaded automatically.
    // connectLambda(event) must run before getStore(), otherwise getStore()
    // throws 'The environment has not been configured to use Netlify Blobs'
    // — exactly the 2026-10-25 19:20 failure. Do NOT pass siteID/token to
    // getStore() in code running on Netlify; that replaces the provided creds.
    try { require('@netlify/blobs').connectLambda(event); } catch (e) { console.warn('connectLambda skipped:', e.message); }
    let files = await downloadAll();
    let catalog = buildCatalog(files);
    // Validation gate: never publish a collapsed catalog. A sudden 90%+ drop in
    // published products, or an empty inventory, aborts the run and keeps yesterday's live catalog.
    // (The caller / store writer must implement the "keep old catalog" side — this
    // function throws instead of returning a catalog to publish.)
    if (catalog.stats.published === 0) throw new Error('Published product count is 0 — aborting, live catalog kept.');
    const stats = catalog.stats;
    const importErrors = catalog.errors;
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
    // MEMORY (slimmed 2026-10-26): release the heavy internal catalog and the
    // raw files BEFORE stringifying/publishing. Holding both the internal
    // catalog and the storefront copy at once was a large share of the
    // ~1,018 MB peak; the storefront array is all the shop needs.
    catalog = null; files = null;
    await store.set('products.json', JSON.stringify(storefront));
    // NOTE: the full internal catalog (restrictions, messages, search index)
    // is intentionally NOT written as a second giant Blob here — the first
    // successful run already used 705 MB holding both copies in memory.
    // Restrictions/messages will be stored separately (per-SKU or as a
    // compact file) when checkout is built; the shop only needs products.json.
    console.log('RSR import OK', JSON.stringify(stats), 'errors:', importErrors.slice(0, 20));
    return { statusCode: 202, body: JSON.stringify({ ok: true, stats, note: 'Background import started — check Functions log for RSR import OK, then reload the shop.' }) };
  } catch (e) {
    console.error('RSR import FAILED — live catalog kept:', e.message);
    return { statusCode: 202, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
