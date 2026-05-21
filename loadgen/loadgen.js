// Tiny synthetic traffic generator. Walks a believable user journey across
// the backend so the dashboards and AI service have data to chew on.
//
// Mix:
//   - 1 in 30 ticks: signup (creates a fresh user)
//   - majority:      login as demo user, browse catalog, view product,
//                    sometimes fetch related products (the slow self-join),
//                    sometimes search by keyword (the LIKE '%...%' query),
//                    add an item, occasionally checkout + pay
//   - 1 in 40 ticks: 401 traffic (request /cart without a token)
//   - 1 in 50 ticks: 404 traffic (random nonexistent product id)
//
// Tunables (env):
//   BACKEND_URL  default http://backend:4000
//   RPS          requests per second target (rough). default 3
//   ENABLED      set to "0" to make this container a no-op
const BACKEND = process.env.BACKEND_URL || 'http://backend:4000';
const RPS = parseFloat(process.env.RPS || '3');
const ENABLED = process.env.ENABLED !== '0';

const DEMO_EMAIL = 'demo@shop.local';
const DEMO_PASS = 'demopass';

let demoToken = null;
let productCache = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function call(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  try {
    const res = await fetch(`${BACKEND}${path}`, { ...opts, headers });
    const text = await res.text();
    const body = text ? safeJson(text) : null;
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

async function ensureDemoToken() {
  if (demoToken) return demoToken;
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASS }),
  });
  if (res.status === 200 && res.body?.token) {
    demoToken = res.body.token;
    return demoToken;
  }
  return null;
}

async function ensureProductCache() {
  if (productCache.length > 0) return productCache;
  const res = await call('/api/products');
  if (res.status === 200 && Array.isArray(res.body?.products)) {
    productCache = res.body.products;
  }
  return productCache;
}

async function actionBrowse() {
  await call('/api/products');
}

async function actionSearch() {
  const term = pick(['lamp', 'mug', 'eco', 'smart', 'book', 'compact', 'modern']);
  await call(`/api/products?search=${encodeURIComponent(term)}`);
}

async function actionViewProduct() {
  const products = await ensureProductCache();
  if (!products.length) return;
  const p = pick(products);
  await call(`/api/products/${p.id}`);
}

async function actionViewRelated() {
  const products = await ensureProductCache();
  if (!products.length) return;
  const p = pick(products);
  await call(`/api/products/${p.id}/related`);
}

async function actionAddToCart() {
  const token = await ensureDemoToken();
  const products = await ensureProductCache();
  if (!token || !products.length) return;
  const p = pick(products.filter((x) => x.stock > 0)) || pick(products);
  await call('/api/cart/items', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ product_id: p.id, quantity: 1 }),
  });
}

async function actionCheckoutAndPay() {
  const token = await ensureDemoToken();
  if (!token) return;
  // Make sure there is at least one item.
  await actionAddToCart();
  const co = await call('/api/checkout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (co.status === 201 && co.body?.order_id) {
    await call('/api/payment', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ order_id: co.body.order_id, card_number: '4242424242424242' }),
    });
  }
}

async function actionSignup() {
  const id = Math.random().toString(36).slice(2, 10);
  await call('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email: `bot-${id}@shop.local`, password: 'botpass1' }),
  });
}

async function actionUnauthorized() {
  await call('/api/cart');
}

async function actionNotFound() {
  await call(`/api/products/${100000 + Math.floor(Math.random() * 1000)}`);
}

async function tick() {
  const r = Math.random();
  // Weighted choices: catalog browsing dominates, checkout is rarer.
  if (r < 0.05)        return actionSignup();
  if (r < 0.07)        return actionUnauthorized();
  if (r < 0.09)        return actionNotFound();
  if (r < 0.30)        return actionBrowse();
  if (r < 0.40)        return actionSearch();
  if (r < 0.55)        return actionViewProduct();
  if (r < 0.65)        return actionViewRelated();
  if (r < 0.85)        return actionAddToCart();
  return actionCheckoutAndPay();
}

async function main() {
  if (!ENABLED) {
    console.log('loadgen disabled via ENABLED=0; sleeping forever.');
    while (true) await sleep(60_000);
  }
  console.log(`loadgen targeting ${BACKEND} at ~${RPS} rps`);
  const intervalMs = Math.max(50, Math.floor(1000 / Math.max(0.1, RPS)));
  // Give the backend a moment to come up.
  await sleep(5_000);
  while (true) {
    tick().catch(() => undefined);
    await sleep(intervalMs);
  }
}

main();
