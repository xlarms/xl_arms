// Serves the live catalog to the shop (via /api/products in netlify.toml).
// Priority: Netlify Blobs (written by rsr-import-background.js) — this is the
// live RSR catalog. Fallback: data/products.json (the starter sample file),
// so the shop still works before the first successful import.
// Never query RSR FTP live from this function.
const fs = require('fs');
const path = require('path');
exports.handler = async () => {
  try {
    try {
      const { getStore } = require('@netlify/blobs');
      const store = getStore('xl-arms-catalog');
      const live = await store.get('products.json', { type: 'json' });
      if (live && Array.isArray(live.products) && live.products.length > 0) {
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(live) };
      }
    } catch (e) { console.warn('Blobs catalog not available, falling back to sample file:', e.message); }
    const file = path.join(__dirname, '..', '..', 'data', 'products.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'catalog unavailable' }) };
  }
};
