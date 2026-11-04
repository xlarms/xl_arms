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

// PRE-INDEX (2026-11-04, pre-launch speed): list/search pages no longer
// reload the full ~6 MB Blobs catalog + image manifest on every request.
// Instead they read catalog-index.json bundled alongside this function —
// slim card fields only, images already joined, generated from the live
// API on 2026-11-04 (30,387 products, API pagination order preserved).
// Single-SKU lookups (product page) deliberately SKIP the index and use
// Blobs, so description / features / hi-res / Prop 65 stay full.
// If the index file is missing or empty, list pages fall back to the
// exact old Blobs path — a bad index can slow the shop, never break it.
async function loadIndex() {
  // Index is split into 4 parts (2026-11-04): GitHub's web upload choked
  // on the single 13.6 MB file, while 3.4 MB parts upload reliably.
  // Parts must load in order (1..4) — pagination order is preserved
  // across the split, so browse order matches the live API.
  try {
    const all = [];
    for (let i = 1; i <= 4; i++) {
      const raw = fs.readFileSync(path.join(__dirname, `catalog-index-${i}.json`), 'utf8');
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.products) || data.products.length === 0) return null;
      all.push(...data.products);
    }
    if (all.length > 0) return all;
  } catch (e) { /* no usable index — fall through to Blobs */ }
  return null;
}
async function loadCatalog(event, useIndex) {
  if (useIndex) {
    const indexed = await loadIndex();
    if (indexed) return { products: indexed, fromIndex: true };
  }
  try {
    const { getStore, connectLambda } = require('@netlify/blobs');
    try { connectLambda(event); } catch (e) { /* non-Lambda context */ }
    const live = await getStore('xl-arms-catalog').get('products.json', { type: 'json' });
    if (live && Array.isArray(live.products) && live.products.length > 0) return { products: live.products, fromIndex: false };
  } catch (e) { console.warn('Blobs catalog not available, falling back to sample file:', e.message); }
  const file = path.join(__dirname, '..', '..', '..', 'data', 'products.json');
  return { products: JSON.parse(fs.readFileSync(file, 'utf8')).products || [], fromIndex: false };
}

// Image manifest (written by image-sync-background.js): { images: { SKU: { count, hiCount } } }.
// Best-effort — a missing manifest just means placeholders stay.
async function loadImageManifest(event) {
  try {
    const { getStore, connectLambda } = require('@netlify/blobs');
    try { connectLambda(event); } catch (e) { /* non-Lambda context */ }
    const m = await getStore('xl-arms-catalog').get('images.json', { type: 'json' });
    if (m && m.images && typeof m.images === 'object') return m;
  } catch (e) { /* no manifest yet */ }
  return null;
}

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const useIndex = !q.sku; // product page needs the full record — see loadCatalog
    const loaded = await loadCatalog(event, useIndex);
    const all = loaded.products.map(cleanProduct);
    // Image manifest join (added 2026-10-26): SKUs the image sync has
    // uploaded get real Bunny URLs; everything else keeps the placeholder.
    // Never another product's photo, never a guessed URL.
    // Skipped for index loads — the index already carries joined images,
    // and skipping the second Blobs call is part of the speed win.
    const bunnyHost = loaded.fromIndex ? '' : (process.env.BUNNY_HOSTNAME || '');
    if (bunnyHost) {
      const manifest = await loadImageManifest(event);
      if (manifest) {
        const prefix = process.env.IMAGE_PREFIX || manifest.prefix || 'products';
        const hiPrefix = process.env.IMAGE_HI_PREFIX || manifest.hiPrefix || (prefix + '-hi');
        for (const p of all) {
          const entry = manifest.images[p.sku];
          if (entry && entry.count > 0) {
            p.images = [];
            for (let n = 1; n <= entry.count; n++) p.images.push(`https://${bunnyHost}/${prefix}/${p.sku}/${n}.jpg`);
            // High-res twins for the product-page lightbox only (added
            // 2026-10-26). Absent when the SKU has no hi images — the page
            // falls back to the standard URLs.
            if (entry.hiCount > 0) {
              p.hires = [];
              for (let n = 1; n <= entry.hiCount; n++) p.hires.push(`https://${bunnyHost}/${hiPrefix}/${p.sku}/${n}.jpg`);
            }
          }
        }
      }
    }
    // Single-product lookup for product.html — returns at most 1 product.
    if (q.sku) {
      const found = all.find((p) => String(p.sku).toLowerCase() === String(q.sku).toLowerCase());
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ products: found ? [found] : [], total: found ? 1 : 0, page: 1, pageSize: 1 }) };
    }
    let items = all;
    const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    // Order matters for facets (not for results — these filters commute):
    // category + word search first, then snapshot the facet base, then the
    // facet filters. So facet lists reflect the current category/search
    // instead of the whole catalog (picking Handguns no longer offers
    // ammunition-only brands), while a chosen facet never empties its own list.
    if (q.category) items = items.filter((p) => eq(p.category, q.category));
    const raw = (q.q || '').trim().toLowerCase();
    const toks = raw ? tokens(raw) : [];
    if (raw) {
      items = items.map((p) => ({ p, s: score(p, toks, raw) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.p);
    }
    // Shop pools (2026-11-01): RSR has no 'Shotguns'/'Rifles' category —
    // both live under 'Long Guns', split by subCategory. A q=shotgun /
    // q=rifle search only returns 104 / accessory-heavy items, so the
    // Shotguns/Rifles pages use ?shop=shotguns|rifles instead. Applied
    // BEFORE the facet snapshot, so sidebar facets are pool-only.
    // Lower Receivers are in neither pool (parts, not complete guns).
    const SHOP_POOLS = {
      shotguns: ['Defensive Shotguns', 'Sporting Shotguns'],
      rifles: ['AK Style Rifles', 'Bullpups', 'Hunting Rifles', 'Modern Sporting Rifles', 'Surplus/Replica Rifles'],
    };
    if (q.shop && SHOP_POOLS[q.shop]) {
      const pool = SHOP_POOLS[q.shop];
      items = items.filter((p) => eq(p.category, 'Long Guns') && pool.includes(p.subCategory));
    }
    const facetBase = items;
    if (q.brand) items = items.filter((p) => eq(p.brand, q.brand));
    if (q.caliber) items = items.filter((p) => normCaliber(p.caliber) === normCaliber(q.caliber) || normCaliber(p.caliber_canonical) === normCaliber(q.caliber) || eq(p.caliber, q.caliber));
    // Detailed sidebar filters (added 2026-10-26). Fields absent from an
    // older catalog (pre-re-import) simply match nothing for that facet.
    if (q.action) items = items.filter((p) => eq(p.action, q.action));
    if (q.finish) items = items.filter((p) => eq(p.finish, q.finish));
    if (q.type) items = items.filter((p) => eq(p.type, q.type));
    if (q.subCategory) items = items.filter((p) => eq(p.subCategory, q.subCategory));
    if (q.frame) items = items.filter((p) => eq(p.frame, q.frame));
    if (q.grips) items = items.filter((p) => eq(p.grips, q.grips));
    if (q.color) items = items.filter((p) => eq(p.color, q.color));
    if (q.material) items = items.filter((p) => eq(p.material, q.material));
    if (q.size) items = items.filter((p) => eq(p.size, q.size));
    if (q.capacity) items = items.filter((p) => p.capacity != null && p.capacity === parseInt(q.capacity, 10));
    if (q.barrel) items = items.filter((p) => p.barrel_in != null && Math.abs(p.barrel_in - parseFloat(q.barrel)) < 0.001);
    if (q.priceMin) items = items.filter((p) => (p.price || 0) >= parseFloat(q.priceMin));
    if (q.priceMax) items = items.filter((p) => (p.price || 0) <= parseFloat(q.priceMax));
    if (q.isNew === '1' || q.isNew === 'true') {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
      items = items.filter((p) => p.date_entered && String(p.date_entered) >= cutoff);
    }
    if (q.closeout === '1' || q.closeout === 'true') items = items.filter((p) => p.closeout === true);
    if (q.inStock === '1' || q.inStock === 'true') items = items.filter((p) => p.stock_qty > 0);
    if (!raw) {
      if (q.sort === 'price-asc') items = [...items].sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
      else if (q.sort === 'price-desc') items = [...items].sort((a, b) => (b.price || 0) - (a.price || 0));
      else if (q.sort === 'newest') items = [...items].sort((a, b) => String(b.date_entered || '').localeCompare(String(a.date_entered || '')));
      else items = [...items].sort((a, b) => (b.stock_qty > 0) - (a.stock_qty > 0));
    }
    const total = items.length;
    const pageSize = Math.min(Math.max(parseInt(q.limit, 10) || 48, 1), 100);
    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    const pageProducts = items.slice((page - 1) * pageSize, page * pageSize);
    // 2026-11-03 speed: list pages only need card fields. Stripping the
    // description/features/hi-res URLs from list responses cuts the
    // 100-product payload from ~242KB to roughly a third, and sorting
    // already happened above, so dropping fields here changes no order.
    // Single-SKU lookups (product page) keep the full record.
    const slim = (p) => ({ sku: p.sku, title: p.title, price: p.price, stock_qty: p.stock_qty, brand: p.brand, model: p.model, category: p.category, subCategory: p.subCategory, caliber: p.caliber, caliber_canonical: p.caliber_canonical, action: p.action, barrel_in: p.barrel_in, capacity: p.capacity, finish: p.finish, is_firearm: p.is_firearm, images: p.images });
    const slimProducts = pageProducts.map(slim);
    // Facets are value lists (not the 6 MB catalog) from the facet base
    // above. Groups with no values are hidden by the sidebar UI — this is
    // what keeps the new facet groups invisible until the re-import that
    // publishes those fields.
    const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
    const uniqNum = (arr) => [...new Set(arr.filter((v) => v != null))].sort((a, b) => a - b);
    const facets = {
      categories: uniq(facetBase.map((p) => p.category)),
      brands: uniq(facetBase.map((p) => p.brand)),
      calibers: uniq(facetBase.map((p) => p.caliber)),
      actions: uniq(facetBase.map((p) => p.action)),
      finishes: uniq(facetBase.map((p) => p.finish)),
      types: uniq(facetBase.map((p) => p.type)),
      subCategories: uniq(facetBase.map((p) => p.subCategory)),
      frames: uniq(facetBase.map((p) => p.frame)),
      grips: uniq(facetBase.map((p) => p.grips)),
      colors: uniq(facetBase.map((p) => p.color)),
      materials: uniq(facetBase.map((p) => p.material)),
      sizes: uniq(facetBase.map((p) => p.size)),
      capacities: uniqNum(facetBase.map((p) => p.capacity)),
      barrels: uniqNum(facetBase.map((p) => p.barrel_in)),
    };
    // CDN cache for list pages only (2026-11-03): identical searches within
    // 5 minutes serve from the edge instead of reloading the catalog.
    // Stock/prices can lag up to 5 minutes — acceptable for browsing, and
    // single-SKU lookups and cart checks are never cached this way.
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=0, s-maxage=300', 'Netlify-CDN-Cache-Control': 'public, max-age=300, stale-while-revalidate=60' }, body: JSON.stringify({ products: slimProducts, total, page, pageSize, facets }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'catalog unavailable', detail: e.message }) };
  }
};
