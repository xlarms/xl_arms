// XL Arms shop — SERVER-DRIVEN search (paginated).
// Why server-driven: the live catalog is 26,298 products / ~6.29 MB.
// Netlify Functions crash over ~6 MB per response, so the shop must NEVER
// fetch the whole catalog. /api/products (get-products.js) filters/scores
// server-side and returns only one page (48) + total + facets.
// Rules: exact SKU/UPC first, then brand+model, then all-terms narrowing.
// Caliber canonicalised: 9 mm / 9x19 -> 9mm, .223 / 223 Rem -> 223, 5.56 -> 5.56, 12 gauge -> 12ga.
// Synonyms expand the QUERY, never silently substitute across calibers.
const SYNONYMS = { g19: ['glock', '19'], g17: ['glock', '17'], '9x19': ['9mm'], 9: ['9mm'] };
function canonicalCaliber(q) {
  return q.replace(/\b9\s*mm\b/g, '9mm').replace(/\b9\s*x\s*19\b/g, '9mm')
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
  return matched === 0 ? 0 : matched * 10 + (p.stock_qty > 0 ? 5 : 0);
}
function money(n) { return '$' + Number(n).toFixed(2); }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
/* Cart: front-end only, stored in the browser (localStorage). No order is
   placed and no payment is taken here — checkout is still to be wired once
   a firearms-friendly gateway is approved in writing. */
function getCart() { try { return JSON.parse(localStorage.getItem('xl_cart') || '[]'); } catch (e) { return []; } }
function saveCart(c) { try { localStorage.setItem('xl_cart', JSON.stringify(c)); } catch (e) {} updateCartBadge(); }
function updateCartBadge() {
  const n = getCart().reduce((a, i) => a + (i.qty || 1), 0);
  document.querySelectorAll('#cartCount').forEach((el) => { el.textContent = n; });
}
async function addToCart(sku) {
  let p = null;
  try {
    const res = await fetch('/api/products?sku=' + encodeURIComponent(sku));
    if (res.ok) { const d = await res.json(); p = (d.products || [])[0] || null; }
  } catch (e) {}
  if (!p) {
    try { const r = await fetch('data/products.json'); const d = await r.json(); p = (d.products || []).find((x) => x.sku === sku) || null; } catch (e) {}
  }
  if (!p) return;
  const cart = getCart();
  const line = cart.find((i) => i.sku === p.sku);
  if (line) line.qty += 1; else cart.push({ sku: p.sku, title: p.title, price: p.price, image: (p.images || [])[0] || 'images/placeholder.svg', is_firearm: !!p.is_firearm, qty: 1 });
  saveCart(cart);
  updateCartBadge();
  alert('Added to cart: ' + p.title);
}
function clearCart() { saveCart([]); initCartPage(); }
function cartQty(sku, d) {
  const cart = getCart(); const line = cart.find((i) => i.sku === sku);
  if (!line) return; line.qty += d; if (line.qty <= 0) cart.splice(cart.indexOf(line), 1);
  saveCart(cart); initCartPage();
}
function cartRemove(sku) { saveCart(getCart().filter((i) => i.sku !== sku)); initCartPage(); }
function initCartPage() {
  const el = document.getElementById('cartItems'); if (!el) return;
  const cart = getCart();
  const totalEl = document.getElementById('cartTotal');
  if (!cart.length) { el.innerHTML = '<p>Your cart is empty.</p><p><a class="btn" href="shop.html">Shop all products →</a></p>'; if (totalEl) totalEl.textContent = ''; return; }
  let total = 0;
  el.innerHTML = cart.map((i) => { total += i.price * i.qty; return `<div class="cartitem"><img src="${esc(i.image)}" alt=""><div><strong>${esc(i.title)}</strong><div class="meta">${esc(i.sku)}${i.is_firearm ? ' · Ships to your FFL' : ''}</div><div>${money(i.price)} × <button onclick="cartQty('${esc(i.sku)}',-1)">−</button> ${i.qty} <button onclick="cartQty('${esc(i.sku)}',1)">+</button> <button onclick="cartRemove('${esc(i.sku)}')">Remove</button></div></div><div class="price">${money(i.price * i.qty)}</div></div>`; }).join('');
  if (totalEl) totalEl.textContent = 'Subtotal: ' + money(total);
}
/* Featured products (homepage): first in-stock products, one per category
   where possible, so the strip looks like a store front, not a full grid. */
async function initFeatured() {
  const el = document.getElementById('featuredResults'); if (!el) return;
  let items = [];
  try {
    const res = await fetch('/api/products?inStock=1&limit=100&page=1');
    if (res.ok) { const d = await res.json(); items = d.products || []; }
  } catch (e) {}
  if (!items.length) {
    try { const r = await fetch('data/products.json'); const d = await r.json(); items = (d.products || []).filter((p) => p.stock_qty > 0); } catch (e) {}
  }
  // Curated variety, not the first page of the catalog (which was all holsters):
  // a pistol, a red dot, a bag, a shotgun, an AR-15, then more mixed picks.
  const hay = (p) => [p.title, p.brand, p.model, p.category, p.caliber].join(' ').toLowerCase();
  const picked = [];
  const take = (pred) => { const p = items.find((x) => !picked.includes(x) && pred(x)); if (p) picked.push(p); };
  take((p) => p.category === 'Handguns' || hay(p).includes('pistol'));
  take((p) => hay(p).includes('red dot') || hay(p).includes('reflex') || (hay(p).includes('dot') && p.category === 'Optics') || p.category === 'Optics');
  take((p) => /soft cases|packs|bags/.test(p.category) || /range bag|backpack|duffel|gun bag/.test(hay(p)));
  take((p) => p.category === 'Shotguns' || hay(p).includes('shotgun'));
  take((p) => hay(p).includes('ar-15') || hay(p).includes('ar15'));
  // Fill to 8 with new categories first, never a second 1791 holster.
  for (const p of items) {
    if (picked.length >= 8) break;
    if (!picked.includes(p) && !picked.some((q) => q.category === p.category) && p.brand !== '1791') picked.push(p);
  }
  for (const p of items) {
    if (picked.length >= 8) break;
    if (!picked.includes(p) && p.brand !== '1791') picked.push(p);
  }
  el.innerHTML = picked.map(card).join('') || '<p>Featured products could not be loaded right now.</p>';
}
function card(p) {
  const stock = p.stock_qty > 0 ? `<span class="instock">In stock (${p.stock_qty})</span>` : `<span class="outstock">Out of stock</span>`;
  const ffl = p.is_firearm ? `<div class="meta">Ships to your FFL — not to your home.</div>` : '';
  const sku = String(p.sku).replace(/'/g, "\\'");
  return `<article class="card">
    <a href="product.html?sku=${encodeURIComponent(p.sku)}"><img src="${p.images[0]}" alt="${p.title}"></a>
    <h3><a href="product.html?sku=${encodeURIComponent(p.sku)}">${p.title}</a></h3>
    <div class="meta">${p.brand} · ${p.category}${p.caliber ? ' · ' + p.caliber : ''}</div>
    <div class="price">${money(p.price)}</div>
    <div>${stock}</div>${ffl}
    <button class="btn btn-cart" onclick="addToCart('${sku}')">Add to Cart</button>
  </article>`;
}
async function initShop() {
  const listEl = document.getElementById('results');
  const countEl = document.getElementById('count');
  const pageEl = document.getElementById('pagination');
  const qEl = document.getElementById('q');
  const catEl = document.getElementById('category');
  const brandEl = document.getElementById('brand');
  const calEl = document.getElementById('caliber');
  const stockEl = document.getElementById('instock');
  const sortEl = document.getElementById('sort');
  if (!listEl) return;
  let page = 1, totalPages = 1, facetsLoaded = false, fallbackProducts = null;
  function setOptions(el, values, label) {
    const cur = el.value;
    el.innerHTML = `<option value="">${label}</option>` + values.map((v) => `<option>${v}</option>`).join('');
    if (values.includes(cur)) el.value = cur;
  }
  async function render() {
    const params = new URLSearchParams({
      q: qEl.value || '', category: catEl.value || '', brand: brandEl.value || '',
      caliber: calEl.value || '', inStock: stockEl.checked ? '1' : '',
      sort: sortEl.value === 'price-asc' ? 'price-asc' : sortEl.value === 'price-desc' ? 'price-desc' : '',
      page: String(page), limit: '48',
    });
    let data = null;
    try {
      const res = await fetch('/api/products?' + params.toString());
      if (res.ok) data = await res.json();
    } catch (e) { /* fall through to sample fallback */ }
    if (data && typeof data.total === 'number') {
      if (!facetsLoaded && data.facets) {
        setOptions(catEl, data.facets.categories, 'All categories');
        setOptions(brandEl, data.facets.brands, 'All brands');
        setOptions(calEl, data.facets.calibers, 'All calibers');
        facetsLoaded = true;
      }
      totalPages = Math.max(1, Math.ceil(data.total / (data.pageSize || 48)));
      countEl.textContent = data.total + ' product' + (data.total === 1 ? '' : 's') + (data.total > 48 ? ` — page ${data.page} of ${totalPages}` : '');
      listEl.innerHTML = data.products.length
        ? data.products.map(card).join('')
        : `<div class="banner"><strong>No exact match.</strong> Try a brand + model (e.g. Glock 19), a SKU, or a caliber.</div>`;
      const sugg = document.getElementById('suggestions');
      if (sugg) {
        const raw = (qEl.value || '').trim();
        sugg.innerHTML = raw && data.products.length
          ? `<div class="filters" style="margin-top:8px"><strong>Suggestions</strong>${data.products.slice(0, 5).map((p) => `<div><a href="product.html?sku=${encodeURIComponent(p.sku)}">${p.title} — ${money(p.price)}</a></div>`).join('')}</div>` : '';
      }
      if (pageEl) {
        pageEl.innerHTML = totalPages > 1
          ? `<button id="prevPage" ${page <= 1 ? 'disabled' : ''}>← Previous</button> <span style="margin:0 8px">Page ${page} of ${totalPages}</span> <button id="nextPage" ${page >= totalPages ? 'disabled' : ''}>Next →</button>`
          : '';
        const prev = document.getElementById('prevPage');
        const next = document.getElementById('nextPage');
        if (prev) prev.onclick = () => { if (page > 1) { page--; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
        if (next) next.onclick = () => { if (page < totalPages) { page++; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
      }
      return;
    }
    // Fallback: /api/products failed (e.g. old deploy) — use the static sample
    // file, filtered locally, paginated the same way so it can never render 26k cards.
    if (!fallbackProducts) {
      try { const r = await fetch('data/products.json'); fallbackProducts = (await r.json()).products || []; }
      catch (e) { fallbackProducts = []; }
    }
    const raw = (qEl.value || '').trim().toLowerCase();
    const toks = raw ? tokens(raw) : [];
    let items = fallbackProducts.filter((p) => {
      if (catEl.value && p.category !== catEl.value) return false;
      if (brandEl.value && p.brand !== brandEl.value) return false;
      if (calEl.value && p.caliber !== calEl.value) return false;
      if (stockEl.checked && p.stock_qty <= 0) return false;
      return true;
    });
    if (raw) items = items.map((p) => ({ p, s: score(p, toks, raw) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.p);
    else if (sortEl.value === 'price-asc') items.sort((a, b) => a.price - b.price);
    else if (sortEl.value === 'price-desc') items.sort((a, b) => b.price - a.price);
    else items.sort((a, b) => (b.stock_qty > 0) - (a.stock_qty > 0));
    totalPages = Math.max(1, Math.ceil(items.length / 48));
    countEl.textContent = items.length + ' product' + (items.length === 1 ? '' : 's');
    listEl.innerHTML = items.slice((page - 1) * 48, page * 48).map(card).join('') || `<div class="banner"><strong>No exact match.</strong></div>`;
    if (pageEl) pageEl.innerHTML = '';
  }
  function resetAndRender() { page = 1; render(); }
  [qEl, catEl, brandEl, calEl, stockEl, sortEl].forEach((el) => el.addEventListener('input', resetAndRender));
  const searchForm = document.getElementById('searchForm');
  if (searchForm) searchForm.addEventListener('submit', (e) => { e.preventDefault(); resetAndRender(); });
  // SEO / shareable URLs: index.html?category=Handguns or ?q=Glock%2019
  // pre-fills the shop filters. Facets loaded in render() preserve these
  // values when they exist in the facet lists.
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('q')) qEl.value = params.get('q');
    if (params.get('category')) catEl.value = params.get('category');
    if (params.get('brand')) brandEl.value = params.get('brand');
    if (params.get('caliber')) calEl.value = params.get('caliber');
  } catch (e) { /* ignore malformed URLs */ }
  render();
}
// Category landing pages (handguns.html, rifles.html, ...): a simple grid
// fed by one API query — category=... or q=... — with pagination. The
// landing copy itself is static HTML (indexable), only the grid is JS.
async function initCategoryGrid() {
  const holder = document.getElementById('categoryResults');
  if (!holder) return;
  const listEl = document.getElementById('results');
  const countEl = document.getElementById('count');
  const pageEl = document.getElementById('pagination');
  const catQEl = document.getElementById('catQ');
  const catForm = document.getElementById('catSearchForm');
  let page = 1, totalPages = 1;
  async function render() {
    const params = new URLSearchParams({ page: String(page), limit: '48' });
    const userQ = catQEl ? catQEl.value.trim() : '';
    // Scoped search: on a category page, search stays INSIDE that category.
    // Category-type pages: category=... + q=user term (API applies both).
    // Q-type pages (rifles/shotguns): base term + user term combined, so a
    // search for "AR-15" on the Rifles page still returns rifles, not all products.
    if (holder.dataset.shopType === 'category') {
      params.set('category', holder.dataset.shopValue);
      if (userQ) params.set('q', userQ);
    } else {
      params.set('q', userQ ? (holder.dataset.shopValue + ' ' + userQ) : holder.dataset.shopValue);
    }
    try {
      const res = await fetch('/api/products?' + params.toString());
      const data = await res.json();
      totalPages = Math.max(1, Math.ceil((data.total || 0) / 48));
      countEl.textContent = (data.total || 0) + ' product' + (data.total === 1 ? '' : 's') + (data.total > 48 ? ` — page ${page} of ${totalPages}` : '');
      listEl.innerHTML = (data.products || []).map(card).join('') || '<p>No products found in this category right now.</p>';
      if (pageEl) {
        pageEl.innerHTML = totalPages > 1 ? `<button id="prevPage" ${page <= 1 ? 'disabled' : ''}>← Previous</button> <span style="margin:0 8px">Page ${page} of ${totalPages}</span> <button id="nextPage" ${page >= totalPages ? 'disabled' : ''}>Next →</button>` : '';
        const prev = document.getElementById('prevPage');
        const next = document.getElementById('nextPage');
        if (prev) prev.onclick = () => { if (page > 1) { page--; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
        if (next) next.onclick = () => { if (page < totalPages) { page++; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
      }
    } catch (e) { listEl.innerHTML = '<p>Products could not be loaded right now.</p>'; }
  }
  if (catForm) catForm.addEventListener('submit', (e) => { e.preventDefault(); page = 1; render(); });
  if (catQEl) catQEl.addEventListener('input', () => { page = 1; render(); });
  render();
}
function initAgeGate() {
  const gate = document.getElementById('ageGate');
  if (!gate) return;
  try {
    const stored = localStorage.getItem('xl_age_verified');
    if (stored && Date.now() - parseInt(stored, 10) < 30 * 24 * 60 * 60 * 1000) return; // verified in last 30 days
  } catch (e) { /* private mode: show gate every visit */ }
  gate.classList.remove('hidden');
  document.getElementById('ageEnter').onclick = () => {
    try { localStorage.setItem('xl_age_verified', String(Date.now())); } catch (e) {}
    gate.classList.add('hidden');
  };
  document.getElementById('ageExit').onclick = () => {
    const denied = document.getElementById('ageDenied');
    if (denied) denied.style.display = 'block';
  };
}
async function initProduct() {
  const el = document.getElementById('product');
  if (!el) return;
  const sku = new URLSearchParams(location.search).get('sku');
  let p = null;
  try {
    const res = await fetch('/api/products?sku=' + encodeURIComponent(sku || ''));
    if (res.ok) { const data = await res.json(); p = (data.products || [])[0] || null; }
  } catch (e) { /* fallback below */ }
  if (!p) {
    const res = await fetch('data/products.json');
    const data = await res.json();
    p = (data.products || []).find((x) => x.sku === sku) || data.products[0];
  }
  if (!p) { el.innerHTML = '<p>Product not found.</p>'; return; }
  // SEO: product page title + Product structured data, so Google can show
  // price / availability for this SKU even though the page is JS-rendered.
  try {
    document.title = p.title + ' | XL Arms';
    const ld = document.createElement('script');
    ld.type = 'application/ld+json';
    ld.textContent = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: p.title, sku: p.sku, mpn: p.sku, brand: { '@type': 'Brand', name: p.brand }, category: p.category, offers: { '@type': 'Offer', price: p.price, priceCurrency: 'USD', availability: p.stock_qty > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url: location.href } });
    document.head.appendChild(ld);
  } catch (e) { /* SEO enhancement only */ }
  const stock = p.stock_qty > 0 ? `<span class="instock">In stock (${p.stock_qty})</span>` : `<span class="outstock">Out of stock</span>`;
  const ffl = p.is_firearm
    ? `<div class="ffl"><strong>FFL transfer required.</strong> Firearms ship to a licensed dealer (FFL) of your choice for background check and pickup — not directly to your home. You will confirm your FFL during checkout. Payment gateway to be confirmed before launch — do not use this starter page for real checkout.</div>`
    : `<div class="ffl"><strong>Ships normally.</strong> Ammunition and accessories do not require an FFL transfer, but state shipping restrictions still apply at checkout.</div>`;
  el.innerHTML = `
    <p><a href="index.html">← Back to shop</a></p>
    <h2>${p.title}</h2>
    <img src="${p.images[0]}" alt="${p.title}" style="max-width:420px;width:100%;background:#f0ede6;border-radius:8px">
    <div class="price">${money(p.price)}</div><div>${stock}</div>${ffl}
    <p><button class="btn" onclick="addToCart('${String(p.sku).replace(/'/g, "\\'")}')">Add to Cart</button> <a class="btn btn-dark" href="cart.html">View Cart →</a></p>
    <table class="specs">
      <tr><th>Brand</th><td>${p.brand}</td></tr>
      <tr><th>Model</th><td>${p.model}</td></tr>
      <tr><th>Category</th><td>${p.category}</td></tr>
      ${p.caliber ? `<tr><th>Caliber / Gauge</th><td>${p.caliber}</td></tr>` : ''}
      ${p.action ? `<tr><th>Action</th><td>${p.action}</td></tr>` : ''}
      ${p.barrel_in ? `<tr><th>Barrel</th><td>${p.barrel_in}"</td></tr>` : ''}
      ${p.capacity ? `<tr><th>Capacity</th><td>${p.capacity}</td></tr>` : ''}
      ${p.finish ? `<tr><th>Finish</th><td>${p.finish}</td></tr>` : ''}
      <tr><th>SKU</th><td>${p.sku}</td></tr>
      <tr><th>UPC</th><td>${p.upc}</td></tr>
    </table>
    <p>${p.description || ''}</p>
    ${p.prop65Message ? `<p><em>${p.prop65Message}</em></p>` : ''}`;
}
document.addEventListener('DOMContentLoaded', () => { initAgeGate(); initShop(); initCategoryGrid(); initProduct(); initFeatured(); initCartPage(); updateCartBadge(); });
