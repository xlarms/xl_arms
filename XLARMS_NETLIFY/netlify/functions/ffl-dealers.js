// FFL dealer finder — serves /api/ffl-dealers (see netlify.toml redirect).
// Source: the RSR FFL dealer list already in the catalog Blobs store
// (ffl-transfer-dealers.txt, parsed by rsr-import.js: name, street, city,
// state, ZIP, license). The license number is deliberately NOT returned —
// a customer needs name + address + directions, not a license number.
// No phone/email exists in the source file, so none is shown.
// "Near me" here is ZIP-area sorting, NOT a true radius: the source has
// no coordinates, so dealers are sorted by ZIP numeric closeness, with
// same first-3-digits (same ZIP area) first. Labelled on the page as
// dealers in our network, not every FFL in America.
const fs = require('fs');
const path = require('path');

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
