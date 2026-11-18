// FFL dealer finder — serves /api/ffl-dealers (see netlify.toml redirect).
// Source: the RSR FFL dealer list already in the catalog Blobs store
// (ffl-transfer-dealers.txt, parsed by rsr-import.js: name, street, city,
// state, ZIP, license), MERGED with the ATF supplement
// (atf-dealers-supplement.json, beside this file): Type 01/02 FFLs from
// ATF's public Federal Firearms Licensee listing for CA, WA and NY, because
// the RSR list has only 1 California dealer. The license number is
// deliberately NOT returned — a customer needs name + address + directions,
// not a license number. No phone/email exists in the source files, so none
// is shown.
// "Near me" here is ZIP-area sorting, NOT a true radius: the source has
// no coordinates, so dealers are sorted by ZIP numeric closeness, with
// same first-3-digits (same ZIP area) first. Labelled on the page as
// dealers in our network, not every FFL in America.
const fs = require('fs');
const path = require('path');

// --- ATF supplement (Type 01/02 FFLs for CA, WA, NY) -----------------------
// Loaded once at cold start from the JSON bundled beside this file. If it is
// missing or unreadable, the RSR list is served alone — the request never
// fails because of the supplement. Regenerate monthly: see
// ~/workspace/xl-arms-atf-ffl-supplement/README.md.
let ATF_SUPPLEMENT = [];
try {
  const sup = require('./atf-dealers-supplement.json');
  if (Array.isArray(sup)) ATF_SUPPLEMENT = sup;
  else console.warn('ffl-dealers: ATF supplement is not an array — ignoring it.');
} catch (e) {
  console.warn('ffl-dealers: ATF supplement unavailable, serving RSR list only —', e.message);
}

// License numbers are 15 chars (region/district/county/type/expiry/sequence);
// RSR stores them plain or dashed, ATF as the plain 15-char form, so compare
// with non-alphanumerics stripped and uppercased. Rows without a license
// fall back to name+ZIP.
function normLicense(lic) {
  return String(lic || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
// Merge the ATF supplement into the RSR list, dropping supplement rows that
// duplicate an RSR dealer (RSR record wins). Returns a new array.
//
// Identity rule: the LICENSE is the identity. Name+ZIP is only a fallback
// identity for a row that has no license. So two rows with DIFFERENT
// licenses are different FFLs even at the same name+ZIP (e.g. a chain store
// holding two licenses at one address) and both are kept; a row with no
// license is a duplicate of any kept row sharing its name+ZIP. That is why
// three sets are tracked: licenses of kept rows, name+ZIP of kept rows
// WITHOUT a license, and name+ZIP of ALL kept rows.
function nameZipKey(d) {
  return String(d.name || '').trim().toLowerCase() + '|' + String(d.zip || '').replace(/\D/g, '').slice(0, 5);
}
function mergeSupplement(rsrDealers) {
  if (!ATF_SUPPLEMENT.length) return rsrDealers;
  const seenLic = new Set();     // licenses of kept rows that have one
  const seenNZNoLic = new Set(); // name+ZIP of kept rows WITHOUT a license
  const seenNZAll = new Set();   // name+ZIP of ALL kept rows
  function noteKept(d) {
    const lic = normLicense(d.license);
    if (lic) seenLic.add(lic);
    else seenNZNoLic.add(nameZipKey(d));
    seenNZAll.add(nameZipKey(d));
  }
  function isDuplicate(d) {
    const lic = normLicense(d.license);
    if (lic) return seenLic.has(lic) || seenNZNoLic.has(nameZipKey(d));
    return seenNZAll.has(nameZipKey(d));
  }
  const out = rsrDealers.slice();
  for (const d of rsrDealers) noteKept(d);
  for (const d of ATF_SUPPLEMENT) {
    if (isDuplicate(d)) continue;
    noteKept(d);
    out.push(d);
  }
  return out;
}

async function loadDealers(event) {
  try {
    const { getStore, connectLambda } = require('@netlify/blobs');
    try { connectLambda(event); } catch (e) {}
    const live = await getStore('xl-arms-catalog').get('products.json', { type: 'json' });
    if (live && Array.isArray(live.dealers) && live.dealers.length > 0) return live.dealers;
  } catch (e) {}
  try {
    const file = path.join(__dirname, '..', '..', 'data', 'products.json');
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(d.dealers)) return d.dealers;
  } catch (e) {}
  return [];
}

function fmtZip(z) {
  const d = String(z || '').replace(/\D/g, '');
  return d.length === 9 ? d.slice(0, 5) + '-' + d.slice(5) : d;
}

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const zipQ = String(q.zip || '').replace(/\D/g, '');
    const stateQ = String(q.state || '').trim().toUpperCase();
    const cityQ = String(q.city || '').trim().toLowerCase();
    const textQ = String(q.q || '').trim().toLowerCase();
    let dealers = await loadDealers(event);
    dealers = mergeSupplement(dealers);
    const totalInList = dealers.length;
    if (stateQ) dealers = dealers.filter((d) => String(d.state || '').toUpperCase() === stateQ);
    if (cityQ) dealers = dealers.filter((d) => String(d.city || '').toLowerCase().includes(cityQ));
    if (textQ) {
      dealers = dealers.filter((d) => [d.name, d.city, d.state, d.zip].join(' ').toLowerCase().includes(textQ));
    }
    if (zipQ.length === 3) {
      dealers = dealers.filter((d) => String(d.zip || '').replace(/\D/g, '').startsWith(zipQ));
    } else if (zipQ.length >= 5) {
      const target = parseInt(zipQ.slice(0, 5), 10);
      const zip3 = zipQ.slice(0, 3);
      dealers = dealers.map((d) => {
        const z = String(d.zip || '').replace(/\D/g, '');
        const n = parseInt(z.slice(0, 5), 10);
        return { d, sameArea: z.startsWith(zip3), dist: Number.isFinite(n) ? Math.abs(n - target) : 999999 };
      }).sort((a, b) => (b.sameArea - a.sameArea) || (a.dist - b.dist)).map((x) => x.d);
    } else {
      dealers = [...dealers].sort((a, b) => String(a.state || '').localeCompare(String(b.state || '')) || String(a.city || '').localeCompare(String(b.city || '')) || String(a.name || '').localeCompare(String(b.name || '')));
    }
    const total = dealers.length;
    const out = dealers.slice(0, 50).map((d) => ({
      name: d.name, street: d.street, city: d.city, state: d.state, zip: fmtZip(d.zip),
    }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=0, s-maxage=300' }, body: JSON.stringify({ dealers: out, total, totalInList }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'FFL list unavailable', detail: e.message }) };
  }
};
