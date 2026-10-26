// Image sync: RSR FTP -> Wasabi -> Bunny CDN (test phase + shard batches).
//
// SEPARATE from the catalog importer on purpose: the importer already peaks
// near Netlify's 1 GB memory ceiling, and image bytes must never ride along
// with it. This function only moves image bytes and writes one small manifest.
//
// What it does per SKU (standard images only for now; high-res is a later step):
//   1. Download /ftp_images/rsr_number/<shard>/<SKU>_1.jpg, _2.jpg, ... from
//      RSR FTP (stops at the first missing number; numbering is sequential).
//   2. Upload each to Wasabi as <WASABI_PREFIX>/<SKU>/<n>.jpg.
//   3. Record { count, sizes } in the Blobs manifest (key 'images.json' in
//      store 'xl-arms-catalog'). get-products.js serves Bunny URLs for SKUs
//      in the manifest and the placeholder for everything else — so images
//      appear gradually and a SKU never shows another product's photo.
//   4. If a SKU was already in the manifest and its image sizes changed,
//      purge its Bunny prefix (<host>/<prefix>/<SKU>/*). Brand-new SKUs need
//      no purge (nothing cached yet). Purge failures are logged, never fatal.
//
// Modes (query params on the function URL):
//   ?skus=SKU1,SKU2   sync exactly those SKUs (test mode; default when no
//                     params: IMAGE_SYNC_TEST_SKUS env, else Glock 43).
//   ?shard=g          list /ftp_images/rsr_number/g/ and sync every SKU in
//                     that shard (the full-sync building block — run shards
//                     one at a time, never all 30k products at once).
//
// Env vars (Jonathan sets these in Netlify; NEVER in chat or code):
//   RSR_FTP_*            (already set for the catalog importer)
//   WASABI_BUCKET, WASABI_KEY, WASABI_SECRET (secret), WASABI_REGION
//   WASABI_ENDPOINT      (optional override, else s3.<region>.wasabisys.com)
//   WASABI_PREFIX        (default 'products' — a NEW folder, never the old
//                         site's /ftp_images/ paths, so the old site is untouched)
//   BUNNY_HOSTNAME       (pull-zone hostname, e.g. xxx.b-cdn.net, no scheme)
//   BUNNY_API_KEY        (optional — purge only; sync works without it)
//   IMAGE_PREFIX         (site URL prefix; defaults to WASABI_PREFIX)
//
// SAFETY: test with a NEW Bunny pull zone whose origin is the Wasabi bucket.
// Never point this at the old site's pull zone during testing — a mistaken
// purge there would clear the old site's live cached images.
const { Writable } = require('stream');
const { imageShard } = require('./rsr-import');

const MAX_IMAGES_PER_SKU = 10;

function downloadOne(client, remotePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    client.downloadTo(sink, remotePath).catch(reject);
  });
}

async function ftpConnect() {
  const ftp = require('basic-ftp');
  const client = new ftp.Client();
  client.ftp.verbose = false;
  await client.access({
    host: process.env.RSR_FTP_HOST,
    port: parseInt(process.env.RSR_FTP_PORT || '2222', 10),
    user: process.env.RSR_FTP_USER,
    password: process.env.RSR_FTP_PASS,
    secure: true,
  });
  return client;
}

function wasabiClient() {
  let s3;
  try {
    s3 = require('@aws-sdk/client-s3');
  } catch {
    throw new Error('@aws-sdk/client-s3 is not installed — add it to package.json and redeploy before triggering the image sync.');
  }
  const region = process.env.WASABI_REGION || 'us-east-1';
  const endpoint = process.env.WASABI_ENDPOINT || `https://s3.${region}.wasabisys.com`;
  return {
    client: new s3.S3Client({
      region,
      endpoint,
      credentials: { accessKeyId: process.env.WASABI_KEY, secretAccessKey: process.env.WASABI_SECRET },
      forcePathStyle: false,
    }),
    PutObjectCommand: s3.PutObjectCommand,
    bucket: process.env.WASABI_BUCKET,
  };
}

async function bunnyPurgePrefix(hostname, prefix, sku) {
  const apiKey = process.env.BUNNY_API_KEY;
  if (!apiKey || !hostname) return 'skipped (no BUNNY_API_KEY or BUNNY_HOSTNAME)';
  const url = `https://${hostname}/${prefix}/${sku}/*`;
  const res = await fetch(`https://api.bunny.net/purge?url=${encodeURIComponent(url)}&async=true`, {
    method: 'POST',
    headers: { AccessKey: apiKey },
  });
  if (!res.ok) throw new Error(`Bunny purge ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200));
  return 'purged';
}

async function loadManifest(blobs) {
  try {
    const store = blobs.getStore('xl-arms-catalog');
    const m = await store.get('images.json', { type: 'json' });
    if (m && m.images && typeof m.images === 'object') return m;
  } catch (e) { console.warn('No prior image manifest, starting fresh:', e.message); }
  return { generated: null, prefix: null, images: {} };
}

exports.handler = async (event) => {
  // Background function: Netlify returns 202 immediately; progress is in
  // the Functions log. The caller does NOT see this summary in the response.
  let ftp = null;
  try {
    const qs = event.queryStringParameters || {};
    const prefix = process.env.WASABI_PREFIX || 'products';
    const hostname = process.env.BUNNY_HOSTNAME || '';
    if (!process.env.WASABI_BUCKET || !process.env.WASABI_KEY || !process.env.WASABI_SECRET) {
      throw new Error('Missing Wasabi env vars — set WASABI_BUCKET, WASABI_KEY, WASABI_SECRET (and WASABI_REGION) in Netlify, then redeploy.');
    }
    const { client: s3, PutObjectCommand, bucket } = wasabiClient();

    ftp = await ftpConnect();
    await ftp.cd('/');

    // Decide the SKU list: explicit ?skus=, one ?shard=, or the test default.
    let skus = [];
    if (qs.skus) {
      skus = qs.skus.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (qs.shard) {
      const shard = String(qs.shard).toLowerCase();
      const list = await ftp.list(`ftp_images/rsr_number/${shard}/`);
      const found = new Set();
      for (const entry of list) {
        const m = String(entry.name || '').match(/^(.+?)_\d+\.jpg$/i);
        if (m) found.add(m[1]);
      }
      skus = [...found].sort();
    } else {
      const def = process.env.IMAGE_SYNC_TEST_SKUS || 'GLUI4350201';
      skus = def.split(',').map((s) => s.trim()).filter(Boolean);
    }

    let blobs;
    try { blobs = require('@netlify/blobs'); } catch {
      throw new Error('@netlify/blobs is not installed.');
    }
    try { blobs.connectLambda(event); } catch (e) { console.warn('connectLambda skipped:', e.message); }
    const manifest = await loadManifest(blobs);
    manifest.prefix = prefix;

    const results = [];
    for (const sku of skus) {
      try {
        const shard = imageShard(sku);
        const sizes = [];
        for (let n = 1; n <= MAX_IMAGES_PER_SKU; n++) {
          const remote = `ftp_images/rsr_number/${shard}/${sku}_${n}.jpg`;
          let buf;
          try {
            buf = await downloadOne(ftp, remote);
          } catch (e) {
            break; // first missing number = no more images for this SKU
          }
          if (!buf || buf.length === 0) break;
          await s3.send(new PutObjectCommand({
            Bucket: bucket, Key: `${prefix}/${sku}/${n}.jpg`,
            Body: buf, ContentType: 'image/jpeg',
          }));
          sizes.push(buf.length);
        }
        if (sizes.length === 0) { results.push({ sku, status: 'no-images-on-ftp' }); continue; }
        const prev = manifest.images[sku];
        const changed = !!prev && JSON.stringify(prev.sizes || []) !== JSON.stringify(sizes);
        let purge = 'n/a (new SKU, nothing cached yet)';
        if (changed) {
          try { purge = await bunnyPurgePrefix(hostname, prefix, sku); }
          catch (e) { purge = `FAILED (logged, sync continues): ${e.message}`; }
        }
        manifest.images[sku] = { count: sizes.length, sizes };
        results.push({ sku, status: 'ok', count: sizes.length, changed, purge });
      } catch (e) {
        results.push({ sku, status: 'error', error: e.message });
      }
    }

    manifest.generated = new Date().toISOString();
    await blobs.getStore('xl-arms-catalog').set('images.json', JSON.stringify(manifest));
    const ok = results.filter((r) => r.status === 'ok');
    console.log('Image sync OK', JSON.stringify({
      prefix, skusAttempted: skus.length, synced: ok.length,
      images: ok.reduce((a, r) => a + r.count, 0),
      noImages: results.filter((r) => r.status === 'no-images-on-ftp').map((r) => r.sku),
      errors: results.filter((r) => r.status === 'error'),
      purged: results.filter((r) => r.changed).map((r) => r.sku),
    }));
    return { statusCode: 202, body: JSON.stringify({ ok: true, note: 'Background image sync started — check Functions log for Image sync OK.' }) };
  } catch (e) {
    console.error('Image sync FAILED:', e.message);
    return { statusCode: 202, body: JSON.stringify({ ok: false, error: e.message }) };
  } finally {
    if (ftp) { try { ftp.close(); } catch (e) { /* ignore */ } }
  }
};
