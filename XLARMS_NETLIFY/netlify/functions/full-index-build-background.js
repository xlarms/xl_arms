// PRODUCT-PAGE PRE-INDEX BUILDER (2026-11-04, pre-launch speed part 2).
// Why: list/search pages got fast with the bundled slim index, but a
// product page still loads the full ~6 MB Blobs catalog + image manifest
// on every SKU lookup (~3s). This builder splits the FULL catalog into
// small per-letter chunks in Blobs, so a product-page lookup loads only
// the chunk for that SKU's first letter (~1/26th of the catalog) instead
// of everything. No GitHub upload of a huge file is needed — the chunks
// are written by this function itself, on Netlify, from the live catalog.
// How to use:
//   1. Upload this file + the updated get-products function, deploy.
//   2. Trigger once: /.netlify/functions/full-index-build-background
//      (background function — returns 202; the run continues on Netlify).
//   3. Verify: /.netlify/functions/get-products?sku=TI2-D4551 should
//      return in well under the old ~3s, and full-index-meta.json in
//      Blobs (readable via a small check, or from the function log)
//      should show total 30,387 across the chunks.
//   4. Re-trigger after every future catalog import, or product pages
//      will lag the live catalog exactly like the list index does.
// Safety: this builder NEVER touches products.json or images.json —
// it only writes full-index-*.json keys. If a chunk is missing, the
// product-page lookup falls back to the full catalog load, so a bad
// build slows the page, never breaks it.
exports.handler = async (event) => {
  try {
    const blobs = require('@netlify/blobs');
    try { blobs.connectLambda(event); } catch (e) { /* non-Lambda context */ }
    const store = blobs.getStore('xl-arms-catalog');
    const live = await store.get('products.json', { type: 'json' });
    if (!live || !Array.isArray(live.products) || live.products.length === 0) {
      return { statusCode: 202, body: JSON.stringify({ ok: false, error: 'products.json in Blobs is empty or missing — nothing built, live catalog untouched.' }) };
    }
    // Join images/hires exactly like get-products does, so chunk records
    // are complete product-page records, not slim cards.
    let manifest = null;
    try { manifest = await store.get('images.json', { type: 'json' }); } catch (e) { /* no manifest yet */ }
    const bunnyHost = process.env.BUNNY_HOSTNAME || '';
    const prefix = process.env.IMAGE_PREFIX || (manifest && manifest.prefix) || 'products';
    const hiPrefix = process.env.IMAGE_HI_PREFIX || (manifest && manifest.hiPrefix) || (prefix + '-hi');
    const chunks = {};
    for (const p of live.products) {
      const sku = String(p.sku || '');
      if (!sku) continue;
      const first = sku[0].toUpperCase();
      const key = /^[A-Z]$/.test(first) ? first : '0';
      if (bunnyHost && manifest && manifest.images && manifest.images[sku] && manifest.images[sku].count > 0) {
        const entry = manifest.images[sku];
        p.images = [];
        for (let n = 1; n <= entry.count; n++) p.images.push(`https://${bunnyHost}/${prefix}/${sku}/${n}.jpg`);
        if (entry.hiCount > 0) {
          p.hires = [];
          for (let n = 1; n <= entry.hiCount; n++) p.hires.push(`https://${bunnyHost}/${hiPrefix}/${sku}/${n}.jpg`);
        }
      }
      if (!chunks[key]) chunks[key] = [];
      chunks[key].push(p);
    }
    const counts = {};
    for (const [key, arr] of Object.entries(chunks)) {
      await store.set(`full-index-${key}.json`, JSON.stringify({ chunk: key, products: arr }));
      counts[key] = arr.length;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    await store.set('full-index-meta.json', JSON.stringify({ generated_at: new Date().toISOString(), total, chunks: counts }));
    return { statusCode: 202, body: JSON.stringify({ ok: true, total, chunks: counts, note: 'Full-index chunks written to Blobs. Product-page lookups will use them; missing chunks fall back to the full catalog.' }) };
  } catch (e) {
    return { statusCode: 202, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
