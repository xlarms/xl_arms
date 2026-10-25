// Starter only: serves the sample catalog file.
// Production version: read from the real product/search store (database / Netlify Blobs /
// generated JSON in Wasabi) that rsr-import-background.js writes to — never query RSR FTP live.
const fs = require('fs');
const path = require('path');
exports.handler = async () => {
  try {
    const file = path.join(__dirname, '..', '..', 'data', 'products.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'catalog unavailable' }) };
  }
};
