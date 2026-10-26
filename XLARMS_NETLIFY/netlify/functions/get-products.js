// Serves the shop via /api/products — PAGINATED, never the full catalog.
// Why: the live catalog is 26,298 products / ~6.29 MB as JSON. Netlify
// Functions crash with 'ResponseSizeTooLarge' over ~6 MB, so returning the
// whole catalog in one response crashes get-products, the shop then falls
// back to the 8-product sample file, and the user sees '8 products' even
// though the import succeeded. Fix: filter/score server-side and return
// only one page (default 48) + total + facets. The shop fetches pages.
// Priority: Netlify Blobs (written by the background importer), fallback
// to data/products.json (starter sample) before the first import.
// Never query the supplier feed live from this function.
const fs = require('fs');
const path = require('path');

// CLEAN ON READ (2026-10-25): the catalog already in Blobs was built before
// the importer cleaning above, so it still contains polluted values:
//   category "Dept ACC741C_1.jpg" (image filename, not a department)
//   caliber "12 Gauge 2.75;;#4;;Federal;..." (a whole shell attribute string)
// Cleaning here makes the live shop correct on redeploy alone, with no
// re-import needed. The next import will produce clean values at source too.
//   category: "Dept" / "Dept <anything>" -> "Other"
//   caliber: first ';' segment only; gauges collapse to base gauge.
function cleanCategory(cat) {
  if (!cat) return '';
  if (cat === 'Dept' || String(cat).startsWith('Dept ')) return 'Other';
  return cat;
}
function cleanCaliber(cal) {
  if (!cal) return '';
  const first = String(cal).split(';')[0].trim();
  const gauge = first.match(/^(\d+)\s*(?:gauge|ga\.?)\b/i);
  if (gauge) return `${gauge[1]} Gauge`;
  if (/^410\s*bore/i.test(first)) return '410 Bore';
  return first;
}
const JUNK_CALIBERS = new Set(['barrels', 'rings', 'synthetic', 'walnut', 'weaver', 'wood', 'modern sporting rifles', 'multi', 'n/a']);
function cleanCaliberValue(cal) {
  const c = cleanCaliber(cal);
  if (!c) return '';
  if (/\.jpg$/i.test(c) || c.includes('_')) return ''; // image filenames leaking into caliber
  const low = c.toLowerCase();
  if (JUNK_CALIBERS.has(low)) return ''; // finish/material words, not calibers
  if (/^[A-Za-z]{2,}-[A-Za-z0-9-]+$/.test(c)) return ''; // SKU-like codes: PYTHON-BP4WTS, XD940-4, ACC-FIX-BARREL-8.6-8IN
  if (/^[A-Za-z]+\d[A-Za-z0-9]*$/.test(c)) return ''; // A10SBF2, DB1721K001
  if (/^\d{3,}[A-Za-z]+\d+$/.test(c)) return ''; // 1784V001
  return c;
}
function cleanProduct(p) {
  return {
    ...p,
    category: cleanCategory(p.category),
    caliber: cleanCaliberValue(p.caliber),
    // Brand values that are image filenames (feed pollution) are not brands.
    brand: /\.jpg$/i.test(p.brand || '') ? '' : p.brand,
  };
}
// Caliber normalisation for FILTER matching (not display): 9MM, 9mm Luger,
// 9x19 and 9x19mm are the same caliber, as are 556NATO and 5.56. The old
// code compared the raw display string, so picking "9MM" missed every
// pistol whose caliber was recorded as "9mm Luger".
function normCaliber(s) {
  let t = String(s || '').toLowerCase().replace(/×/g, 'x').replace(/[\s.]/g, '');
  const map = { '9x19': '9mm', '9x19mm': '9mm', '9mmluger': '9mm', '9mmparabellum': '9mm', '556x45': '556', '556nato': '556', '223rem': '223', '223remington': '223', '12gauge': '12ga', '20gauge': '20ga', '410bore': '410' };
  return map[t] || t;
}

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
  if (raw && (String(p.sku).toLowerCase() === raw || String(p.upc) === raw)) return 1000;
  // Word-boundary matching on brand/model/title/category/caliber only.
  // The old substring match on the whole haystack (including SKU/UPC) let
  // "19" match inside a UPC like 813119... and outrank real Glock 19 items.
  const words = new Set([p.brand, p.model, p.title, p.category, p.caliber, p.caliber_canonical].join(' ').toLowerCase().replace(/\./g, '').split(/[^a-z0-9]+/).filter(Boolean));
  const has = (t) => words.has(String(t).replace(/\./g, ''));
  const normToks = toks.map((t) => String(t).replace(/\./g, ''));
  if (toks.length && toks.every(has)) {
    let s = 500;
    const bmWords = (p.brand + ' ' + p.model).toLowerCase().replace(/\./g, '').split(/[^a-z0-9]+/).filter(Boolean);
    if (bmWords.length && bmWords.every((w) => normToks.includes(w))) s += 100;
    const modelFirst = (p.model || '').split(/\s+/)[0].toLowerCase();
    if (modelFirst && normToks.includes(modelFirst)) s += 80;
    if (p.stock_qty > 0) s += 50;
    return s;
  }
  if (!toks.length) return p.stock_qty > 0 ? 50 : 0;
  const matched = toks.filter(has).length;
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
    const all = (await loadCatalog(event)).map(cleanProduct);
    // Single-product lookup for product.html — returns at most 1 product.
    if (q.sku) {
      const found = all.find((p) => String(p.sku).toLowerCase() === String(q.sku).toLowerCase());
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ products: found ? [found] : [], total: found ? 1 : 0, page: 1, pageSize: 1 }) };
    }
    let items = all;
    const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    if (q.category) items = items.filter((p) => eq(p.category, q.category));
    if (q.brand) items = items.filter((p) => eq(p.brand, q.brand));
    if (q.caliber) items = items.filter((p) => normCaliber(p.caliber) === normCaliber(q.caliber) || normCaliber(p.caliber_canonical) === normCaliber(q.caliber) || eq(p.caliber, q.caliber));
    if (q.inStock === '1' || q.inStock === 'true') items = items.filter((p) => p.stock_qty > 0);
    const raw = (q.q || '').trim().toLowerCase();
    const toks = raw ? tokens(raw) : [];
    if (raw) {
      items = items.map((p) => ({ p, s: score(p, toks, raw) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.p);
    } else if (q.sort === 'price-asc') items = [...items].sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
    else if (q.sort === 'price-desc') items = [...items].sort((a, b) => (b.price || 0) - (a.price || 0));
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
