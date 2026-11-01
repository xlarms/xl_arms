// Hi count reader: returns the saved result of hi-count-background.
// Open /.netlify/functions/hi-count after triggering the counter once.
// Returns { counted: false } until a count has been saved. Read-only:
// it never triggers a count and never writes the image manifest.

exports.handler = async (event) => {
  const json = (obj) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    let blobs;
    try { blobs = require('@netlify/blobs'); } catch {
      throw new Error('@netlify/blobs is not installed.');
    }
    try { blobs.connectLambda(event); } catch (e) { console.warn('connectLambda skipped:', e.message); }
    const store = blobs.getStore('xl-arms-catalog');
    const data = await store.get('hi-count.json', { type: 'json' });
    if (!data) return json({ counted: false, note: 'No hi count yet — trigger /.netlify/functions/hi-count-background first, then re-open this URL.' });
    return json({ counted: true, ...data });
  } catch (e) {
    console.error('Hi count read FAILED:', e.message);
    return json({ counted: false, error: e.message });
  }
};
