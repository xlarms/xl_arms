// authnet-charge.js — XL Arms online checkout (Authorize.net via Accept.js).
//
// POST /.netlify/functions/authnet-charge  (redirected as /api/authnet-charge)
//   Charges one order. The browser NEVER sends card numbers here — the card
//   is tokenized in the browser by Authorize.net Accept.js, which returns a
//   one-time opaqueData token (dataDescriptor + dataValue). This function
//   sends that token to Authorize.net createTransactionRequest
//   (authCaptureTransaction) and charges the amount IT computes from the
//   catalog — never the amount the browser claims. Prices and stock are
//   re-checked against the live catalog for every SKU, so a tampered cart
//   can never change what is charged.
//
// GET /.netlify/functions/authnet-charge
//   Returns the PUBLIC checkout config the browser needs to load Accept.js:
//   mode, apiLoginID, clientKey and the Accept.js script URL. The API Login
//   ID and the Public Client Key are public identifiers by design (the
//   Client Key is meant to be embedded in web pages). The Transaction Key
//   is NEVER returned here and NEVER leaves the server.
//   GET ?taxZip=30093&taxState=GA is a lightweight sales-tax lookup for
//   the checkout page display only — the server recomputes tax on every
//   POST, so this never decides what is charged.
//
// Money model (Jonathan — do not change without him):
//   * Norcross pickup: the ONLY money taken online is the $15.00
//     background-check service fee (not a deposit). The customer pays the
//     balance at pickup, after the $15 credit. The order record stores the
//     balance due so staff can see it at the counter.
//   * Ship to FFL: full items total + flat-rate shipping + Georgia sales
//     tax, charged online.
//   * Sales tax: Georgia only, destination-based — pickup = Norcross 6%,
//     ship = the destination's Georgia rate (6–9%), out of state = 0%.
//     Tax is on the items total only. Pickup tax goes into the balance
//     due at pickup — the online charge stays $15.00. Rates from the GA
//     DOR General Rate Chart effective Oct 1, 2026 — see GA_TAX_RATES.
//
// Env vars (Netlify — names only, values set by Jonathan):
//   AUTHNET_MODE=sandbox|live   (default sandbox — a missing setting can
//                                 never charge a live card)
//   AUTHNET_API_LOGIN_ID        (sandbox account while testing; live account
//                                 only when going live — the two are different
//                                 accounts and their keys do not mix)
//   AUTHNET_TRANSACTION_KEY     (secret — never in code, logs, or replies)
//   AUTHNET_CLIENT_KEY          (Public Client Key from the Authorize.net
//                                 merchant interface: Settings > Security
//                                 Settings > General Security Settings)
//   WASABI_BUCKET, WASABI_REGION, WASABI_KEY, WASABI_SECRET (already set)
//   INTAKE_SMTP_PASS            (reused for the order email — same mailbox
//                                 as the pickup-intake alert)
//
// Order records: stored in Wasabi under orders-private/<orderId>/record.json
// (same bucket, same AES256 encryption, never on the CDN — the intake
// pattern). A staff alert email goes to info@xlarms.us. Email failure never
// fails an order that is already charged — the record is stored first and
// the failure is logged.

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// --- Money: single source of truth for what an order costs. ---
// PICKUP_FEE_CENTS: the $15.00 background-check service fee — the ONLY
// money taken online for a Norcross pickup order.
const PICKUP_FEE_CENTS = 1500;
// TODO (Jonathan): set the flat-rate shipping charge for ship-to-FFL orders.
// Until this is set, ship-to-FFL orders are charged the items total only
// ($0 shipping). Do NOT invent a price here — Jonathan sets this number.
const SHIPPING_FLAT_RATE_CENTS = 0;

// --- Georgia sales tax (destination-based; out of state = 0%). ---
// Georgia's combined rate is 4% state + 2-5% local, 6% to 9% by
// jurisdiction. Rates below are from the Georgia Department of Revenue
// General Rate Chart effective October 1, 2026, joined to Georgia ZIP
// codes via a ZIP-to-county crosswalk (GeoNames postal data, cross-checked
// against the US Census Bureau 2010 ZCTA relationship files), with the
// DOR's city-defined special districts applied where the city holds most
// of a ZIP's population: Atlanta 8.9%, Hapeville 8.75%, East Point 8.75%,
// College Park 8.75% (Fulton part) / 9% (Clayton part). DOR rates change
// quarterly - re-check the chart each quarter and update this table.
// Tax applies to the ITEMS total only. NOTE: shipping is $0 today; if a
// shipping rate is ever set, confirm whether the shipping charge itself
// is taxable in Georgia before adding it to the taxable base.
const GA_TAX_RATES = {
  "30002":8, "30003":6, "30004":7.75, "30005":7.75, "30006":6, "30007":6, "30008":6, "30009":7.75,
  "30010":6, "30011":8, "30012":7, "30013":7, "30014":7, "30015":7, "30016":7, "30017":6,
  "30018":7, "30019":6, "30021":8, "30022":7.75, "30023":7.75, "30024":6, "30025":7, "30026":6,
  "30028":7, "30029":6, "30030":8, "30031":8, "30032":8, "30033":8, "30034":8, "30035":8,
  "30036":8, "30037":8, "30038":8, "30039":6, "30040":7, "30041":7, "30042":6, "30043":6,
  "30044":6, "30045":6, "30046":6, "30047":6, "30048":6, "30049":6, "30052":7, "30054":7,
  "30055":8, "30056":8, "30058":8, "30060":6, "30061":6, "30062":6, "30063":6, "30064":6,
  "30065":6, "30066":6, "30067":6, "30068":6, "30069":6, "30070":7, "30071":6, "30072":8,
  "30074":8, "30075":7.75, "30076":7.75, "30077":7.75, "30078":6, "30079":8, "30080":6, "30081":6,
  "30082":6, "30083":8, "30084":8, "30085":8, "30086":8, "30087":8, "30088":8, "30090":6,
  "30091":6, "30092":6, "30093":6, "30094":7, "30095":6, "30096":6, "30097":7.75, "30098":6,
  "30099":6, "30101":6, "30102":7, "30103":7, "30104":7, "30105":7, "30106":6, "30107":7,
  "30108":7, "30109":7, "30110":8, "30111":6, "30112":7, "30113":8, "30114":7, "30115":7,
  "30116":7, "30117":7, "30118":7, "30119":7, "30120":7, "30121":7, "30122":7, "30123":7,
  "30124":7, "30125":7, "30126":6, "30127":6, "30129":7, "30132":7, "30133":7, "30134":7,
  "30135":7, "30137":7, "30138":7, "30139":8, "30140":8, "30141":7, "30142":7, "30143":7,
  "30144":6, "30145":7, "30146":7, "30147":7, "30148":7, "30149":7, "30150":7, "30151":7,
  "30152":6, "30153":7, "30154":7, "30156":6, "30157":7, "30160":6, "30161":7, "30162":7,
  "30163":7, "30164":7, "30165":7, "30168":6, "30169":7, "30170":7, "30171":7, "30172":7,
  "30173":7, "30175":7, "30176":8, "30177":7, "30178":7, "30179":7, "30180":7, "30182":7,
  "30183":7, "30184":7, "30185":7, "30187":7, "30188":7, "30189":7, "30204":9, "30205":7,
  "30206":7, "30212":7, "30213":7.75, "30214":7, "30215":7, "30216":8, "30217":8, "30218":8,
  "30220":8, "30222":8, "30223":7, "30224":7, "30228":8, "30229":8, "30230":7, "30233":8,
  "30234":8, "30236":8, "30237":8, "30238":8, "30240":7, "30241":7, "30248":8, "30250":8,
  "30251":8, "30252":8, "30253":8, "30256":7, "30257":9, "30258":7, "30259":8, "30260":8,
  "30261":7, "30263":8, "30264":8, "30265":8, "30266":7, "30268":7.75, "30269":7, "30270":7,
  "30271":8, "30272":7.75, "30273":8, "30274":8, "30275":8, "30276":8, "30277":8, "30281":8,
  "30284":7, "30285":9, "30286":9, "30287":8, "30288":8, "30289":8, "30290":7, "30291":7.75,
  "30292":7, "30293":8, "30294":8, "30295":7, "30296":8, "30297":8, "30298":8, "30301":8.9,
  "30302":8.9, "30303":8.9, "30304":8.9, "30305":8.9, "30306":8.9, "30307":8.9, "30308":8.9, "30309":8.9,
  "30310":8.9, "30311":8.9, "30312":8.9, "30313":8.9, "30314":8.9, "30315":8.9, "30316":8, "30317":8.9,
  "30318":8.9, "30319":8, "30320":7.75, "30321":7.75, "30322":8, "30324":8.9, "30325":7.75, "30326":8.9,
  "30327":8.9, "30328":7.75, "30329":8, "30331":8.9, "30332":8.9, "30333":8, "30334":8.9, "30336":7.75,
  "30337":8.75, "30338":8, "30339":6, "30340":8, "30341":8, "30342":7.75, "30343":7.75, "30344":8.75,
  "30345":8, "30346":8, "30348":7.75, "30349":7.75, "30350":7.75, "30353":7.75, "30354":8.9, "30355":7.75,
  "30356":8, "30357":7.75, "30358":7.75, "30359":8, "30360":8, "30361":7.75, "30362":8, "30363":8.9,
  "30364":7.75, "30366":8, "30368":7.75, "30369":7.75, "30370":7.75, "30371":7.75, "30374":7.75, "30375":7.75,
  "30377":7.75, "30378":7.75, "30380":7.75, "30384":7.75, "30385":7.75, "30388":7.75, "30392":7.75, "30394":7.75,
  "30396":7.75, "30398":7.75, "30401":9, "30410":8, "30411":8, "30412":8, "30413":9, "30414":9,
  "30415":9, "30417":9, "30420":9, "30421":9, "30423":9, "30424":8, "30425":9, "30426":7,
  "30427":9, "30428":8, "30429":9, "30434":9, "30436":8, "30438":9, "30439":9, "30441":9,
  "30442":9, "30445":8, "30446":8, "30447":9, "30448":9, "30449":8, "30450":9, "30451":9,
  "30452":9, "30453":9, "30454":8, "30455":8, "30456":7, "30457":8, "30458":9, "30459":9,
  "30460":9, "30461":9, "30464":9, "30467":8, "30470":8, "30471":9, "30473":8, "30474":8,
  "30475":8, "30477":9, "30499":9, "30501":7, "30502":7, "30503":7, "30504":7, "30506":7,
  "30507":7, "30510":7, "30511":9, "30512":7, "30513":7, "30514":7, "30515":6, "30516":7,
  "30517":8, "30518":6, "30519":6, "30520":7, "30521":7, "30522":7, "30523":7, "30525":8,
  "30527":7, "30528":8, "30529":8, "30530":9, "30531":7, "30533":8, "30534":8, "30535":7,
  "30536":7, "30537":8, "30538":7, "30539":7, "30540":7, "30541":7, "30542":7, "30543":7,
  "30545":8, "30546":7, "30547":9, "30548":8, "30549":8, "30552":8, "30553":7, "30554":7,
  "30555":7, "30557":7, "30558":8, "30559":7, "30560":7, "30562":8, "30563":7, "30564":7,
  "30565":8, "30566":7, "30567":8, "30568":8, "30571":8, "30572":7, "30573":8, "30575":8,
  "30576":8, "30577":7, "30580":7, "30581":8, "30582":7, "30597":8, "30598":7, "30599":8,
  "30601":8, "30602":8, "30603":8, "30604":8, "30605":8, "30606":8, "30607":8, "30608":8,
  "30609":8, "30612":8, "30619":9, "30620":8, "30621":8, "30622":8, "30623":8, "30624":9,
  "30625":8, "30627":9, "30628":7, "30629":7, "30630":9, "30631":8, "30633":7, "30634":9,
  "30635":9, "30638":8, "30639":7, "30641":7, "30642":8, "30643":7, "30645":8, "30646":7,
  "30647":7, "30648":9, "30650":8, "30655":7, "30656":7, "30660":9, "30662":7, "30663":8,
  "30664":8, "30665":8, "30666":8, "30667":9, "30668":9, "30669":8, "30671":9, "30673":9,
  "30677":8, "30678":8, "30680":8, "30683":8, "30701":8, "30703":8, "30705":9, "30707":8,
  "30708":9, "30710":7, "30711":9, "30719":7, "30720":7, "30721":7, "30722":7, "30724":9,
  "30725":8, "30726":7, "30728":8, "30730":9, "30731":9, "30732":8, "30733":8, "30734":8,
  "30735":8, "30736":7, "30738":7, "30739":8, "30740":7, "30741":8, "30742":7, "30746":8,
  "30747":9, "30750":8, "30751":9, "30752":7, "30753":9, "30755":7, "30756":7, "30757":7,
  "30802":8, "30803":9, "30805":9, "30806":9, "30807":9, "30808":9, "30809":8, "30810":8,
  "30811":7, "30812":9, "30813":8, "30814":8, "30815":9, "30816":7, "30817":9, "30818":9,
  "30819":9, "30820":8, "30821":9, "30822":9, "30823":9, "30824":9, "30828":9, "30830":7,
  "30833":9, "30901":9, "30903":9, "30904":9, "30905":9, "30906":9, "30907":8, "30909":9,
  "30912":9, "30914":9, "30916":9, "30917":8, "30919":9, "30999":9, "31001":9, "31002":9,
  "31003":7, "31004":9, "31005":8, "31006":8, "31007":8, "31008":9, "31009":8, "31010":8,
  "31011":8, "31012":8, "31013":8, "31014":8, "31015":8, "31016":9, "31017":8, "31018":9,
  "31019":8, "31020":8, "31021":8, "31022":8, "31023":8, "31024":8, "31025":8, "31026":8,
  "31027":8, "31028":8, "31029":9, "31030":9, "31031":7, "31032":7, "31033":7, "31034":8,
  "31035":9, "31036":8, "31037":8, "31038":8, "31039":8, "31040":8, "31041":8, "31042":7,
  "31044":8, "31045":9, "31046":9, "31047":8, "31049":8, "31050":8, "31051":8, "31052":8,
  "31054":7, "31055":8, "31057":8, "31058":8, "31059":8, "31060":8, "31061":8, "31062":8,
  "31063":8, "31064":8, "31065":8, "31066":8, "31067":9, "31068":8, "31069":8, "31070":8,
  "31071":9, "31072":9, "31075":8, "31076":8, "31077":8, "31078":8, "31079":9, "31081":8,
  "31082":9, "31083":8, "31084":9, "31085":8, "31086":9, "31087":8, "31088":8, "31089":9,
  "31090":7, "31091":8, "31092":8, "31093":8, "31094":9, "31095":8, "31096":8, "31097":9,
  "31098":8, "31099":8, "31106":7.75, "31107":7.75, "31119":8, "31126":7.75, "31131":7.75, "31136":7.75,
  "31139":7.75, "31141":8, "31144":6, "31145":8, "31146":8, "31150":7.75, "31156":7.75, "31169":7,
  "31192":7.75, "31193":7.75, "31195":7.75, "31196":7.75, "31201":8, "31202":8, "31203":8, "31204":8,
  "31205":8, "31206":8, "31207":8, "31208":8, "31209":8, "31210":8, "31211":8, "31213":8,
  "31216":8, "31217":8, "31220":8, "31221":8, "31294":8, "31295":8, "31296":8, "31297":8,
  "31301":9, "31302":8, "31303":8, "31304":8, "31305":8, "31307":8, "31308":9, "31309":9,
  "31310":9, "31312":8, "31313":9, "31314":9, "31315":9, "31316":9, "31318":8, "31319":8,
  "31320":9, "31321":9, "31322":7, "31323":9, "31324":9, "31326":8, "31327":8, "31328":7,
  "31329":8, "31331":8, "31333":9, "31401":7, "31402":7, "31403":7, "31404":7, "31405":7,
  "31406":7, "31407":7, "31408":7, "31409":7, "31410":7, "31411":7, "31412":7, "31414":7,
  "31415":7, "31416":7, "31418":7, "31419":7, "31420":7, "31421":7, "31501":8, "31502":8,
  "31503":8, "31510":8, "31512":8, "31513":8, "31515":8, "31516":8, "31518":8, "31519":8,
  "31520":7, "31521":7, "31522":7, "31523":7, "31524":7, "31525":7, "31527":7, "31532":8,
  "31533":8, "31534":8, "31535":8, "31537":8, "31539":8, "31542":8, "31543":8, "31544":8,
  "31545":8, "31546":8, "31547":7, "31548":7, "31549":8, "31550":8, "31551":8, "31552":8,
  "31553":8, "31554":8, "31555":8, "31556":8, "31557":8, "31558":7, "31560":8, "31561":7,
  "31562":8, "31563":8, "31564":8, "31565":7, "31566":8, "31567":8, "31568":7, "31569":7,
  "31598":8, "31599":8, "31601":8, "31602":8, "31603":8, "31604":8, "31605":8, "31606":8,
  "31620":9, "31622":9, "31623":8, "31624":8, "31625":8, "31626":8, "31627":9, "31629":8,
  "31630":8, "31631":8, "31632":8, "31634":8, "31635":8, "31636":8, "31637":9, "31638":8,
  "31639":9, "31641":8, "31642":8, "31643":8, "31645":9, "31647":9, "31648":8, "31649":8,
  "31650":8, "31698":8, "31699":8, "31701":9, "31702":9, "31703":9, "31704":9, "31705":9,
  "31706":9, "31707":9, "31708":9, "31709":8, "31711":8, "31712":8, "31714":9, "31716":8,
  "31719":8, "31720":8, "31721":9, "31722":9, "31727":8, "31730":8, "31733":8, "31735":8,
  "31738":8, "31739":8, "31743":8, "31744":9, "31747":9, "31749":9, "31750":8, "31753":9,
  "31756":9, "31757":8, "31758":8, "31760":8, "31763":8, "31764":8, "31765":8, "31768":9,
  "31769":8, "31771":9, "31772":8, "31773":8, "31774":8, "31775":8, "31776":9, "31778":8,
  "31779":8, "31780":8, "31781":8, "31782":9, "31783":9, "31784":8, "31787":8, "31788":9,
  "31789":8, "31790":9, "31791":8, "31792":8, "31793":8, "31794":8, "31795":8, "31796":8,
  "31798":8, "31799":8, "31801":8, "31803":8, "31804":8, "31805":9, "31806":9, "31807":8,
  "31808":8, "31810":8, "31811":8, "31812":8, "31814":8, "31815":8, "31816":8, "31820":9,
  "31821":8, "31822":8, "31823":8, "31824":8, "31825":8, "31826":8, "31827":8, "31829":9,
  "31830":8, "31831":8, "31832":8, "31833":7, "31836":8, "31901":9, "31902":9, "31903":9,
  "31904":9, "31905":9, "31906":9, "31907":9, "31908":9, "31909":9, "31914":9, "31917":9,
  "31993":9, "31995":9, "31997":9, "31998":9, "31999":9, "39813":8, "39815":9, "39817":9,
  "39818":9, "39819":9, "39823":8, "39824":9, "39825":9, "39826":8, "39827":8, "39828":8,
  "39829":8, "39832":8, "39834":9, "39836":9, "39837":9, "39840":8, "39841":8, "39842":8,
  "39845":8, "39846":8, "39851":9, "39852":9, "39854":8, "39859":8, "39861":8, "39862":8,
  "39866":8, "39867":9, "39870":8, "39877":8, "39885":8, "39886":8, "39897":8, "39901":8
};
// Statewide minimum (Norcross/Gwinnett, Cobb, and the fallback for a
// Georgia ZIP missing from the table).
const GA_TAX_MIN = 0.06;
// Returns { rate, known } for a Georgia destination ZIP. known=false
// when the ZIP is not a usable Georgia ZIP in the table - the caller
// (POST) still charges the 6% minimum and logs the gap; the front-end
// display treats unknown as "calculated at checkout".
function georgiaTaxLookup(zip) {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (/^\d{5}$/.test(z)) {
    const pct = GA_TAX_RATES[z];
    // Round to 4 decimals so 8.9% is 0.089, not 0.08900000000000001.
    if (pct != null) return { rate: Math.round(pct * 100) / 10000, known: true };
    console.error('authnet-charge: no Georgia tax rate for ZIP ' + z + ' - using 6% minimum; fix the table.');
  } else {
    console.error('authnet-charge: no usable Georgia destination ZIP - using 6% minimum.');
  }
  return { rate: GA_TAX_MIN, known: false };
}
// Decimal rate for a Georgia destination ZIP (6% fallback for unknown).
function georgiaTaxRate(zip) {
  return georgiaTaxLookup(zip).rate;
}
// "8.9" from 0.089 - percent with trailing zeros stripped (for labels).
function ratePct(rate) {
  return String(Math.round(Number(rate || 0) * 10000) / 100);
}

const ORDERS_PREFIX = 'orders-private';
const PHONE = '(678) 691-6375';
const ALERT_FROM = 'storage@xlarms.us';
const ALERT_TO = 'info@xlarms.us';
const MAX_LINES = 100;
const MAX_QTY = 99;

function mode() {
  return (process.env.AUTHNET_MODE || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
}
function apiUrl(m) {
  return m === 'live'
    ? 'https://api.authorize.net/xml/v1/request.api'
    : 'https://apitest.authorize.net/xml/v1/request.api';
}
function acceptJsUrl(m) {
  return m === 'live'
    ? 'https://js.authorize.net/v1/Accept.js'
    : 'https://jstest.authorize.net/v1/Accept.js';
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
function fail(statusCode, message) {
  return json(statusCode, { ok: false, error: message, phone: PHONE });
}
const centsToDollars = (c) => (c / 100).toFixed(2);
const money = (c) => '$' + centsToDollars(c);
const s = (v) => String(v == null ? '' : v).trim();
const toCents = (price) => Math.round(Number(price || 0) * 100);

function wasabiClient() {
  const region = process.env.WASABI_REGION || 'us-east-1';
  const endpoint = process.env.WASABI_ENDPOINT || `https://s3.${region}.wasabisys.com`;
  return {
    client: new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.WASABI_KEY,
        secretAccessKey: process.env.WASABI_SECRET,
      },
    }),
    bucket: process.env.WASABI_BUCKET,
  };
}

// --- Catalog lookup: same pattern as get-products.js. Primary source is
// the per-letter full-index chunk in the Blobs store (rebuilt daily);
// fallback is the bundled data/products.json sample, so a Blobs outage
// does not take checkout down entirely (it can only price the SKUs in
// that file — anything else fails closed with "not found").
async function loadSkuChunk(event, sku) {
  const first = String(sku || '')[0] ? String(sku)[0].toUpperCase() : '0';
  const key = /^[A-Z]$/.test(first) ? first : '0';
  try {
    const { getStore, connectLambda } = require('@netlify/blobs');
    try { connectLambda(event); } catch (e) {}
    const chunk = await getStore('xl-arms-catalog').get(`full-index-${key}.json`, { type: 'json' });
    if (chunk && Array.isArray(chunk.products)) return chunk.products;
  } catch (e) { /* fall through to the bundled file */ }
  return null;
}
async function loadCatalogFallback() {
  try {
    const fs = require('fs');
    const path = require('path');
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'products.json'), 'utf8'));
    return Array.isArray(d.products) ? d.products : [];
  } catch (e) { return []; }
}
// Returns a Map of upper-case SKU -> { sku, title, price, stock_qty, is_firearm }
// for exactly the SKUs in the order. Throws a customer-facing message on
// any problem (unknown SKU, unpriced, out of stock, not enough stock).
async function priceOrderItems(event, items) {
  const wanted = new Map();
  for (const it of items) wanted.set(String(it.sku).toUpperCase(), it);
  const byLetter = {};
  for (const sku of wanted.keys()) {
    const first = /^[A-Z]$/.test(sku[0]) ? sku[0] : '0';
    (byLetter[first] = byLetter[first] || []).push(sku);
  }
  const found = new Map();
  for (const letter of Object.keys(byLetter)) {
    const chunk = await loadSkuChunk(event, byLetter[letter][0]);
    if (!chunk) continue;
    for (const p of chunk) {
      const up = String(p.sku || '').toUpperCase();
      if (wanted.has(up)) found.set(up, p);
    }
  }
  const missing = [...wanted.keys()].filter((sku) => !found.has(sku));
  if (missing.length) {
    // Last resort: the bundled sample file (covers its SKUs only).
    const fallback = await loadCatalogFallback();
    for (const p of fallback) {
      const up = String(p.sku || '').toUpperCase();
      if (wanted.has(up) && !found.has(up)) found.set(up, p);
    }
  }
  const stillMissing = [...wanted.keys()].filter((sku) => !found.has(sku));
  if (stillMissing.length) {
    throw new Error(`We could not price this item right now (${stillMissing[0]}). Please call ${PHONE} and we will take the order by phone.`);
  }
  const lines = [];
  let itemsCents = 0;
  for (const it of items) {
    const p = found.get(String(it.sku).toUpperCase());
    const unitCents = toCents(p.price);
    if (!(unitCents > 0)) {
      throw new Error(`"${p.title}" is priced on request — please call ${PHONE} for a price.`);
    }
    if (!(p.stock_qty > 0)) {
      throw new Error(`"${p.title}" is out of stock — please call ${PHONE} and we will help.`);
    }
    if (it.qty > p.stock_qty) {
      throw new Error(`Only ${p.stock_qty} of "${p.title}" are in stock — please lower the quantity or call ${PHONE}.`);
    }
    const lineCents = unitCents * it.qty;
    itemsCents += lineCents;
    lines.push({
      sku: p.sku,
      title: p.title,
      price: unitCents / 100,
      qty: it.qty,
      lineTotal: lineCents / 100,
      is_firearm: !!p.is_firearm,
    });
  }
  return { lines, itemsCents };
}

function authnetErrorText(ctr) {
  // Prefer the transaction-level error (declines), then the top-level
  // message (bad request / bad credentials). Never include credentials.
  try {
    const tr = ctr && ctr.transactionResponse;
    if (tr && Array.isArray(tr.errors) && tr.errors[0] && tr.errors[0].errorText) {
      return tr.errors[0].errorText;
    }
    if (tr && Array.isArray(tr.messages) && tr.messages[0] && tr.messages[0].description) {
      return tr.messages[0].description;
    }
    if (ctr && ctr.messages && Array.isArray(ctr.messages.message) && ctr.messages.message[0]) {
      const m = ctr.messages.message[0];
      return m.text || m.code || 'Payment could not be processed.';
    }
  } catch (e) { /* fall through */ }
  return 'Payment could not be processed.';
}

exports.handler = async (event) => {
  // --- GET: public checkout config (no secrets). ---
  if (event.httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};
    // Lightweight tax lookup for the checkout page display only
    // (GET /api/authnet-charge?taxZip=30093&taxState=GA). The server
    // recomputes tax on every POST — this never decides what is charged.
    if (qs.taxZip !== undefined || qs.taxState !== undefined) {
      const st = String(qs.taxState || '').toUpperCase();
      if (st && st !== 'GA') {
        return json(200, { ok: true, taxable: false, rate: 0, state: st });
      }
      if (st === 'GA') {
        const lk = georgiaTaxLookup(qs.taxZip);
        return json(200, { ok: true, taxable: true, rate: lk.rate, known: lk.known, state: 'GA' });
      }
      // No state given: a ZIP in the table is a Georgia ZIP; anything else
      // is unknown (could be out of state or a GA ZIP missing from the table).
      const z = String(qs.taxZip || '').replace(/\D/g, '').slice(0, 5);
      if (/^\d{5}$/.test(z) && GA_TAX_RATES[z] != null) {
        return json(200, { ok: true, taxable: true, rate: Math.round(GA_TAX_RATES[z] * 100) / 10000, known: true, state: 'GA' });
      }
      return json(200, { ok: true, taxable: true, rate: GA_TAX_MIN, known: false, state: '' });
    }
    const m = mode();
    const configured = Boolean(
      process.env.AUTHNET_API_LOGIN_ID &&
      process.env.AUTHNET_TRANSACTION_KEY &&
      process.env.AUTHNET_CLIENT_KEY,
    );
    return json(200, {
      ok: true,
      mode: m,
      apiLoginID: process.env.AUTHNET_API_LOGIN_ID || '',
      clientKey: process.env.AUTHNET_CLIENT_KEY || '',
      acceptJsUrl: acceptJsUrl(m),
      shippingFlatRate: SHIPPING_FLAT_RATE_CENTS / 100,
      pickupFee: PICKUP_FEE_CENTS / 100,
      configured,
    });
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }

  const m = mode();
  const apiLoginID = process.env.AUTHNET_API_LOGIN_ID;
  const transactionKey = process.env.AUTHNET_TRANSACTION_KEY;
  const clientKey = process.env.AUTHNET_CLIENT_KEY;
  if (!apiLoginID || !transactionKey || !clientKey) {
    console.error('authnet-charge: Authorize.net env vars not set (AUTHNET_API_LOGIN_ID / AUTHNET_TRANSACTION_KEY / AUTHNET_CLIENT_KEY)');
    return fail(503, `Online checkout is not set up yet. Please call ${PHONE} and we will take your order by phone.`);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return fail(400, 'We could not read the order. Please try again or call ' + PHONE + '.');
  }

  // --- Validate the order (everything the browser claims is re-checked). ---
  const fulfillment = s(body.fulfillment);
  if (fulfillment !== 'pickup' && fulfillment !== 'ship') {
    return fail(400, 'Choose pickup or ship to FFL.');
  }
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_LINES) {
    return fail(400, 'Your cart is empty or too large. Please call ' + PHONE + '.');
  }
  const items = [];
  for (const it of body.items) {
    const sku = s(it && it.sku);
    const qty = Number(it && it.qty);
    if (!sku || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      return fail(400, 'Your cart has an item we could not read. Please call ' + PHONE + '.');
    }
    items.push({ sku, qty });
  }
  const firstName = s(body.firstName);
  const lastName = s(body.lastName);
  const phone = s(body.phone);
  const email = s(body.email);
  const billingZip = s(body.billingZip);
  if (!firstName || !lastName) return fail(400, 'Full name is required.');
  if (!phone) return fail(400, 'Phone number is required.');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'A valid email address is required.');
  if (!/^\d{5}(-\d{4})?$/.test(billingZip)) return fail(400, 'Billing ZIP code is required.');

  const pickupDay = s(body.pickupDay);
  let ffl = null;
  let shippingAddress = null;
  if (fulfillment === 'ship') {
    // The FFL rule is decided AFTER pricing (below) because it depends on
    // whether the cart actually contains a firearm — see priceOrderItems.
    ffl = body.ffl || null;
    shippingAddress = body.shippingAddress || null;
  }

  const od = body.opaqueData || {};
  const dataDescriptor = s(od.dataDescriptor);
  const dataValue = s(od.dataValue);
  if (!dataDescriptor || !dataValue) {
    return fail(400, 'The card could not be read. Please check the card details and try again, or call ' + PHONE + '.');
  }

  // --- Price the order from the catalog (never trust the browser's total). ---
  let priced;
  try {
    priced = await priceOrderItems(event, items);
  } catch (e) {
    return fail(400, e.message);
  }
  const { lines, itemsCents } = priced;
  const hasFirearm = lines.some((l) => l.is_firearm);

  if (fulfillment === 'ship') {
    if (hasFirearm) {
      const f = ffl || {};
      if (!s(f.name) || !s(f.city) || !s(f.state)) {
        return fail(400, 'A receiving FFL is required for a firearm order — name, city and state at minimum. Pick one from the dealer search or enter it manually.');
      }
      ffl = { name: s(f.name), street: s(f.street), city: s(f.city), state: s(f.state).toUpperCase(), zip: s(f.zip) };
    } else {
      const a = shippingAddress || {};
      if (!s(a.street) || !s(a.city) || !s(a.state) || !/^\d{5}(-\d{4})?$/.test(s(a.zip))) {
        return fail(400, 'A shipping address is required — street, city, state and ZIP.');
      }
      shippingAddress = { street: s(a.street), city: s(a.city), state: s(a.state).toUpperCase(), zip: s(a.zip) };
    }
  }

  // --- Georgia sales tax (destination-based; out of state = 0%). ---
  // Pickup is always Norcross (Gwinnett County, 6%). Ship uses the
  // destination ZIP: the receiving FFL's ZIP for a firearm order, the
  // shipping-address ZIP otherwise. Tax is on the ITEMS total only.
  // NOTE: shipping is $0 today. If a shipping rate is ever set, confirm
  // whether the shipping charge itself is taxable in Georgia before
  // adding it to the taxable base.
  let taxRate = 0;
  if (fulfillment === 'pickup') {
    taxRate = 0.06; // Norcross pickup — Gwinnett County, DOR chart Oct 1 2026
  } else if (fulfillment === 'ship') {
    const destState = hasFirearm ? (ffl && ffl.state) : (shippingAddress && shippingAddress.state);
    if (destState === 'GA') {
      const destZip = hasFirearm ? (ffl && ffl.zip) : (shippingAddress && shippingAddress.zip);
      taxRate = georgiaTaxRate(destZip);
    }
  }
  const taxCents = Math.round(itemsCents * taxRate);

  // --- Amount: pickup = $15 fee only (tax goes into the balance due at
  // pickup); ship = items + shipping + tax, charged online. ---
  const shippingCents = fulfillment === 'ship' ? SHIPPING_FLAT_RATE_CENTS : 0;
  const chargeCents = fulfillment === 'pickup' ? PICKUP_FEE_CENTS : itemsCents + shippingCents + taxCents;
  const balanceDueCents = fulfillment === 'pickup' ? Math.max(0, itemsCents - PICKUP_FEE_CENTS + taxCents) : 0;
  if (!(chargeCents > 0)) {
    return fail(400, 'This order has no chargeable amount. Please call ' + PHONE + '.');
  }

  // Order ID: ORD-YYYYMMDD-XXXXXX (19 chars — fits Authorize.net's 20-char
  // invoiceNumber / refId limits).
  const now = new Date();
  const orderId = `ORD-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;

  // --- Charge via Authorize.net (authCapture = authorize + capture). ---
  const lineItems = lines.length <= 30 ? {
    lineItem: lines.map((l) => ({
      itemId: String(l.sku).slice(0, 31),
      name: String(l.title).slice(0, 31),
      description: String(l.sku).slice(0, 255),
      quantity: String(l.qty),
      unitPrice: centsToDollars(toCents(l.price)),
    })).concat(
      // Sales tax as its own line item, when it fits under Authorize.net's
      // 30-line limit (skipped silently otherwise — the tax is still in
      // the charged amount and the order record).
      (taxCents > 0 && lines.length < 30)
        ? [{ itemId: 'SALES-TAX-GA', name: 'Sales tax (GA ' + ratePct(taxRate) + '%)', description: 'Georgia sales tax', quantity: '1', unitPrice: centsToDollars(taxCents) }]
        : [],
    ),
  } : undefined;

  const payload = {
    createTransactionRequest: {
      merchantAuthentication: { name: apiLoginID, transactionKey },
      refId: orderId,
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: centsToDollars(chargeCents),
        payment: { opaqueData: { dataDescriptor, dataValue } },
        order: {
          invoiceNumber: orderId,
          description: fulfillment === 'pickup'
            ? 'XL Arms online order — Norcross pickup ($15 service fee)'
            : 'XL Arms online order — Ship to FFL',
        },
        ...(lineItems ? { lineItems } : {}),
        // NOTE: key order matters — Authorize.net converts this JSON to XML
        // and validates the element sequence strictly. The schema requires
        // `customer` BEFORE `billTo` inside transactionRequest; the reverse
        // order is rejected with a schema error (found live 2026-11-18).
        customer: { email },
        billTo: { firstName, lastName, zip: billingZip },
        transactionSettings: {
          setting: [{ settingName: 'duplicateWindow', settingValue: '120' }],
        },
      },
    },
  };

  let ctr;
  let gatewayError = null;
  let data = null;
  try {
    const res = await fetch(apiUrl(m), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    try { data = JSON.parse(text); } catch (e) { /* non-JSON reply */ }
    ctr = data && data.createTransactionResponse;
    // Authorize.net returns some gateway-level errors (e.g. E00007
    // authentication failure) in a flat format with no
    // createTransactionResponse wrapper — surface the real reason instead
    // of the generic "did not answer" message.
    if (!ctr && data && data.messages && Array.isArray(data.messages.message) && data.messages.message[0]) {
      const em = data.messages.message[0];
      gatewayError = (em.text || em.code || '').toString();
    }
    if (!ctr && !data) {
      console.error('authnet-charge: non-JSON reply from Authorize.net, HTTP', res.status, String(text).slice(0, 200));
    }
  } catch (e) {
    console.error('authnet-charge: Authorize.net request failed:', e && e.message);
    return fail(502, `The payment system did not answer. Nothing was charged. Please try again or call ${PHONE}.`);
  }
  // Test mode (Transaction Processing Mode disabled) never creates a
  // transaction: the gateway answers with a flat "Successful." and no
  // createTransactionResponse at all. Treat that as a test approval —
  // no money moves and there is no transaction ID — so the checkout flow
  // can be verified end to end. A real (processing-on) approval always
  // carries a transactionResponse, so this can never mark a live charge
  // as paid.
  let testMode = false;
  if (!ctr && data && data.messages && data.messages.resultCode === 'Ok') {
    testMode = true;
    ctr = {
      messages: data.messages,
      transactionResponse: {
        responseCode: '1',
        transId: '0',
        authCode: '',
        avsResultCode: '',
        accountType: '',
        accountNumber: '',
      },
    };
    console.log(`authnet-charge ${orderId}: test-mode approval (no transaction created, transId 0).`);
  }
  if (!ctr) {
    console.error('authnet-charge: no createTransactionResponse from Authorize.net', gatewayError || '');
    if (gatewayError) {
      return fail(400, gatewayError + ' Nothing was charged. Please try again or call ' + PHONE + '.');
    }
    return fail(502, `The payment system did not answer. Nothing was charged. Please try again or call ${PHONE}.`);
  }

  const tr = ctr.transactionResponse || {};
  // Log only IDs and codes — never the token, never card data (we never
  // receive card data in the first place).
  console.log(`authnet-charge ${orderId} mode=${m} amount=${money(chargeCents)} resultCode=${ctr.messages && ctr.messages.resultCode} responseCode=${tr.responseCode || ''} transId=${tr.transId || ''}`);

  if (ctr.messages && ctr.messages.resultCode === 'Ok' && tr.responseCode === '1' && tr.transId) {
    // ---- Approved: store the order, then email staff (both best-effort
    // after a successful charge — the customer MUST still get their
    // confirmation even if storage or email has a problem). ----
    const record = {
      id: orderId,
      kind: 'online-order',
      fulfillment,
      items: lines,
      itemsTotal: itemsCents / 100,
      shipping: shippingCents / 100,
      taxRate,            // decimal (0.06, 0.089, …); 0 when not taxable
      tax: taxCents / 100,
      amountCharged: chargeCents / 100,
      balanceDueAtPickup: fulfillment === 'pickup' ? balanceDueCents / 100 : null,
      customer: { firstName, lastName, phone, email, billingZip },
      pickupDay: fulfillment === 'pickup' ? pickupDay : null,
      ffl: fulfillment === 'ship' && hasFirearm ? ffl : null,
      shippingAddress: fulfillment === 'ship' && !hasFirearm ? shippingAddress : null,
      transaction: {
        transId: String(tr.transId),
        authCode: String(tr.authCode || ''),
        responseCode: String(tr.responseCode),
        avsResultCode: String(tr.avsResultCode || ''),
        cardType: String(tr.accountType || ''),
        cardLast4: String(tr.accountNumber || '').replace(/[^0-9]/g, '').slice(-4),
        mode: m,
      },
      submitted_at: now.toISOString(),
      status: testMode ? 'test' : 'paid',
    };

    if (process.env.WASABI_BUCKET && process.env.WASABI_KEY && process.env.WASABI_SECRET) {
      try {
        const { client, bucket } = wasabiClient();
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `${ORDERS_PREFIX}/${orderId}/record.json`,
          Body: Buffer.from(JSON.stringify(record, null, 2), 'utf8'),
          ContentType: 'application/json',
          ServerSideEncryption: 'AES256',
        }));
      } catch (e) {
        console.error(`authnet-charge ${orderId}: order record storage FAILED (charge succeeded):`, e && e.message);
      }
    } else {
      console.error(`authnet-charge ${orderId}: Wasabi env vars not set — order record NOT stored (charge succeeded).`);
    }

    if (process.env.INTAKE_SMTP_PASS) {
      try {
        const mailer = nodemailer.createTransport({
          host: 'mail.xlarms.us',
          port: 465,
          secure: true,
          auth: { user: ALERT_FROM, pass: process.env.INTAKE_SMTP_PASS },
        });
        const itemLines = lines.map((l) => `  - ${l.title} (${l.sku}) x${l.qty} @ ${money(toCents(l.price))} = ${money(toCents(l.lineTotal))}`).join('\n');
        const fflText = record.ffl
          ? `\nReceiving FFL:\n  ${record.ffl.name}\n  ${[record.ffl.street, record.ffl.city, record.ffl.state, record.ffl.zip].filter(Boolean).join(', ')}\n`
          : '';
        const shipText = record.shippingAddress
          ? `\nShip to:\n  ${record.shippingAddress.street}\n  ${record.shippingAddress.city}, ${record.shippingAddress.state} ${record.shippingAddress.zip}\n`
          : '';
        const pickupText = fulfillment === 'pickup'
          ? `\nPickup:\n  Preferred pickup day: ${pickupDay || '(not given)'}\n  Balance due at pickup: ${money(balanceDueCents)} (the $15 fee is credited toward the price)\n  Customer still needs to send the 4473 pre-copy via pickup-intake.html.\n`
          : '';
        const taxText = taxCents > 0 ? `\nSales tax (GA ${ratePct(taxRate)}%): ${money(taxCents)}` : '';
        await mailer.sendMail({
          from: ALERT_FROM,
          to: ALERT_TO,
          subject: `${testMode ? 'TEST — ' : ''}New online order ${orderId} — ${money(chargeCents)} — ${fulfillment === 'pickup' ? 'Norcross pickup' : 'Ship to FFL'}`,
          text: `${testMode ? `TEST approval — no money moved (would charge ${money(chargeCents)} via Authorize.net (${m})).` : `New online order — charged ${money(chargeCents)} via Authorize.net (${m}).`}\n\nOrder: ${orderId}\nAuthorize.net transaction: ${record.transaction.transId} (auth ${record.transaction.authCode || 'n/a'})\nCard: ${record.transaction.cardType || ''} ending ${record.transaction.cardLast4 || 'n/a'}\n\nCustomer: ${firstName} ${lastName}\nPhone: ${phone}\nEmail: ${email}\n\nItems:\n${itemLines}\n\nItems total: ${money(itemsCents)}${fulfillment === 'ship' ? `\nShipping: ${money(shippingCents)}` : ''}${taxText}\nCharged today: ${money(chargeCents)}${pickupText}${fflText}${shipText}\nOrder record: Wasabi ${ORDERS_PREFIX}/${orderId}/record.json\n`,
        });
      } catch (e) {
        console.error(`authnet-charge ${orderId}: order email failed (charge succeeded, record stored):`, e && e.message);
      }
    } else {
      console.log(`authnet-charge ${orderId}: INTAKE_SMTP_PASS not set — no order email sent.`);
    }

    return json(200, {
      ok: true,
      orderId,
      transactionId: String(tr.transId),
      authCode: String(tr.authCode || ''),
      amount: chargeCents / 100,
      tax: taxCents / 100,
      taxRate,
      fulfillment,
      balanceDueAtPickup: fulfillment === 'pickup' ? balanceDueCents / 100 : null,
      mode: m,
      testMode,
    });
  }

  // ---- Not approved: no charge was captured. Show Authorize.net's own
  // error text so the customer knows what to fix. ----
  const errText = authnetErrorText(ctr);
  console.log(`authnet-charge ${orderId}: declined/error — ${errText}`);
  return fail(400, errText + ` Nothing was charged. Please check the card details and try again, or call ${PHONE}.`);
};
