// XL Arms search — starter implementation.
// Rules (see plan): exact SKU/UPC first, then brand+model, then all-terms narrowing.
// Caliber is canonicalised: 9 mm / 9x19 -> 9mm, .223 / 223 Rem -> 223, 5.56 -> 5.56, 12 gauge -> 12ga.
// Synonyms are expanded for the QUERY, never silently substituted across calibers.
const SYNONYMS = {
  'g19': ['glock', '19'],
  'g17': ['glock', '17'],
  '9x19': ['9mm'],
  '9': ['9mm'],
};
function canonicalCaliber(q) {
  return q
    .replace(/\b9\s*mm\b/g, '9mm')
    .replace(/\b9\s*x\s*19\b/g, '9mm')
    .replace(/\.223\s*rem(?:ington)?\b/g, '223')
    .replace(/\b223\s*rem(?:ington)?\b/g, '223')
    .replace(/\b12\s*ga(?:uge)?\b/g, '12ga')
    .replace(/\b5\.56\s*nato\b/g, '5.56');
}
function tokens(q) {
  let t = canonicalCaliber(q.toLowerCase().replace(/[^a-z0-9.\s]/g, ' '));
  let parts = t.split(/\s+/).filter(Boolean);
  let out = [];
  parts.forEach(p => {
    // Synonym replaces the original token (G19 -> glock + 19), so exact matching works.
    if (SYNONYMS[p]) out.push(...SYNONYMS[p]);
    else out.push(p);
  });
  return [...new Set(out)];
}
function score(p, toks, raw) {
  const hay = [p.brand, p.model, p.title, p.category, p.caliber, p.caliber_canonical, p.sku, p.upc].join(' ').toLowerCase();
  if (raw && (p.sku.toLowerCase() === raw || p.upc === raw)) return 1000;
  if (toks.every(t => hay.includes(t))) {
    let s = 500;
    if (hay.includes((p.brand + ' ' + p.model).toLowerCase())) s += 100;
    // Prefer the product whose model itself starts with a query token:
    // "Glock 17" -> the 17 Gen5 pistol, not the G17 magazine.
    const modelFirst = (p.model || '').split(/\s+/)[0].toLowerCase();
    if (modelFirst && toks.includes(modelFirst)) s += 80;
    if (p.stock_qty > 0) s += 50;
    return s;
  }
  // Partial: count matched tokens, but require at least one strong token (brand/model/caliber/sku)
  let matched = toks.filter(t => hay.includes(t)).length;
  if (matched === 0) return 0;
  return matched * 10 + (p.stock_qty > 0 ? 5 : 0);
}
async function loadProducts() {
  const res = await fetch('data/products.json');
  const data = await res.json();
  return data.products;
}
function money(n) { return '$' + Number(n).toFixed(2); }
function card(p) {
  const stock = p.stock_qty > 0
    ? `<span class="instock">In stock (${p.stock_qty})</span>`
    : `<span class="outstock">Out of stock</span>`;
  const ffl = p.is_firearm ? `<div class="meta">Ships to your FFL — not to your home.</div>` : '';
  return `<article class="card">
    <a href="product.html?sku=${encodeURIComponent(p.sku)}"><img src="${p.images[0]}" alt="${p.title}"></a>
    <h3><a href="product.html?sku=${encodeURIComponent(p.sku)}">${p.title}</a></h3>
    <div class="meta">${p.brand} · ${p.category}${p.caliber ? ' · ' + p.caliber : ''}</div>
    <div class="price">${money(p.price)}</div>
    <div>${stock}</div>${ffl}
  </article>`;
}
async function initShop() {
  const listEl = document.getElementById('results');
  const countEl = document.getElementById('count');
  const qEl = document.getElementById('q');
  const catEl = document.getElementById('category');
  const brandEl = document.getElementById('brand');
  const calEl = document.getElementById('caliber');
  const stockEl = document.getElementById('instock');
  const sortEl = document.getElementById('sort');
  if (!listEl) return;
  const products = await loadProducts();
  const cats = [...new Set(products.map(p => p.category))].sort();
  const brands = [...new Set(products.map(p => p.brand))].sort();
  const cals = [...new Set(products.map(p => p.caliber).filter(Boolean))].sort();
  cats.forEach(c => catEl.insertAdjacentHTML('beforeend', `<option>${c}</option>`));
  brands.forEach(b => brandEl.insertAdjacentHTML('beforeend', `<option>${b}</option>`));
  cals.forEach(c => calEl.insertAdjacentHTML('beforeend', `<option>${c}</option>`));
  // Autocomplete: simple suggestion list under search
  const sugg = document.getElementById('suggestions');
  function render() {
    const raw = (qEl.value || '').trim().toLowerCase();
    const toks = raw ? tokens(raw) : [];
    let items = products.filter(p => {
      if (catEl.value && p.category !== catEl.value) return false;
      if (brandEl.value && p.brand !== brandEl.value) return false;
      if (calEl.value && p.caliber !== calEl.value) return false;
      if (stockEl.checked && p.stock_qty <= 0) return false;
      return true;
    });
    if (raw) {
      items = items.map(p => ({ p, s: score(p, toks, raw) }))
        .filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.p);
    } else if (sortEl.value === 'price-asc') items.sort((a, b) => a.price - b.price);
    else if (sortEl.value === 'price-desc') items.sort((a, b) => b.price - a.price);
    else items.sort((a, b) => (b.stock_qty > 0) - (a.stock_qty > 0));
    countEl.textContent = items.length + ' product' + (items.length === 1 ? '' : 's');
    if (!items.length) {
      listEl.innerHTML = `<div class="banner"><strong>No exact match.</strong> Try a brand + model (e.g. Glock 19), a SKU, or a caliber. In the live store, zero-result searches are logged so we can add the missing synonym or product.</div>`;
    } else {
      listEl.innerHTML = items.map(card).join('');
    }
    if (sugg) {
      if (!raw) { sugg.innerHTML = ''; return; }
      const top = items.slice(0, 5).map(p => `<div><a href="product.html?sku=${encodeURIComponent(p.sku)}">${p.title} — ${money(p.price)}</a></div>`).join('');
      sugg.innerHTML = top ? `<div class="filters" style="margin-top:8px"><strong>Suggestions</strong>${top}</div>` : '';
    }
  }
  [qEl, catEl, brandEl, calEl, stockEl, sortEl].forEach(el => el.addEventListener('input', render));
  document.getElementById('searchForm').addEventListener('submit', e => { e.preventDefault(); render(); });
  render();
}
async function initProduct() {
  const el = document.getElementById('product');
  if (!el) return;
  const sku = new URLSearchParams(location.search).get('sku');
  const products = await loadProducts();
  const p = products.find(x => x.sku === sku) || products[0];
  const stock = p.stock_qty > 0 ? `<span class="instock">In stock (${p.stock_qty})</span>` : `<span class="outstock">Out of stock</span>`;
  const ffl = p.is_firearm
    ? `<div class="ffl"><strong>FFL transfer required.</strong> Firearms ship to a licensed dealer (FFL) of your choice for background check and pickup — not directly to your home. You will confirm your FFL during checkout. Payment gateway to be confirmed before launch — do not use this starter page for real checkout.</div>`
    : `<div class="ffl"><strong>Ships normally.</strong> Ammunition and accessories do not require an FFL transfer, but state shipping restrictions still apply at checkout.</div>`;
  el.innerHTML = `
    <p><a href="index.html">← Back to shop</a></p>
    <h2>${p.title}</h2>
    <img src="${p.images[0]}" alt="${p.title}" style="max-width:420px;width:100%;background:#f0ede6;border-radius:8px">
    <div class="price">${money(p.price)}</div><div>${stock}</div>${ffl}
    <table class="specs">
      <tr><th>Brand</th><td>${p.brand}</td></tr>
      <tr><th>Model</th><td>${p.model}</td></tr>
      <tr><th>Category</th><td>${p.category}</td></tr>
      ${p.caliber ? `<tr><th>Caliber / Gauge</th><td>${p.caliber}</td></tr>` : ''}
      ${p.action ? `<tr><th>Action</th><td>${p.action}</td></tr>` : ''}
      ${p.barrel_in ? `<tr><th>Barrel</th><td>${p.barrel_in}"</td></tr>` : ''}
      ${p.capacity ? `<tr><th>Capacity</th><td>${p.capacity}</td></tr>` : ''}
      ${p.finish ? `<tr><th>Finish</th><td>${p.finish}</td></tr>` : ''}
      <tr><th>SKU / RSR #</th><td>${p.sku}</td></tr>
      <tr><th>UPC</th><td>${p.upc}</td></tr>
    </table>
    <p>${p.description}</p>
    <p><em>Sample data — real RSR data, images, and checkout replace this page before launch.</em></p>`;
}
document.addEventListener('DOMContentLoaded', () => { initShop(); initProduct(); });
