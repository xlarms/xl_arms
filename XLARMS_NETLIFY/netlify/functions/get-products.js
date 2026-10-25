// Serves the shop via /api/products — PAGINATED, never the full catalog.
// Why: the live catalog is 26,298 products / ~6.29 MB as JSON. Netlify
// Functions crash with 'ResponseSizeTooLarge' over ~6 MB, so returning the
// whole catalog in one response crashes get-products, the shop then falls
// back to the 8-product sample file, and the user sees '8 products' even
// though the import succeeded. Fix: filter/score server-side and return
// only one page (default 48) + total + facets. The shop fetches pages.
// Priority: Netlify Blobs (written by rsr-import-background.js), fallback
// to data/products.json (starter sample) before the first import.
// Never query RSR FTP live from this function.
const fs = require('fs');
const path = require('path');

const SYNONYMS = { g19: ['glock', '19'], g17: ['glock', '17'], '9x19': ['9mm'], 9: ['9mm'] };
function canonicalCaliber(q) {
  return q
    .replace(/\b9\s*mm\b/g, '9mm').replace(/\b9\s*x\s*19\b/g, '9mm')
    .replace(/\.223\s*rem(?:ington)?\b/g, '223').replace(/\b223\s*rem(?:ington)?\b/g, '223')
    .replace(/\b12\s*ga(?:uge)?\b/g, '12ga').replace(/\b5\.56\s*nato\b/g, '5.56');
}
function tokens(q) {
  const parts = canonicalCaliber(String(q || '').toLowerCase().replace(/[^a-z0-9.\s]/g, ' ')).split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of parts) { if (SYNONYMS[p]) out.push(...SYNONYMS[p]); else out.push(p); }
  return [...new Set(out)];
}
function score(p, toks, raw) {
  const hay = [p.brand, p.model, p.title, p.category, p.caliber, p.caliber_canonical, p.sku, p.upc].join(' ').toLowerCase();
  if (raw && (String(p.sku).toLowerCase() === raw || String(p.upc) === raw)) return 1000;
  if (toks.length && toks.every((t) => hay.includes(t))) {
    let s = 500;
    if (hay.includes((p.brand + ' ' + p.model).toLowerCase())) s += 100;
    const modelFirst = (p.model || '').split(/\s+/)[0].toLowerCase();
    if (modelFirst && toks.includes(modelFirst)) s += 80;
    if (p.stock_qty > 0) s += 50;
    return s;
  }
  if (!toks.length) return p.stock_qty > 0 ? 50 : 0;
  const matched = toks.filter((t) => hay.includes(t)).length;
  if (matched === 0) return 0;
  return matched * 10 + (p.stock_qty > 0 ? 5 : 0);
}

async function loadCatalog(event) {
  try {
    const { getStore, connectLambda } = require('@netlify/blobs');
    try { connectLambda(event); } catch (e) { /* non-Lambda context */ }
    const live = await getStore('xl-arms-catalog').get('products.json', { type: 'json' });
    if (live && Array.isArray(live.products) && live.products.length > 0) return live.products;
  } catch (e) { console.warn('Blobs catalog not available, falling back to sample file:', e.message); }
  const file = path.join(__dirname, '..', '..', 'data', 'products.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).products || [];
}

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const all = await loadCatalog(event);
    // Single-product lookup for product.html — returns at most 1 product.
    if (q.sku) {
      const found = all.find((p) => String(p.sku).toLowerCase() === String(q.sku).toLowerCase());
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ products: found ? [found] : [], total: found ? 1 : 0, page: 1, pageSize: 1 }) };
    }
    let items = all;
    if (q.category) items = items.filter((p) => p.category === q.category);
    if (q.brand) items = items.filter((p) => p.brand === q.brand);
    if (q.caliber) items = items.filter((p) => p.caliber === q.caliber);
    if (q.inStock === '1' || q.inStock === 'true') items = items.filter((p) => p.stock_qty > 0);
    const raw = (q.q || '').trim().toLowerCase();
    const toks = raw ? tokens(raw) : [];
    if (raw) {
      items = items.map((p) => ({ p, s: score(p, toks, raw) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.p);
    } else if (q.sort === 'price-asc') items = [...items].sort((a, b) => a.price - b.price);
    else if (q.sort === 'price-desc') items = [...items].sort((a, b) => b.price - a.price);
    else items = [...items].sort((a, b) => (b.stock_qty > 0) - (a.stock_qty > 0));
    const total = items.length;
    const pageSize = Math.min(Math.max(parseInt(q.limit, 10) || 48, 1), 100);
    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    const pageProducts = items.slice((page - 1) * pageSize, page * pageSize);
    // Facets are computed from the FULL catalog (not just this page), but
    // they are only lists of names — a few KB, not the 6 MB catalog.
    const facets = {
      categories: [...new Set(all.map((p) => p.category).filter(Boolean))].sort(),
      brands: [...new Set(all.map((p) => p.brand).filter(Boolean))].sort(),
      calibers: [...new Set(all.map((p) => p.caliber).filter(Boolean))].sort(),
    };
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ products: pageProducts, total, page, pageSize, facets }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'catalog unavailable', detail: e.message }) };
  }
};
