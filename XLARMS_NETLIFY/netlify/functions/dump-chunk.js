// TEMPORARY — DELETE AFTER CHUNKS ARE EXPORTED.
// dump-chunk.js exists ONLY to pull the 27 per-letter full-index chunks
// out of the Blobs store once, so they can be shipped as plain static
// JSON files (data/full-index-<letter>.json) with the site. It is NOT
// part of the live site: do not link it, do not keep it after the export.
// Step 2 deletes this file from the site (and from GitHub) in the same
// upload that adds the static chunk files.
// Contract: GET /.netlify/functions/dump-chunk?key=<letter>
//   key = exactly one character, A-Z or '0' — anything else is a 400.
//   200 = the stored chunk JSON, exactly as written by
//   full-index-build-background.js ({ chunk, products: [...] }).
//   404 = no chunk stored under that key.
// This function can read ONLY full-index-<A-Z0>.json keys in the
// xl-arms-catalog store. The key is validated against /^[A-Z0]$/ and the
// filename is built from that single character — there is no path
// traversal and no way to ask for any other Blobs key.
// No credentials, no secrets, no writes.
//   Optional paging for large chunks (S is ~6 MB, over the sync-function
//   response limit): ?offset=<n>&limit=<m> returns products[offset:offset+limit]
//   plus total, so a big chunk can be pulled in slices and joined locally.
exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const key = String(q.key || '').toUpperCase();
  if (!/^[A-Z0]$/.test(key)) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'key must be a single letter A-Z or 0' }) };
  }
  const offset = Math.max(0, parseInt(q.offset || '0', 10) || 0);
  const limit = q.limit ? Math.max(1, Math.min(5000, parseInt(q.limit, 10) || 5000)) : 0;
  try {
    const { getStore, connectLambda } = require('@netlify/blobs');
    try { connectLambda(event); } catch (e) { /* non-Lambda context */ }
    const chunk = await getStore('xl-arms-catalog').get('full-index-' + key + '.json', { type: 'json' });
    if (!chunk || !Array.isArray(chunk.products) || chunk.products.length === 0) {
      return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'no chunk stored for key ' + key }) };
    }
    if (limit > 0) {
      const slice = chunk.products.slice(offset, offset + limit);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chunk: key, total: chunk.products.length, offset, products: slice }) };
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chunk) };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'chunk read failed' }) };
  }
};
