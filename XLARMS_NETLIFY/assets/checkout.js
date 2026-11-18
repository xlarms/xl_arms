// checkout.js — XL Arms online checkout (Authorize.net Accept.js).
//
// Flow: load the public checkout config from /api/authnet-charge (mode,
// apiLoginID, clientKey, Accept.js URL), load that Accept.js script, then
// on Pay: tokenize the card IN THE BROWSER with Accept.dispatchData — the
// card number, expiry and CVV go straight to Authorize.net and NEVER touch
// our server or this site's storage. Accept.js returns a one-time
// opaqueData token, which is POSTed with the order to /api/authnet-charge.
// The server re-prices the cart from the catalog and charges only what IT
// computes.
//
// Money model: pickup = $15.00 service fee only, balance at pickup (after
// the $15 credit). Ship to FFL = items total + flat-rate shipping.
// No sales tax is charged online.
//
// Depends on assets/app.js (getCart, money, esc) — checkout.html loads
// app.js first. If the config endpoint says checkout is not configured,
// the pay button stays disabled and the page says to call instead.

(function () {
  var PHONE = '(678) 691-6375';
  var config = null;          // { mode, apiLoginID, clientKey, acceptJsUrl, shippingFlatRate, pickupFee, configured }
  var acceptReady = false;    // Accept.js script loaded
  var fulfillment = 'pickup'; // 'pickup' | 'ship'
  var selectedFFL = null;     // { name, street, city, state, zip } from the dealer search
  var paying = false;

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }
  function setText(id, t) { var el = $(id); if (el) el.textContent = t; }
  function val(id) { var el = $(id); return el ? el.value.trim() : ''; }

  function cart() {
    try { return (typeof getCart === 'function' ? getCart() : []) || []; } catch (e) { return []; }
  }
  function hasFirearm() { return cart().some(function (i) { return !!i.is_firearm; }); }
  function itemsCents() {
    return cart().reduce(function (a, i) { return a + Math.round(Number(i.price || 0) * 100) * (i.qty || 1); }, 0);
  }
  function shipCents() {
    return (config && typeof config.shippingFlatRate === 'number') ? Math.round(config.shippingFlatRate * 100) : 0;
  }
  function pickupFeeCents() {
    return (config && typeof config.pickupFee === 'number') ? Math.round(config.pickupFee * 100) : 1500;
  }
  // What the customer is charged today, in cents.
  function chargeCents() {
    return fulfillment === 'pickup' ? pickupFeeCents() : itemsCents() + shipCents();
  }
  function balanceDueCents() {
    return fulfillment === 'pickup' ? Math.max(0, itemsCents() - pickupFeeCents()) : 0;
  }

  function renderSummary() {
    var box = $('orderSummary');
    var empty = $('emptyCart');
    var items = cart();
    if (!items.length) {
      show(box, false); show(empty, true);
      setPayEnabled(false);
      return;
    }
    show(empty, false); show(box, true);
    var html = items.map(function (i) {
      var line = Math.round(Number(i.price || 0) * 100) * (i.qty || 1);
      return '<div class="cartitem"><img src="' + esc(i.image || 'images/placeholder.svg') + '" alt=""><div><strong>' + esc(i.title) + '</strong><div class="meta">' + esc(i.sku) + (i.is_firearm ? ' · Ships to your FFL' : '') + '</div><div>' + money(i.price) + ' × ' + (i.qty || 1) + '</div></div><div class="price">' + money(line / 100) + '</div></div>';
    }).join('');
    box.innerHTML = html + '<p class="price">Items total: ' + money(itemsCents() / 100) + '</p>';
    renderTotals();
  }

  function renderTotals() {
    var t = $('totalsBox');
    if (!t) return;
    if (fulfillment === 'pickup') {
      t.innerHTML = '<p>Items total: <strong>' + money(itemsCents() / 100) + '</strong></p>'
        + '<p>Due today (background-check service fee): <strong>' + money(pickupFeeCents() / 100) + '</strong></p>'
        + '<p>Balance due at pickup: <strong>' + money(balanceDueCents() / 100) + '</strong> — your $15 is credited toward the price.</p>'
        + '<p class="meta">You pay only the $15 online. The balance is paid at pickup, after you pass the background check.</p>';
    } else {
      var ship = shipCents();
      var shipNote = ship === 0
        ? ' <span class="meta">(No flat shipping rate set yet — we will call you about shipping before your order ships.)</span>'
        : '';
      t.innerHTML = '<p>Items total: <strong>' + money(itemsCents() / 100) + '</strong></p>'
        + '<p>Shipping: <strong>' + money(ship / 100) + '</strong>' + shipNote + '</p>'
        + '<p>Due today: <strong>' + money(chargeCents() / 100) + '</strong></p>';
    }
    var btn = $('payButton');
    if (btn) {
      btn.textContent = fulfillment === 'pickup'
        ? 'Pay ' + money(pickupFeeCents() / 100) + ' — Norcross pickup'
        : 'Pay ' + money(chargeCents() / 100) + ' — Ship to FFL';
    }
  }

  function setPayEnabled(on) {
    var btn = $('payButton');
    if (!btn) return;
    btn.disabled = !on || paying || !cart().length;
  }

  function setFulfillment(f) {
    fulfillment = f;
    var pick = $('fulfillPickup'), ship = $('fulfillShip');
    if (pick) pick.classList.toggle('selected', f === 'pickup');
    if (ship) ship.classList.toggle('selected', f === 'ship');
    show($('pickupFields'), f === 'pickup');
    show($('shipFields'), f === 'ship');
    show($('shipAddressFields'), f === 'ship' && !hasFirearm());
    show($('fflPicker'), f === 'ship' && hasFirearm());
    var note = $('noFirearmNote');
    if (note) note.textContent = (f === 'ship' && !hasFirearm())
      ? 'Your order has no firearms, so it ships to your address — no FFL needed.'
      : '';
    renderTotals();
    setPayEnabled(!!config && !!config.configured && acceptReady);
  }

  // --- FFL picker: ZIP search over /api/ffl-dealers, or manual entry. ---
  async function searchFFL(e) {
    if (e) e.preventDefault();
    var out = $('fflResults');
    var zip = val('fflZip'), city = val('fflCitySearch'), state = val('fflStateSearch');
    if (!zip && !city && !state) { out.innerHTML = '<p class="meta">Enter a ZIP, city, or state to search.</p>'; return; }
    out.innerHTML = '<p>Searching dealers…</p>';
    try {
      var params = new URLSearchParams();
      if (zip) params.set('zip', zip);
      if (city) params.set('city', city);
      if (state) params.set('state', state);
      var res = await fetch('/api/ffl-dealers?' + params.toString());
      var d = await res.json();
      if (!d.dealers || !d.dealers.length) {
        out.innerHTML = '<p>No dealers found in our network for that search. Enter your FFL manually below, or call ' + PHONE + ' — we can still ship to a licensed dealer not on this list.</p>';
        return;
      }
      out.innerHTML = '<p class="meta">' + d.total + ' dealer' + (d.total === 1 ? '' : 's') + ' found — closest first. Confirm the dealer accepts transfers and their fee before ordering.</p>'
        + d.dealers.map(function (x, i) {
          var addr = [x.street, x.city, x.state, x.zip].filter(Boolean).join(', ');
          return '<div class="cartitem"><div><strong>' + esc(x.name) + '</strong><div class="meta">' + esc(addr) + '</div><button type="button" class="btn" data-ffl="' + i + '">Use this dealer →</button></div></div>';
        }).join('');
      window.__fflResults = d.dealers;
      out.querySelectorAll('[data-ffl]').forEach(function (b) {
        b.addEventListener('click', function () { selectFFL(window.__fflResults[Number(b.dataset.ffl)]); });
      });
    } catch (err) {
      out.innerHTML = '<p>Dealer search could not load right now — enter your FFL manually below, or call ' + PHONE + '.</p>';
    }
  }
  function selectFFL(d) {
    if (!d) return;
    selectedFFL = { name: d.name || '', street: d.street || '', city: d.city || '', state: d.state || '', zip: d.zip || '' };
    var sel = $('fflSelected');
    if (sel) sel.innerHTML = '<strong>Receiving FFL:</strong> ' + esc(d.name) + ' — ' + esc([d.street, d.city, d.state, d.zip].filter(Boolean).join(', ')) + ' <button type="button" class="btn btn-dark" id="fflClear">Change</button>';
    var clear = $('fflClear');
    if (clear) clear.addEventListener('click', function () { selectedFFL = null; if (sel) sel.innerHTML = ''; });
    // Keep the manual fields in sync so the server sees the same dealer.
    var set = function (id, v) { var el = $(id); if (el) el.value = v || ''; };
    set('fflName', d.name); set('fflCityManual', d.city); set('fflStateManual', d.state); set('fflZipManual', d.zip);
  }
  function chosenFFL() {
    if (selectedFFL) return selectedFFL;
    return { name: val('fflName'), street: '', city: val('fflCityManual'), state: val('fflStateManual'), zip: val('fflZipManual') };
  }

  // --- Card field helpers (display formatting only — the raw digits go
  // straight to Accept.js, never to our server). ---
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function formatCardNumber(el) {
    var d = digits(el.value).slice(0, 16);
    el.value = d.replace(/(.{4})/g, '$1 ').trim();
  }
  function formatExpiry(el) {
    var d = digits(el.value).slice(0, 4);
    el.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
  }
  function parseExpiry(v) {
    var parts = String(v || '').split('/');
    if (parts.length !== 2) return null;
    var mm = parseInt(parts[0], 10);
    var yy = parseInt(parts[1], 10);
    if (isNaN(mm) || mm < 1 || mm > 12 || isNaN(yy)) return null;
    var year = yy < 100 ? 2000 + yy : yy;
    var now = new Date();
    if (year < now.getFullYear() || (year === now.getFullYear() && mm < now.getMonth() + 1)) return null;
    return { month: ('0' + mm).slice(-2), year: String(year) };
  }

  function showError(msg) {
    var el = $('payError');
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? '' : 'none';
    if (msg) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // --- Pay: validate, tokenize with Accept.js, then charge. ---
  async function payNow(e) {
    if (e) e.preventDefault();
    showError('');
    if (paying) return;
    var items = cart();
    if (!items.length) { showError('Your cart is empty.'); return; }
    if (!config || !config.configured) { showError('Online checkout is not available right now — please call ' + PHONE + ' to order.'); return; }
    if (!acceptReady || typeof Accept === 'undefined') { showError('The secure payment form could not load. Please refresh the page, or call ' + PHONE + ' to order.'); return; }

    var firstName = val('coFirstName'), lastName = val('coLastName');
    var phone = val('coPhone'), email = val('coEmail');
    var billingZip = val('coBillingZip');
    if (!firstName || !lastName) { showError('Full name is required.'); return; }
    if (!phone) { showError('Phone number is required.'); return; }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError('A valid email address is required.'); return; }
    if (!/^\d{5}(-\d{4})?$/.test(billingZip)) { showError('Billing ZIP code is required.'); return; }

    var ffl = null, shippingAddress = null;
    if (fulfillment === 'ship') {
      if (hasFirearm()) {
        ffl = chosenFFL();
        if (!ffl.name || !ffl.city || !ffl.state) { showError('A receiving FFL is required for a firearm order — name, city and state at minimum. Pick one from the dealer search or enter it manually.'); return; }
      } else {
        shippingAddress = { street: val('shipStreet'), city: val('shipCity'), state: val('shipState'), zip: val('shipZip') };
        if (!shippingAddress.street || !shippingAddress.city || !shippingAddress.state || !/^\d{5}(-\d{4})?$/.test(shippingAddress.zip)) { showError('A shipping address is required — street, city, state and ZIP.'); return; }
      }
    }

    var cardNumber = digits(val('coCardNumber'));
    var exp = parseExpiry(val('coExpiry'));
    var cardCode = digits(val('coCardCode'));
    if (cardNumber.length < 13 || cardNumber.length > 16) { showError('Card number does not look right — check it and try again.'); return; }
    if (!exp) { showError('Expiry date does not look right — use MM/YY and a future date.'); return; }
    if (cardCode.length < 3 || cardCode.length > 4) { showError('Security code (CVV) is 3 or 4 digits.'); return; }

    paying = true;
    setPayEnabled(false);
    var btn = $('payButton');
    if (btn) btn.textContent = 'Processing…';

    var secureData = {
      authData: { clientKey: config.clientKey, apiLoginID: config.apiLoginID },
      cardData: { cardNumber: cardNumber, month: exp.month, year: exp.year, cardCode: cardCode },
    };
    // Clear the card fields from the page as soon as they are handed to
    // Accept.js — they are never sent to our server and never stored.
    var clearCard = function () {
      ['coCardNumber', 'coExpiry', 'coCardCode'].forEach(function (id) { var el = $(id); if (el) el.value = ''; });
    };
    try {
      Accept.dispatchData(secureData, function (resp) { onAcceptResponse(resp, clearCard, { firstName: firstName, lastName: lastName, phone: phone, email: email, billingZip: billingZip, ffl: ffl, shippingAddress: shippingAddress }); });
    } catch (err) {
      clearCard();
      paying = false;
      renderTotals();
      setPayEnabled(true);
      showError('The secure payment form could not start. Please refresh the page, or call ' + PHONE + ' to order.');
    }
  }

  async function onAcceptResponse(resp, clearCard, customer) {
    try {
      if (!resp || !resp.messages || resp.messages.resultCode === 'Error') {
        var msgs = [];
        try {
          (resp.messages.message || []).forEach(function (m) { if (m.text) msgs.push(m.text); });
        } catch (e) {}
        clearCard();
        paying = false;
        renderTotals();
        setPayEnabled(true);
        showError((msgs[0] || 'The card could not be read.') + ' Nothing was charged. Please check the card details and try again, or call ' + PHONE + '.');
        return;
      }
      var od = resp.opaqueData || {};
      if (!od.dataDescriptor || !od.dataValue) {
        clearCard();
        paying = false;
        renderTotals();
        setPayEnabled(true);
        showError('The card could not be read. Nothing was charged. Please try again, or call ' + PHONE + '.');
        return;
      }
      clearCard();
      var payload = {
        items: cart().map(function (i) { return { sku: i.sku, qty: i.qty || 1 }; }),
        fulfillment: fulfillment,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
        email: customer.email,
        billingZip: customer.billingZip,
        pickupDay: fulfillment === 'pickup' ? val('coPickupDay') : '',
        ffl: customer.ffl,
        shippingAddress: customer.shippingAddress,
        opaqueData: { dataDescriptor: od.dataDescriptor, dataValue: od.dataValue },
      };
      var res = await fetch('/api/authnet-charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (data && data.ok) {
        showConfirmation(data);
        return;
      }
      paying = false;
      renderTotals();
      setPayEnabled(true);
      showError((data && data.error) || 'Payment could not be processed. Nothing was charged. Please try again, or call ' + PHONE + '.');
    } catch (err) {
      paying = false;
      renderTotals();
      setPayEnabled(true);
      showError('The payment system did not answer. Nothing was charged. Please try again, or call ' + PHONE + '.');
    }
  }

  function showConfirmation(data) {
    try { if (typeof saveCart === 'function') saveCart([]); } catch (e) {}
    try { localStorage.removeItem('xl_cart'); } catch (e) {}
    show($('checkoutForm'), false);
    show($('orderSummaryWrap'), false);
    var box = $('confirmation');
    if (!box) return;
    var isPickup = data.fulfillment === 'pickup';
    box.innerHTML = '<h2>Order confirmed — thank you</h2>'
      + (data.testMode ? '<p><strong>TEST MODE — no money moved.</strong> This was a test transaction; nothing was charged.</p>' : '')
      + '<p><strong>Order number:</strong> ' + esc(data.orderId) + '<br>'
      + '<strong>Authorize.net transaction:</strong> ' + esc(data.transactionId) + '<br>'
      + '<strong>Charged today:</strong> ' + money(data.amount) + '</p>'
      + (isPickup
        ? '<p><strong>Balance due at pickup:</strong> ' + money(data.balanceDueAtPickup || 0) + ' (your $15 is credited toward the price).</p>'
          + '<p><strong>Next step — send your pickup information:</strong> use the pickup intake page so we can run the background check before you come in. Bring your original Georgia ID/license and sign the official Form 4473 in person at pickup.</p>'
          + '<p><a class="btn" href="pickup-intake.html">Send your pickup information →</a></p>'
        : '<p>Your order will ship to your receiving FFL. The FFL will run the background check and Form 4473 at their counter before you take possession. We will call you if anything is needed before shipping.</p>')
      + '<p class="meta">A confirmation email is on its way to the email address you gave. Questions? Call <a href="tel:+16786916375">(678) 691-6375</a>, 7 days 10am–6pm EST.</p>'
      + '<p><a class="btn btn-dark" href="shop.html">Continue shopping →</a></p>';
    show(box, true);
    box.scrollIntoView({ behavior: 'smooth' });
  }

  function loadAcceptJs(url) {
    return new Promise(function (resolve, reject) {
      if (typeof Accept !== 'undefined') return resolve();
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Accept.js failed to load')); };
      document.head.appendChild(s);
    });
  }

  async function initCheckout() {
    if (!$('checkoutForm')) return; // not the checkout page
    renderSummary();
    // Fulfillment radios.
    var rPick = $('fulfillPickupRadio'), rShip = $('fulfillShipRadio');
    if (rPick) rPick.addEventListener('change', function () { if (rPick.checked) setFulfillment('pickup'); });
    if (rShip) rShip.addEventListener('change', function () { if (rShip.checked) setFulfillment('ship'); });
    var fflBtn = $('fflSearchButton');
    if (fflBtn) fflBtn.addEventListener('click', searchFFL);
    var cardEl = $('coCardNumber');
    if (cardEl) cardEl.addEventListener('input', function () { formatCardNumber(cardEl); });
    var expEl = $('coExpiry');
    if (expEl) expEl.addEventListener('input', function () { formatExpiry(expEl); });
    var form = $('checkoutForm');
    if (form) form.addEventListener('submit', payNow);
    setFulfillment('pickup');

    // Load the public config, then the matching Accept.js script. If the
    // config is missing or checkout is not configured, the page stays in
    // call-to-order mode instead of taking a payment it cannot process.
    var banner = $('checkoutUnavailable');
    try {
      var res = await fetch('/api/authnet-charge');
      var data = await res.json();
      if (!data || !data.ok) throw new Error('config failed');
      config = data;
      if (!config.configured) {
        if (banner) { banner.textContent = 'Online checkout is not available right now — please call ' + PHONE + ' to order.'; banner.style.display = ''; }
        setPayEnabled(false);
        return;
      }
      await loadAcceptJs(config.acceptJsUrl);
      acceptReady = true;
      setPayEnabled(true);
    } catch (err) {
      if (banner) { banner.textContent = 'Online checkout is not available right now — please call ' + PHONE + ' to order.'; banner.style.display = ''; }
      setPayEnabled(false);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCheckout);
  } else {
    initCheckout();
  }
})();
