// Local test for netlify/functions/rsr-import.js — uses ONLY Jonathan's sample rows
// sent in chat 2026-10-25. Run: node scripts/test-importer.js  (exit 1 on any failure)
const assert = require('assert');
const { buildCatalog, isDropShipBlocked, imageShard } = require('../netlify/functions/rsr-import');

const inventory = [
  '17912WH-1-SBL-R;816161020234;1791 2 WAY IWB STEALTH BLK RH SIZE 1;14;1791;50.99;30.59;6;7;2 Way Holster;1791 Gunleather;2WH-1-SBL-R;;1791 Gunleather 2 Way Holster, Inside Waistband Holster, Size 1, Right Hand, Stealth Black, Leather 2WH-1-SBL-R;17912WH-1-SBL-R_1.jpg;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;20210420;48.99;;7.50;6.50;2.00;Y;;',
  // A deleted SKU: qty 0 + status Deleted must be HIDDEN, not listed as out-of-stock.
  'DELETED1;123456789012;DELETED WIDGET;14;1791;10.00;6.00;1;0;Widget;1791 Gunleather;DEL-1;Deleted;Deleted widget;DELETED1_1.jpg;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;20200101;9.99;;1;1;1;;',
].join('\n');

// Attributes-all sample for the same holster (fields 1-52, positional; only the
// populated fields matter for the assertions — blanks are the point for a holster).
// Constructed from the fields list: Hand=25, Manufacturer=26, MPN=27, Model=30,
// Type=42, SubCategory=46, Color=48, Material=49.
function attrRow(rsr) {
  const f = Array(52).fill('');
  f[0] = rsr; f[1] = '1791';
  f[24] = 'Right Hand'; f[25] = '1791 Gunleather'; f[26] = '2WH-1-SBL-R';
  f[29] = '2 Way Holster'; f[41] = 'Inside Waistband Holster'; f[45] = 'Holsters';
  f[47] = 'Stealth Black'; f[48] = 'Leather';
  return f.join(';');
}

const out = buildCatalog({
  inventory,
  attributesAll: attrRow('17912WH-1-SBL-R'),
  xref: '223SS;18;ARML15A2CB;5\n17912WH-1-SBL-R;14;17914WH-1-SBL-R;14',
  restrictions: 'AAC-15-308-BK;"ALL";AL;S;L\nAAC-15-308-BK;"ALL";AL;S;F\nAAC-15-308-BK;"ALL";MA;S;O\nAAC-15-308-BK;"ALL";MA;S;F',
  messages: '17912WH-1-SBL-R;816161020234;2WH-1-SBL-R;Prop65;WARNING: This product can expose you to chemicals known to the State of California to cause cancer.',
  retailMap: 'SKU,RETAIL-MAP-PRICE\n17912WH-1-SBL-R,00000048.99',
  sellDescriptions: 'SELLCOPY;17912WH-1-SBL-R;"The 2-Way Multi-Fit Inside the Waistband by 1791 Gunleather is the ideal balance of protection and comfort."\nFEATURES;17912WH-1-SBL-R;"Handcrafted using premium 100 percent Certified American, Heavy Native Steerhide leather.";"Open top carry-style in mind"',
  ffl: '1 SHOT GUNS;16190 S GOLDEN RD;GOLDEN;CO;804013767;5-84-059-07-8B-06743',
  deleted: 'DELETED1;14;1791;10.00',
});

assert.strictEqual(out.stats.totalInventory, 2, 'inventory rows');
assert.strictEqual(out.stats.published, 1, 'deleted SKU hidden, not published');
assert.strictEqual(out.stats.hidden, 1, 'hidden count');
const p = out.products[0];
assert.strictEqual(p.sku, '17912WH-1-SBL-R');
assert.strictEqual(p.price, 48.99, 'MAP price from retail-map, not MSRP 50.99 or dealer 30.59');
assert.strictEqual(p.priceSource, 'retail-map');
assert.strictEqual(p.stock, 7, 'field 9 is stock, not field 4 department 14');
assert.strictEqual(p.departmentName, 'Holsters & Pouches');
assert.strictEqual(p.brand, '1791 Gunleather');
assert.strictEqual(p.model, '2 Way Holster');
assert.strictEqual(p.prop65, true);
assert.ok(p.prop65Message && p.prop65Message.startsWith('WARNING:'), 'Prop65 message joined');
assert.strictEqual(p.attributes.hand, 'Right Hand');
assert.strictEqual(p.attributes.type, 'Inside Waistband Holster');
assert.strictEqual(p.attributes.subCategory, 'Holsters');
assert.ok(p.attributes.finish.includes('Stealth Black'), 'finish includes color (pre-2020 combined)');
assert.strictEqual(p.sellcopy.startsWith('The 2-Way'), true, 'sellcopy grouped');
assert.strictEqual(p.features.length, 2, 'features bullets grouped');
assert.strictEqual(p.related.length, 1, 'xref related list');
assert.strictEqual(p.images[0].standard, '/ftp_images/rsr_number/num/17912WH-1-SBL-R_1.jpg', 'digit SKU -> num shard');
assert.strictEqual(imageShard('AAC-15-308-BK'), 'a', 'letter SKU -> first-letter shard');
assert.strictEqual(out.dealers.length, 1, 'FFL dealer parsed');
assert.strictEqual(out.dealers[0].license, '5-84-059-07-8B-06743');
assert.strictEqual(isDropShipBlocked(out.products[0].restrictions, 'AL', '', ''), false, 'holster has no restrictions');
const restr = buildCatalog({ inventory: 'AAC-15-308-BK;000000000000;TEST;5;TEST;100;60;10;5;Test;Test;T-1;;Test;AAC-15-308-BK_1.jpg;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;20200101;90;;1;1;1;;', restrictions: 'AAC-15-308-BK;"ALL";AL;S;L\nAAC-15-308-BK;"ALL";AL;S;F' }).products[0];
assert.strictEqual(isDropShipBlocked(restr.restrictions, 'AL', '', ''), true, 'L+F blocks drop ship to AL');
const unknown = buildCatalog({ inventory: 'AAC-15-308-BK;000000000000;TEST;5;TEST;100;60;10;5;Test;Test;T-1;;Test;AAC-15-308-BK_1.jpg;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;20200101;90;;1;1;1;;', restrictions: 'AAC-15-308-BK;"ALL";MA;S;O' }).products[0];
assert.strictEqual(isDropShipBlocked(unknown.restrictions, 'MA', '', ''), true, 'unknown code O blocks by default');

console.log('PASS — importer tests:', JSON.stringify(out.stats), '| product:', p.sku, p.price, 'stock', p.stock, '| dealers:', out.dealers.length);
