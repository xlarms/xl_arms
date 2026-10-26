// Image sync: RSR FTP -> Wasabi -> Bunny CDN (test phase + shard batches).
//
// SEPARATE from the catalog importer on purpose: the importer already peaks
// near Netlify's 1 GB memory ceiling, and image bytes must never ride along
// with it. This function only moves image bytes and writes one small manifest.
//
// What it does per SKU (standard + high-res, one pass):
//   1. Download /ftp_images/rsr_number/<shard>/<SKU>_1.jpg, _2.jpg, ... from
//      RSR FTP (stops at the first missing number; numbering is sequential).
//   2. Upload each to Wasabi as <WASABI_PREFIX>/<SKU>/<n>.jpg.
//   3. Download the high-res mirror /ftp_highres_images/rsr_number/<shard>/
//      <SKU>_n_HR.jpg — note the _HR suffix: plain-named files do not exist
//      in the hi tree (verified from Jonathan's FileZilla listing 2026-10-26:
//      GLUI4350201_1_HR.jpg etc.) and upload each
//      to Wasabi as <WASABI_HI_PREFIX>/<SKU>/<n>.jpg. The storefront uses
//      standard images everywhere and high-res only inside the product-page
//      lightbox, so pages stay fast while zoom gets genuinely huge.
//   4. Record { count, sizes, hiCount, hiSizes } in the Blobs manifest (key
//      'images.json' in store 'xl-arms-catalog'). get-products.js serves
//      Bunny URLs for SKUs in the manifest and the placeholder for
//      everything else — so images appear gradually and a SKU never shows
//      another product's photo.
//   5. If a SKU was already in the manifest and its image sizes changed,
//      purge its Bunny prefix (<host>/<prefix>/<SKU>/*, and the hi prefix
//      when hi sizes changed). Brand-new SKUs need no purge (nothing cached
//      yet). Purge failures are logged, never fatal.
//   Download errors are NOT "no image": a genuinely missing file (550 /
//   not found) ends that SKU's numbering, but any other download failure
//   is recorded as an error, and 20 in a row aborts the run (the manifest
//   is still saved with progress so far) instead of faking thousands of
//   no-images records.
//   FTPS data connections to RSR are flaky (2026-10-26: "Client network
//   socket disconnected before secure TLS connection was established
//   (data socket)"). A dead client rejects every later download instantly,
//   so downloads go through downloadRetry: on a non-404 failure it
//   reconnects with a fresh client and retries (up to 3 attempts, with a
//   short backoff) instead of letting one dead connection kill the run.
//
// Modes (query params on the function URL):
//   ?skus=SKU1,SKU2   sync exactly those SKUs (test mode; default when no
//                     params: IMAGE_SYNC_TEST_SKUS env, else Glock 43).
//   ?shard=g          list /ftp_images/rsr_number/g/ and sync every SKU in
//                     that shard (the full-sync building block — run shards
//                     one at a time, never all 30k products at once).
//   ?hi-only=1        with ?skus= or ?shard=: download ONLY the high-res
//                     mirrors (standard is owned by the drive rebuild).
//                     For ?shard= the HI tree is listed, so only SKUs that
//                     actually have hi files are attempted. Existing
//                     standard entries are preserved and existing hi
//                     entries are kept when a pass finds no new hi, so hi
//                     passes and drive rebuilds merge in either order.
//   ?prefix=aa        with ?shard= or ?skus=: only SKUs starting with that
//                     prefix (splits a shard into small batches that fit
//                     the 15-minute background cap).
//   Progress is saved every 200 SKUs (with a progress log line, so the
//   log visibly advances instead of staying quiet). In hi-only mode,
//   SKUs whose hi is already recorded are skipped, so re-triggering a
//   timed-out hi pass resumes instead of restarting.
//
// Env vars (Jonathan sets these in Netlify; NEVER in chat or code):
//   RSR_FTP_*            (already set for the catalog importer)
//   WASABI_BUCKET, WASABI_KEY, WASABI_SECRET (secret), WASABI_REGION
//   WASABI_ENDPOINT      (optional override, else s3.<region>.wasabisys.com)
//   WASABI_PREFIX        (default 'products' — a NEW folder, never the old
//                         site's /ftp_images/ paths, so the old site is untouched)
//   WASABI_HI_PREFIX     (default '<WASABI_PREFIX>-hi', e.g. 'products-hi')
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

// basic-ftp reports a genuinely missing file as a 550 (or "not found").
// Anything else (dropped connection, permission failure, timeout) is NOT
// "no image" — it must surface as an error, never silently become a
// no-images record. (Lesson 2026-10-26: shard 'a' recorded 5,330 SKUs as
// no-images with errors [] because every download failure was swallowed.)
function isNotFoundError(e) {
  const m = String((e && e.message) || e || '').toLowerCase();
  return m.includes('550') || m.includes('not found') || m.includes('no such file') || m.includes('does not exist') || m.includes('enoent');
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
  // Fail CLOSED on load errors (e.g. an expired Blobs token): the caller
  // must abort, never proceed with a fresh manifest — saving that at the
  // end would wipe every existing entry. Only a genuinely absent manifest
  // (get returns null) yields a fresh one.
  const store = blobs.getStore('xl-arms-catalog');
  const m = await store.get('images.json', { type: 'json' });
  if (m && m.images && typeof m.images === 'object') return m;
  return { generated: null, prefix: null, images: {} };
}

exports.handler = async (event) => {
  // Background function: Netlify returns 202 immediately; progress is in
  // the Functions log. The caller does NOT see this summary in the response.
  let ftp = null;
  try {
    const qs = event.queryStringParameters || {};
    const hiOnly = qs['hi-only'] === '1';
    const prefix = process.env.WASABI_PREFIX || 'products';
    const hiPrefix = process.env.WASABI_HI_PREFIX || (prefix + '-hi');
    const hostname = process.env.BUNNY_HOSTNAME || '';
    if (!process.env.WASABI_BUCKET || !process.env.WASABI_KEY || !process.env.WASABI_SECRET) {
      throw new Error('Missing Wasabi env vars — set WASABI_BUCKET, WASABI_KEY, WASABI_SECRET (and WASABI_REGION) in Netlify, then redeploy.');
    }
    const { client: s3, PutObjectCommand, bucket } = wasabiClient();

    ftp = await ftpConnect();
    await ftp.cd('/');

    // A dead FTPS client rejects every later download instantly, so a
    // single data-socket failure must not kill the run: reconnect with a
    // fresh client and retry the same file before giving up on it.
    async function reconnectFtp() {
      try { if (ftp) ftp.close(); } catch (e) { /* already closed */ }
      ftp = await ftpConnect();
      await ftp.cd('/');
    }
    async function downloadRetry(remotePath, maxAttempts = 3) {
      let lastErr = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await downloadOne(ftp, remotePath);
        } catch (e) {
          lastErr = e;
          if (isNotFoundError(e)) throw e; // genuine end of numbering
          if (attempt < maxAttempts) {
            try { await reconnectFtp(); } catch (re) { lastErr = re; }
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }
      throw new Error('FTP_DOWNLOAD:' + (lastErr && lastErr.message ? lastErr.message : String(lastErr)));
    }

    // Decide the SKU list: explicit ?skus=, one ?shard=, or the test default.
    let skus = [];
    if (qs.skus) {
      skus = qs.skus.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (qs.shard) {
      const shard = String(qs.shard).toLowerCase();
      // Hi-only mode lists the HI tree (files are <SKU>_<n>_HR.jpg), so
      // only SKUs that actually have high-res are attempted.
      const tree = hiOnly ? 'ftp_highres_images' : 'ftp_images';
      const pattern = hiOnly ? /^(.+?)_\d+_HR\.jpg$/i : /^(.+?)_\d+\.jpg$/i;
      const list = await ftp.list(`${tree}/rsr_number/${shard}/`);
      const found = new Set();
      for (const entry of list) {
        const m = String(entry.name || '').match(pattern);
        if (m) found.add(m[1]);
      }
      skus = [...found].sort();
    } else {
      const def = process.env.IMAGE_SYNC_TEST_SKUS || 'GLUI4350201';
      skus = def.split(',').map((s) => s.trim()).filter(Boolean);
    }
    // Optional batch split: only SKUs starting with this prefix.
    if (qs.prefix) {
      const p = String(qs.prefix).toLowerCase();
      skus = skus.filter((s) => s.toLowerCase().startsWith(p));
    }

    let blobs;
    try { blobs = require('@netlify/blobs'); } catch {
      throw new Error('@netlify/blobs is not installed.');
    }
    try { blobs.connectLambda(event); } catch (e) { console.warn('connectLambda skipped:', e.message); }
    const manifest = await loadManifest(blobs);
    manifest.prefix = prefix;
    manifest.hiPrefix = hiPrefix;
    const saveManifest = async () => {
      manifest.generated = new Date().toISOString();
      await blobs.getStore('xl-arms-catalog').set('images.json', JSON.stringify(manifest));
    };

    const results = [];
    let consecutiveDlErrors = 0;
    let abortErr = null;
    let sampleDlError = null;
    for (let idx = 0; idx < skus.length; idx++) {
      const sku = skus[idx];
      // Progress + periodic save: a timeout then loses at most the last
      // batch, and (in hi-only mode, via the skip below) the next run
      // resumes instead of restarting. Also ends the "quiet log" problem.
      if (idx > 0 && idx % 200 === 0) {
        await saveManifest();
        console.log('Image sync progress', JSON.stringify({ hiOnly, processed: idx, skusTotal: skus.length, synced: results.filter((r) => r.status === 'ok').length }));
      }
      try {
        const shard = imageShard(sku);
        // Hi-only resume: hi already recorded for this SKU — nothing to do.
        if (hiOnly) {
          const done = manifest.images[sku];
          if (done && done.hiCount > 0) {
            results.push({ sku, status: 'already-done-hi', hiCount: done.hiCount });
            consecutiveDlErrors = 0;
            continue;
          }
        }
        const sizes = [];
        // Hi-only mode skips standard downloads entirely (the drive
        // rebuild owns standard); the standard side is preserved below.
        for (let n = 1; !hiOnly && n <= MAX_IMAGES_PER_SKU; n++) {
          const remote = `ftp_images/rsr_number/${shard}/${sku}_${n}.jpg`;
          let buf;
          try {
            buf = await downloadRetry(remote);
          } catch (e) {
            if (String(e.message || '').startsWith('FTP_DOWNLOAD:')) {
              if (!sampleDlError) sampleDlError = e.message;
              throw e;
            }
            break; // first missing number = no more images for this SKU
          }
          if (!buf || buf.length === 0) break;
          await s3.send(new PutObjectCommand({
            Bucket: bucket, Key: `${prefix}/${sku}/${n}.jpg`,
            Body: buf, ContentType: 'image/jpeg',
          }));
          sizes.push(buf.length);
        }
        // High-res mirror: same numbering, independent loop (a SKU can have
        // fewer hi images than standard, or none at all).
        const hiSizes = [];
        for (let n = 1; n <= MAX_IMAGES_PER_SKU; n++) {
          const remote = `ftp_highres_images/rsr_number/${shard}/${sku}_${n}_HR.jpg`;
          let buf;
          try {
            buf = await downloadRetry(remote);
          } catch (e) {
            if (String(e.message || '').startsWith('FTP_DOWNLOAD:')) throw e;
            break; // first missing number = no more hi images for this SKU
          }
          if (!buf || buf.length === 0) break;
          await s3.send(new PutObjectCommand({
            Bucket: bucket, Key: `${hiPrefix}/${sku}/${n}.jpg`,
            Body: buf, ContentType: 'image/jpeg',
          }));
          hiSizes.push(buf.length);
        }
        const prev = manifest.images[sku];
        // Effective sides: hi-only mode preserves the standard side (owned
        // by the drive rebuild) and keeps existing hi when a pass finds no
        // new hi, so the two tracks merge in either order. In normal mode
        // these are exactly the freshly downloaded sides.
        const effSizes = (hiOnly && prev && prev.sizes) ? prev.sizes : sizes;
        const effHiSizes = (hiOnly && hiSizes.length === 0 && prev && prev.hiSizes) ? prev.hiSizes : hiSizes;
        if (effSizes.length === 0 && effHiSizes.length === 0) { consecutiveDlErrors = 0; results.push({ sku, status: 'no-images-on-ftp' }); continue; }
        const changed = !!prev && JSON.stringify(prev.sizes || []) !== JSON.stringify(effSizes);
        const hiChanged = !!prev && (prev.hiCount || 0) > 0 && JSON.stringify(prev.hiSizes || []) !== JSON.stringify(effHiSizes);
        let purge = 'n/a (new SKU, nothing cached yet)';
        if (changed) {
          try { purge = await bunnyPurgePrefix(hostname, prefix, sku); }
          catch (e) { purge = `FAILED (logged, sync continues): ${e.message}`; }
        }
        let hiPurge = 'n/a (new hi images, nothing cached yet)';
        if (hiChanged) {
          try { hiPurge = await bunnyPurgePrefix(hostname, hiPrefix, sku); }
          catch (e) { hiPurge = `FAILED (logged, sync continues): ${e.message}`; }
        }
        manifest.images[sku] = { count: effSizes.length, sizes: effSizes, hiCount: effHiSizes.length, hiSizes: effHiSizes };
        results.push({ sku, status: 'ok', count: effSizes.length, changed, purge, hiCount: effHiSizes.length, hiChanged, hiPurge });
        consecutiveDlErrors = 0;
      } catch (e) {
        results.push({ sku, status: 'error', error: e.message });
        // 20 straight download failures means the FTP connection (or the
        // path) is broken, not that 20 products lack photos. Stop the run
        // instead of recording thousands of fake no-images: the manifest
        // below still saves everything synced so far.
        if (String(e.message || '').startsWith('FTP_DOWNLOAD:')) {
          consecutiveDlErrors++;
          if (consecutiveDlErrors >= 20) { abortErr = e; break; }
        } else {
          consecutiveDlErrors = 0;
        }
      }
    }

    await saveManifest();
    const ok = results.filter((r) => r.status === 'ok');
    console.log('Image sync OK', JSON.stringify({
      prefix, hiPrefix, hiOnly, skusAttempted: skus.length, synced: ok.length,
      skippedAlreadyDoneHi: results.filter((r) => r.status === 'already-done-hi').length,
      images: ok.reduce((a, r) => a + r.count, 0),
      hiImages: ok.reduce((a, r) => a + (r.hiCount || 0), 0),
      noImages: results.filter((r) => r.status === 'no-images-on-ftp').map((r) => r.sku),
      errors: results.filter((r) => r.status === 'error'),
      purged: results.filter((r) => r.changed).map((r) => r.sku),
      hiPurged: results.filter((r) => r.hiChanged).map((r) => r.sku),
      firstDownloadError: sampleDlError,
      aborted: !!abortErr,
    }));
    if (abortErr) {
      console.error('Image sync ABORTED after 20 consecutive download failures:', abortErr.message);
      return { statusCode: 202, body: JSON.stringify({ ok: false, error: 'Aborted: ' + abortErr.message }) };
    }
    return { statusCode: 202, body: JSON.stringify({ ok: true, note: 'Background image sync started — check Functions log for Image sync OK.' }) };
  } catch (e) {
    console.error('Image sync FAILED:', e.message);
    return { statusCode: 202, body: JSON.stringify({ ok: false, error: e.message }) };
  } finally {
    if (ftp) { try { ftp.close(); } catch (e) { /* ignore */ } }
  }
};
