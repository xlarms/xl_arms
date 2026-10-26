// RSR FTP IMPORTER — REAL PARSER / NORMALIZER (2026-10-25, confirmed columns).
// This module contains NO credentials and NO network calls by itself.
// It takes file *contents* (downloaded by the caller from RSR FTP, or read locally)
// and returns a normalized catalog. That separation is deliberate:
//   - The Netlify background function (rsr-import-background.js) is the caller
//     that downloads from FTP and writes the output atomically.
//   - This module is pure, testable, and is what was tested on Jonathan's sample rows.
//
// DECISIONS (Jonathan, 2026-10-25):
//   PRICING = sell at MAP (inventory field 71, cross-checked with retail-map.csv).
//     No-MAP SKU: flag it, fall back to MSRP (field 6), never invent a price.
//     Price-match and FFL-fee-up-to-$25-if-proven are SITE OFFERS, not importer
//     discounts — they are not applied here, and must never go below MAP or cost.
//   CATALOG = FULL RSR catalog. No brand/category exclusions.
//     Deleted items are still hidden; restricted items are still checkout-blocked.
//   STOCK = main inventory (rsrinventory-new.txt) ONLY. Fulfillment is reference only.
//   PAYMENT = LAST. This importer produces no checkout and no payment wiring.
//
// CONFIRMED FORMATS (all from Jonathan's 2026-10-25 screenshots/samples):
//   Inventory / fulfillment: ;-delimited, HEADERLESS, 76 fields (tolerate trailing blanks).
//   Attributes: ;-delimited, HEADERLESS, 52 fields, positional.
//   Product-xref: ;-delimited, HEADERLESS, 4 fields.
//   Restrictions: ;-delimited, HEADERLESS (fields file), 5 fields, Municipality quoted "ALL".
//   Messages: ;-delimited, HEADERLESS (fields file), 5 fields.
//   Retail-map: COMMA-delimited, HEADER row "SKU,RETAIL-MAP-PRICE", price zero-padded.
//   Sell descriptions: ;-delimited, quoted text, multi-row per SKU (SELLCOPY / FEATURES).
//   FFL dealers: ;-delimited, HEADERLESS, 6 fields, ZIP 9-digit no hyphen.
//   Images: /ftp_images/rsr_number/<shard>/<RSR>_<n>.jpg, direct files, no product folder.
//     Shard = first character (lowercase a-z), "num" if the RSR starts with a digit,
//     "#" otherwise. High-res mirrors the same path under /ftp_highres_images/.
//     _1.jpg = main image (inventory field 15), _2+ = gallery.

const DEPARTMENTS = {
  1: 'Handguns', 2: 'Used Handguns', 3: 'Used Long Guns', 4: 'Tasers',
  5: 'Long Guns', 6: 'NFA Products', 7: 'Black Powder', 8: 'Optics',
  9: 'Optical Accessories', 10: 'Magazines', 11: 'Grips, Pads, Stocks, Bipods',
  12: 'Soft Gun Cases, Packs, Bags', 13: 'Misc Accessories', 14: 'Holsters & Pouches',
  15: 'Reloading Equipment', 16: 'Black Powder Accessories', 17: 'Closeout Accessories',
  18: 'Ammunition', 19: 'Survival & Camping Supplies', 20: 'Lights, Lasers & Batteries',
  21: 'Cleaning Equipment', 22: 'Airguns', 23: 'Knives & Tools',
  24: 'High Capacity Magazines', 25: 'Safes & Security', 26: 'Safety & Protection',
  27: 'Non-Lethal Defense', 28: 'Binoculars', 29: 'Spotting Scopes', 30: 'Sights',
  31: 'Optical Accessories', 32: 'Barrels & Choke Tubes', 33: 'Clothing', 34: 'Parts',
  35: 'Slings & Swivels', 36: 'Electronics', 37: 'Not Used', 38: "Books, Software & DVD's",
  39: 'Targets', 40: 'Hard Gun Cases', 41: 'Upper Receivers & Conversion Kits',
  42: 'SBR Barrels & Upper Receivers', 43: 'Upper Receivers & Conversion Kits - High Capacity',
};
// Inventory fields 16-66, alphabetical state abbreviations (AK..WY, incl. DC).
const STATE_CODES = ['AK','AL','AR','AZ','CA','CO','CT','DC','DE','FL','GA','HI','IA','ID','IL','IN','KS','KY','LA','MA','MD','ME','MI','MN','MO','MS','MT','NC','ND','NE','NH','NJ','NM','NV','NY','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VA','VT','WA','WI','WV','WY'];

// Split one delimited line, respecting double-quoted fields (sell descriptions,
// restrictions "ALL"). Returns raw field strings, quotes stripped, NOT trimmed
// inside quoted text (a feature bullet keeps its own punctuation).
// QUOTE RULE (fixed 2026-10-26): a quote only OPENS a quoted field at a field
// boundary (start of line, or right after a delimiter), and only CLOSES one
// when followed by a delimiter or end of line. A mid-field quote is a literal
// inch mark (e.g. 3.41" barrel) and must NOT toggle quoting: the old code
// toggled on any quote, so the inch mark in a firearm description swallowed
// every following semicolon, collapsed the row to 14 fields, and
// parseInventory's "fewer than 15 fields, skip" rule silently dropped the
// product. That is why Glock pistols — and any product with an inch mark in
// its description — never made it into the catalog, while holsters did.
function splitLine(line, delimiter) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inQuotes && cur === '') {
      inQuotes = true; // quote at a field boundary: opens a quoted field
    } else if (ch === '"' && inQuotes) {
      if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote inside quoted field
      else if (line[i + 1] === delimiter || i + 1 === line.length) inQuotes = false; // closes
      else cur += '"'; // stray quote inside a quoted field: keep literally
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
function linesOf(text) {
  return String(text || '').split(/\r\n|\n|\r/).filter((l) => l.length > 0);
}
function num(v) { const n = parseFloat(String(v || '').replace(/^0+(?=\d)/, '')); return Number.isFinite(n) ? n : null; }
function intVal(v) { const n = parseInt(String(v || ''), 10); return Number.isFinite(n) ? n : 0; }
function clean(v) { return String(v || '').trim(); }
function listOf(...vals) {
  const seen = new Set(), out = [];
  for (const v of vals) { const c = clean(v); if (c && !seen.has(c)) { seen.add(c); out.push(c); } }
  return out;
}
// Caliber canonicalisation for search: 9 mm / 9x19 / 9MM -> "9mm", etc.
// Never silently substitute one caliber for another — this only normalises spelling.
// CLEAN 2026-10-25: live RSR shotgun-shell caliber fields arrive as a whole
// semicolon-joined attribute string, e.g.
//   "12 Gauge 2.75;;#4;;Federal;SH1294B;;Shorty Shotshell;;;;Buckshot;10;100;;Shot Shell Ammunition..."
// Using that as one caliber value pollutes the Caliber facet with 200-char
// entries. cleanCaliberDisplay() takes only the first ';' segment and, for
// gauges, collapses shell length ("12 Gauge 2.75" -> "12 Gauge", "410 Bore 2.5"
// -> "410 Bore") — shell length is not a caliber, and shoppers filter by gauge.
function cleanCaliberDisplay(raw) {
  if (!raw) return '';
  const first = String(raw).split(';')[0].trim();
  const gauge = first.match(/^(\d+)\s*(?:gauge|ga\.?)\b/i);
  if (gauge) return `${gauge[1]} Gauge`;
  if (/^410\s*bore/i.test(first)) return '410 Bore';
  return first;
}
function canonicalCaliber(raw) {
  if (!raw) return null;
  const cleaned = cleanCaliberDisplay(raw);
  let s = cleaned.toLowerCase().replace(/\s+/g, '').replace(/×/g, 'x');
  const map = { '9x19': '9mm', '9x19mm': '9mm', '9mmluger': '9mm', '9mmparabellum': '9mm',
    '556x45': '5.56', '556nato': '5.56', '223rem': '.223', '762x51': '7.62x51',
    '762x39': '7.62x39', '12gauge': '12ga', '12ga.': '12ga', '20gauge': '20ga' };
  return map[s] || cleaned;
}
function imageShard(rsr) {
  const c = String(rsr || '').charAt(0);
  if (/[0-9]/.test(c)) return 'num';
  if (/[a-zA-Z]/.test(c)) return c.toLowerCase();
  return '#';
}
function imagePaths(rsr, count = 1) {
  const shard = imageShard(rsr);
  const paths = [];
  for (let n = 1; n <= count; n++) {
    paths.push({
      standard: `/ftp_images/rsr_number/${shard}/${rsr}_${n}.jpg`,
      highres: `/ftp_highres_images/rsr_number/${shard}/${rsr}_${n}.jpg`,
    });
  }
  return paths;
}

// --- Parsers: each returns a Map / array keyed as documented. No I/O. ---

function parseInventory(text) {
  const out = new Map();
  for (const line of linesOf(text)) {
    const f = splitLine(line, ';');
    if (f.length < 15 || !clean(f[0])) continue; // tolerate trailing blanks (78 tokens vs 76 fields)
    const rsr = clean(f[0]);
    const stateRestrictions = {};
    for (let i = 0; i < STATE_CODES.length; i++) {
      if (clean(f[15 + i]) === 'Y') stateRestrictions[STATE_CODES[i]] = true;
    }
    out.set(rsr, {
      rsr, upc: clean(f[1]), title: clean(f[2]),
      // CLEAN 2026-10-25: the old fallback `Dept ${f[3]}` created fake
      // categories like "Dept ACC741C_1.jpg" (an image filename, not a
      // department) whenever a row's department field wasn't a 1–43 number.
      // Unknown departments now collapse to a single clean "Other" bucket.
      department: intVal(f[3]), departmentName: DEPARTMENTS[intVal(f[3])] || 'Other',
      manufacturerId: clean(f[4]), msrp: num(f[5]), dealerPrice: num(f[6]),
      weightOz: num(f[7]), stock: intVal(f[8]), model: clean(f[9]),
      brand: clean(f[10]), mpn: clean(f[11]), statusFlag: clean(f[12]),
      expandedDescription: clean(f[13]), imageName: clean(f[14]),
      stateRestrictions, groundOnly: clean(f[66]) === 'Y',
      adultSignature: clean(f[67]) === 'Y', blockedFromDropShip: clean(f[68]) === 'Y',
      dateEntered: clean(f[69]), mapPrice: num(f[70]), imageDisclaimer: clean(f[71]) === 'Y',
      shipLengthIn: num(f[72]), shipWidthIn: num(f[73]), shipHeightIn: num(f[74]),
      prop65: clean(f[75]) === 'Y',
    });
  }
  return out;
}

// Attributes: positional, 52 fields. Caliber/Model/Fit are LISTS (fields 21+22, 30+31, 17+18).
function parseAttributes(text) {
  const out = new Map();
  for (const line of linesOf(text)) {
    const f = splitLine(line, ';');
    if (f.length < 3 || !clean(f[0])) continue;
    const rsr = clean(f[0]);
    const get = (i) => clean(f[i - 1]); // fields are 1-indexed in the layout
    out.set(rsr, {
      rsr, manufacturerId: get(2),
      accessories: get(3), action: get(4), barrelType: get(5), barrelLength: get(6),
      catalogCode: get(7), chamber: get(8), chokes: get(9), condition: get(10),
      capacity: get(11), descriptionAttr: get(12), dram: get(13), edge: get(14),
      firingCasing: get(15), finish: get(16), fit: listOf(get(17), get(18)),
      feetPerSecond: get(19), frame: get(20),
      caliber: listOf(get(21), get(22)).map(canonicalCaliber).filter(Boolean),
      // caliberRaw is the DISPLAY value (facets + product page) — clean it
      // here so a semicolon-joined shell string never reaches the shop.
      caliberRaw: listOf(get(21), get(22)).map(cleanCaliberDisplay).filter(Boolean),
      grainWeight: get(23), grips: get(24), hand: get(25), manufacturer: get(26),
      manufacturerPart: get(27), manufacturerWeight: get(28), moa: get(29),
      modelAttr: listOf(get(30), get(31)), newStock: get(32), nsn: get(33),
      objective: get(34), ounceOfShot: get(35), packaging: get(36), power: get(37),
      reticle: get(38), safety: get(39), sights: get(40), size: get(41), type: get(42),
      unitsPerBox: get(43), unitsPerCase: get(44), weightCharacteristics: get(45),
      subCategory: get(46), diameter: get(47), color: get(48), material: get(49),
      stockAttr: get(50), lensColor: get(51), handleColor: get(52),
    });
  }
  return out;
}

function parseXref(text) {
  const out = new Map(); // rsr -> [{rsr, department}]
  for (const line of linesOf(text)) {
    const f = splitLine(line, ';');
    if (f.length < 4 || !clean(f[0]) || !clean(f[2])) continue;
    const list = out.get(clean(f[0])) || [];
    list.push({ rsr: clean(f[2]), department: intVal(f[3]) });
    out.set(clean(f[0]), list);
  }
  return out;
}

function parseRestrictions(text) {
  const out = new Map(); // rsr -> [{municipality, state, territoryType, detail}]
  for (const line of linesOf(text)) {
    const f = splitLine(line, ';');
    if (f.length < 5 || !clean(f[0])) continue;
    const list = out.get(clean(f[0])) || [];
    list.push({
      municipality: clean(f[1]).replace(/^"|"$/g, ''), state: clean(f[2]),
      territoryType: clean(f[3]), detail: clean(f[4]),
    });
    out.set(clean(f[0]), list);
  }
  return out;
}
// Checkout rule (confirmed): Y, F, A, L — and ANY unknown detail code — block a
// drop shipment to that area. A/L are never "allow with paperwork" for drop ship.
function isDropShipBlocked(restrictions, state, city, county) {
  if (!restrictions) return false;
  for (const r of restrictions) {
    const stateMatch = r.state === state;
    const areaMatch = r.municipality === 'ALL'
      || (r.territoryType === 'C' && city && r.municipality.toLowerCase() === city.toLowerCase())
      || (r.territoryType === 'T' && county && r.municipality.toLowerCase() === county.toLowerCase())
      || (r.territoryType === 'S' && stateMatch);
    if (stateMatch && areaMatch) return true; // Y/F/A/L/unknown all block drop ship
  }
  return false;
}

function parseMessages(text) {
  const out = new Map(); // rsr -> [{type, text}]
  for (const line of linesOf(text)) {
    const f = splitLine(line, ';');
    if (f.length < 5 || !clean(f[0])) continue;
    const list = out.get(clean(f[0])) || [];
    list.push({ type: clean(f[3]), text: clean(f[4]) });
    out.set(clean(f[0]), list);
  }
  return out;
}

function parseRetailMap(text) {
  const out = new Map();
  const all = linesOf(text);
  const start = all[0] && /^sku/i.test(all[0]) ? 1 : 0; // header row present in this file
  for (const line of all.slice(start)) {
    const f = splitLine(line, ',');
    if (f.length < 2 || !clean(f[0])) continue;
    out.set(clean(f[0]), num(f[1]));
  }
  return out;
}

function parseSellDescriptions(text) {
  const out = new Map(); // rsr -> {sellcopy, features[]}
  for (const line of linesOf(text)) {
    const f = splitLine(line, ';');
    if (f.length < 3 || !clean(f[1])) continue;
    const rsr = clean(f[1]);
    const entry = out.get(rsr) || { sellcopy: '', features: [] };
    if (clean(f[0]).toUpperCase() === 'SELLCOPY') entry.sellcopy = clean(f[2]);
    else if (clean(f[0]).toUpperCase() === 'FEATURES') {
      entry.features = f.slice(2).map(clean).filter(Boolean);
    }
    out.set(rsr, entry);
  }
  return out;
}

function parseFFL(text) {
  const out = [];
  for (const line of linesOf(text)) {
    const f = splitLine(line, ';');
    if (f.length < 6 || !clean(f[0])) continue;
    out.push({
      name: clean(f[0]), street: clean(f[1]), city: clean(f[2]), state: clean(f[3]),
      zip: clean(f[4]), license: clean(f[5]),
    });
  }
  return out;
}

function parseDeleted(text) {
  const out = new Set();
  for (const line of linesOf(text)) {
    const f = splitLine(line, ';');
    if (clean(f[0])) out.add(clean(f[0]));
  }
  return out;
}

// --- Join: one normalized product per inventory SKU. Full catalog, no exclusions. ---
// MEMORY (slimmed 2026-10-26, was peaking at 1,018 MB vs Netlify's 1,024 MB
// default): (a) the search index is built ONLY when opts.searchIndex is set —
// the background importer never publishes it, so building it by default was
// pure waste; (b) each raw FTP string is released (files.<key> = '') right
// after parsing, instead of holding ~90 MB of raw text for the whole run.
function buildCatalog(files, opts = {}) {
  const errors = [];
  const inventory = parseInventory(files.inventory || ''); files.inventory = '';
  if (inventory.size === 0) throw new Error('Inventory is empty or unreadable — aborting, live catalog kept.');
  const attributesAll = parseAttributes(files.attributesAll || ''); files.attributesAll = '';
  const attributes = parseAttributes(files.attributes || ''); files.attributes = '';
  const xref = parseXref(files.xref || ''); files.xref = '';
  const restrictions = parseRestrictions(files.restrictions || ''); files.restrictions = '';
  const messages = parseMessages(files.messages || ''); files.messages = '';
  const retailMap = parseRetailMap(files.retailMap || ''); files.retailMap = '';
  const sell = parseSellDescriptions(files.sellDescriptions || ''); files.sellDescriptions = '';
  const deleted = parseDeleted(files.deleted || ''); files.deleted = '';
  const newSkus = files.newSkus ? linesOf(files.newSkus).map(clean).filter(Boolean) : []; files.newSkus = '';

  const products = [];
  let hidden = 0, outOfStock = 0, noMapFlagged = 0;
  for (const [rsr, inv] of inventory) {
    const isDeleted = deleted.has(rsr) || inv.statusFlag.toLowerCase() === 'deleted';
    if (isDeleted) { hidden++; continue; } // deleted SKUs are hidden, even if qty lingers
    // MAP pricing: retail-map wins if present, else inventory field 71, else MSRP + flag.
    let price = retailMap.has(rsr) ? retailMap.get(rsr) : inv.mapPrice;
    let priceSource = retailMap.has(rsr) ? 'retail-map' : (inv.mapPrice != null ? 'inventory-field-71' : null);
    if (price == null) { price = inv.msrp; priceSource = 'msrp-fallback'; noMapFlagged++; errors.push(`No MAP for ${rsr} — fell back to MSRP.`); }
    if (retailMap.has(rsr) && inv.mapPrice != null && retailMap.get(rsr) !== inv.mapPrice) {
      errors.push(`MAP mismatch for ${rsr}: retail-map ${retailMap.get(rsr)} vs inventory ${inv.mapPrice} — retail-map used.`);
    }
    const attr = attributesAll.get(rsr) || attributes.get(rsr) || null;
    const attrSource = attributesAll.has(rsr) ? 'attributes-all' : (attributes.has(rsr) ? 'attributes' : null);
    const model = inv.model || (attr && attr.modelAttr[0]) || '';
    const brand = inv.brand || (attr && attr.manufacturer) || '';
    const caliber = attr ? attr.caliber : [];
    const fit = attr ? attr.fit : [];
    const finish = attr ? listOf(attr.finish, attr.color) : []; // pre-2020 Finish/Color combined
    const msg = messages.get(rsr) || [];
    const prop65Message = inv.prop65 ? (msg.find((m) => /prop65/i.test(m.type))?.text || null) : null;
    const inStock = inv.stock > 0;
    if (!inStock) outOfStock++;
    products.push({
      sku: rsr, rsr, upc: inv.upc, title: inv.title, department: inv.department,
      departmentName: inv.departmentName, brand, manufacturerId: inv.manufacturerId,
      mpn: inv.mpn, model, price, priceSource, msrp: inv.msrp, dealerPrice: inv.dealerPrice,
      stock: inv.stock, inStock, statusFlag: inv.statusFlag,
      weightOz: inv.weightOz, shipLengthIn: inv.shipLengthIn, shipWidthIn: inv.shipWidthIn,
      shipHeightIn: inv.shipHeightIn, dateEntered: inv.dateEntered,
      description: inv.expandedDescription, sellcopy: (sell.get(rsr) || {}).sellcopy || '',
      features: (sell.get(rsr) || {}).features || [],
      attributes: attr ? {
        action: attr.action, barrelType: attr.barrelType, barrelLength: attr.barrelLength,
        chamber: attr.chamber, capacity: attr.capacity, caliber, caliberRaw: attr.caliberRaw,
        fit, hand: attr.hand, finish, color: attr.color, material: attr.material,
        frame: attr.frame, grips: attr.grips, stockAttr: attr.stockAttr,
        grainWeight: attr.grainWeight, type: attr.type, subCategory: attr.subCategory,
        unitsPerBox: attr.unitsPerBox, unitsPerCase: attr.unitsPerCase, size: attr.size,
      } : null, attrSource,
      stateRestrictions: inv.stateRestrictions, groundOnly: inv.groundOnly,
      adultSignature: inv.adultSignature, blockedFromDropShip: inv.blockedFromDropShip,
      imageDisclaimer: inv.imageDisclaimer, prop65: inv.prop65, prop65Message,
      messages: msg, restrictions: restrictions.get(rsr) || [],
      related: xref.get(rsr) || [], imageName: inv.imageName,
      images: imagePaths(rsr, 1), // gallery count is discovered at image-sync time from the shard
      isNew: newSkus.includes(rsr),
    });
  }
  // Search index (opt-in only, see header note): exact SKU/UPC first, then
  // brand+model, then all-terms narrowing. A search must narrow, not widen.
  // Caliber synonyms are canonicalised, never substituted.
  const searchIndex = opts.searchIndex ? products.map((p) => ({
    sku: p.sku, upc: p.upc, title: p.title, brand: p.brand, model: p.model,
    department: p.departmentName,
    tokens: [...new Set(`${p.title} ${p.brand} ${p.model} ${p.sku} ${p.upc} ${(p.attributes?.caliber || []).join(' ')} ${(p.attributes?.fit || []).join(' ')}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))],
    inStock: p.inStock, price: p.price,
  })) : undefined;
  const dealers = parseFFL(files.ffl || ''); files.ffl = '';
  return {
    generatedAt: new Date().toISOString(),
    stats: { totalInventory: inventory.size, published: products.length, hidden, outOfStock, noMapFlagged },
    products, dealers, searchIndex, errors,
  };
}

// --- Storefront mapping: importer schema -> the schema assets/app.js renders ---
// app.js expects: sku, upc, title, brand, model, category, caliber (display),
// caliber_canonical, action, barrel_in, capacity, finish, price, stock_qty,
// is_firearm, description, images[]. This is the ONLY shape get-products.js
// publishes to the shop, so a catalog that does not go through here will
// not show up on the site even if the import itself succeeded.
const FIREARM_DEPARTMENTS = new Set([1, 2, 3, 5, 6, 7]); // Handguns, Used Handguns/Long Guns, Long Guns, NFA, Black Powder
function toStorefrontProduct(p) {
  const a = p.attributes || {};
  const caliberDisplay = (a.caliberRaw && a.caliberRaw[0]) || (a.caliber && a.caliber[0]) || '';
  const barrelIn = a.barrelLength ? parseFloat(String(a.barrelLength).replace(/[^0-9.]/g, '')) : null;
  return {
    sku: p.sku, rsr_number: p.sku, upc: p.upc, title: p.title, brand: p.brand,
    model: p.model, category: p.departmentName, caliber: caliberDisplay,
    caliber_canonical: (a.caliber && a.caliber[0]) || '',
    action: a.action || '', barrel_in: Number.isFinite(barrelIn) ? barrelIn : null,
    capacity: a.capacity ? intVal(a.capacity) : null,
    finish: (a.finish || []).join(', '),
    // Detailed-filter fields (sidebar, added 2026-10-26): published so the
    // shop API can filter/facet on them. Until the next re-import these are
    // absent from the live catalog and their sidebar groups stay hidden.
    type: a.type || '', subCategory: a.subCategory || '', frame: a.frame || '',
    grips: a.grips || '', color: a.color || '', material: a.material || '',
    size: a.size || '', date_entered: p.dateEntered || '',
    closeout: String(p.statusFlag || '').toLowerCase() === 'closeout',
    price: p.price, stock_qty: p.stock, is_firearm: FIREARM_DEPARTMENTS.has(p.department),
    description: p.sellcopy || p.description || '',
    features: p.features || [], prop65: p.prop65, prop65Message: p.prop65Message || null,
    groundOnly: p.groundOnly, adultSignature: p.adultSignature,
    blockedFromDropShip: p.blockedFromDropShip,
    // Images stay on the placeholder until the Wasabi/Bunny image-sync step
    // replaces them with Bunny CDN URLs. Never use another product's photo.
    images: ['images/placeholder.svg'],
  };
}
function toStorefrontCatalog(catalog) {
  return {
    generated: catalog.generatedAt, stats: catalog.stats,
    _note: 'Live RSR catalog — replaces the starter sample data. Prices are MAP, stock is main inventory.',
    products: catalog.products.map(toStorefrontProduct),
    dealers: catalog.dealers || [],
  };
}

module.exports = {
  DEPARTMENTS, STATE_CODES, splitLine, canonicalCaliber, cleanCaliberDisplay, imageShard, imagePaths,
  parseInventory, parseAttributes, parseXref, parseRestrictions, isDropShipBlocked,
  parseMessages, parseRetailMap, parseSellDescriptions, parseFFL, parseDeleted, buildCatalog,
  toStorefrontProduct, toStorefrontCatalog, FIREARM_DEPARTMENTS,
};
