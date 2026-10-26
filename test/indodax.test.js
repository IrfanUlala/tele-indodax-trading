import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { IndodaxPrivateApi, formatWallet, percentageAmount, signPayload, signV2 } from '../src/indodax.js';

test('percentage choices accept only 25/50/75/100 percent', () => {
  assert.equal(percentageAmount(1000, 25), 250);
  assert.equal(percentageAmount(1000, 100), 1000);
  assert.throws(() => percentageAmount(1000, 40));
  assert.throws(() => percentageAmount(-10, 25));
});

test('V2 signature uses HMAC SHA256 over query string', () => {
  assert.equal(signV2('symbol=BTCIDR&timestamp=123', 'secret').length, 64);
});

test('signs form body with HMAC SHA512', () => {
  const signed = signPayload({ method: 'getInfo', nonce: '123' }, 'secret');
  assert.equal(signed.body, 'method=getInfo&nonce=123');
  assert.equal(signed.sign.length, 128);
});

test('private V2 account read uses documented URL, GET and auth headers', async () => {
  let request;
  const api = new IndodaxPrivateApi({ key: 'key', secret: 'secret', fetchImpl: async (url, options) => {
    request = { url: String(url), ...options };
    return { ok: true, json: async () => ({ balances: [{ asset: 'BTC', free: '0.1' }] }) };
  } });
  const info = await api.getInfo();
  assert.equal(info.balances[0].free, '0.1');
  assert.match(request.url, /^https:\/\/api\.indodax\.com\/api\/v2\/account\?/);
  assert.equal(request.method, 'GET');
  assert.ok(request.headers['X-APIKEY'] === 'key' && request.headers.Sign);
});

test('V2 market BUY uses quoteOrderQty in a signed POST order request', async () => {
  let request;
  const api = new IndodaxPrivateApi({ key: 'key', secret: 'secret', fetchImpl: async (url, options) => {
    request = { url: String(url), ...options };
    return { ok: true, json: async () => ({ orderId: 'mock-order' }) };
  } });
  await api.createOrder({ side: 'BUY', quoteAmount: 25000 });
  const body = new URLSearchParams(request.body);
  assert.match(request.url, /\/api\/v2\/order$/);
  assert.equal(request.method, 'POST');
  assert.equal(body.get('symbol'), 'BTCIDR');
  assert.equal(body.get('side'), 'BUY');
  assert.equal(body.get('type'), 'MARKET');
  assert.equal(body.get('quoteOrderQty'), '25000');
  assert.ok(request.headers.Sign && request.headers['X-APIKEY']);
});

test('V2 market SELL uses base quantity and rejects invalid side', async () => {
  let request;
  const api = new IndodaxPrivateApi({ key: 'key', secret: 'secret', fetchImpl: async (url, options) => {
    request = { url: String(url), ...options };
    return { ok: true, json: async () => ({ orderId: 'mock-sell' }) };
  } });
  await api.createOrder({ side: 'SELL', quantity: 0.002 });
  const body = new URLSearchParams(request.body);
  assert.equal(body.get('side'), 'SELL');
  assert.equal(body.get('quantity'), '0.002');
  assert.equal(body.get('quoteOrderQty'), null);
  await assert.rejects(() => api.createOrder({ side: 'oops', quantity: 1 }), /Sisi order/);
});

test('formats private account balances for wallet display without leaking account metadata', async () => {
  const rendered = formatWallet({ balances: [
    { asset: 'BTC', free: '0.125', locked: '0.025' },
    { asset: 'IDR', free: '120000', locked: '0' },
    { asset: 'USDT', free: '999', locked: '0' },
  ] });
  assert.match(rendered, /Rp120\.000/);
  assert.match(rendered, /0,125 BTC/);
  assert.match(rendered, /0,025 BTC/);
  assert.doesNotMatch(rendered, /USDT/);
  assert.match(formatWallet({ balances: [] }), /Rp0/);
  assert.throws(() => formatWallet({}), /Format saldo/);
});

test('trade flow requires explicit single-use confirmation and uses available balance only', async () => {
  const { TradeFlow } = await import('../src/trade-flow.js');
  const sent = [];
  let orders = 0;
  const api = {
    async getInfo() { return { canTrade: true, balances: [
      { asset: 'IDR', free: '100000', locked: '40000' },
      { asset: 'BTC', free: '0.01', locked: '0.02' },
    ] }; },
    async createOrder() { orders += 1; return { orderId: 'mock' }; },
  };
  const flow = new TradeFlow({ api, send: (id, text, keyboard) => { sent.push({ id, text, keyboard }); return Promise.resolve(); }, ownerId: '123', now: () => 1000, liveEnabled: true, maxOrderIdr: 100000, maxDeviationPct: 1, pairMetadata: { quantity_increment: '0.00000001', trade_min_traded_currency: 0.0001, trade_min_base_currency: 50000 }, getMarketPrice: async () => 1000000000 });
  await flow.start('123', 'BUY');
  assert.match(sent.at(-1).text, /100\.000 IDR/);
  assert.equal(orders, 0);
  const token = sent.at(-1).keyboard[0][0].callback_data.split(':')[1];
  await flow.choosePercent('123', token, 50);
  assert.match(sent.at(-1).text, /Rp50\.000/);
  assert.equal(orders, 0);
  const confirmationToken = sent.at(-1).keyboard[0][0].callback_data.split(':')[1];
  await flow.confirm('123', confirmationToken);
  assert.equal(orders, 1);
  await flow.confirm('123', confirmationToken);
  assert.equal(orders, 1);
  await flow.start('999', 'BUY');
  assert.equal(orders, 1);
});

test('trade flow requires callback token for percentage selection', async () => {
  const { TradeFlow } = await import('../src/trade-flow.js');
  const sent = [];
  const flow = new TradeFlow({ api: { async getInfo() { return { balances: [{ asset: 'IDR', free: '100000', locked: '0' }], canTrade: true }; } }, send: (id, text, keyboard) => { sent.push({ text, keyboard }); return Promise.resolve(); }, ownerId: '123', now: () => 1000, liveEnabled: true, maxOrderIdr: 1000000, maxDeviationPct: 5, getMarketPrice: async () => 600000000 });
  await flow.start('123', 'BUY');
  assert.ok(sent.length > 0);
  const keyboard = sent.at(-1)?.keyboard;
  assert.ok(keyboard);
  const token = keyboard[0][0].callback_data.split(':')[1];
  assert.match(await flow.choosePercent('123', token, 25), /KONFIRMASI ORDER/);
});

test('trade flow rejects wrong callback token', async () => {
  const { TradeFlow } = await import('../src/trade-flow.js');
  const sent = [];
  const flow = new TradeFlow({ api: { async getInfo() { return { balances: [{ asset: 'IDR', free: '100000', locked: '0' }], canTrade: true }; } }, send: (id, text, keyboard) => { sent.push({ text, keyboard }); return Promise.resolve(); }, ownerId: '123', now: () => 1000, liveEnabled: true, maxOrderIdr: 1000000, maxDeviationPct: 5, getMarketPrice: async () => 600000000 });
  await flow.start('123', 'BUY');
  assert.match(await flow.choosePercent('123', 'wrong-token', 25), /tidak berlaku/i);
});

test('live order flow is disabled unless explicit live flag and limits are configured', async () => {
  const { TradeFlow } = await import('../src/trade-flow.js');
  const sent = [];
  const flow = new TradeFlow({ api: { async getInfo() { return { balances: [{ asset: 'IDR', free: '100000', locked: '0' }] }; } }, send: async (id, text) => sent.push(text), ownerId: '123' });
  assert.match(await flow.start('123', 'BUY'), /dinonaktifkan/i);
  assert.equal(sent.length, 0);
});

test('trade flow expires pending confirmations', async () => {
  const { TradeFlow } = await import('../src/trade-flow.js');
  let now = 1000;
  const sent = [];
  const flow = new TradeFlow({ api: { async getInfo() { return { canTrade: true, balances: [{ asset: 'IDR', free: '100000', locked: '0' }] }; }, async createOrder() { throw Error('should not trade'); } }, send: (id, text, keyboard) => { sent.push({ text, keyboard }); return Promise.resolve(); }, ownerId: '123', now: () => now, ttlMs: 500, liveEnabled: true, maxOrderIdr: 100000, maxDeviationPct: 5, getMarketPrice: async () => 600000000 });
  await flow.start('123', 'BUY');
  const token = sent.at(-1).keyboard[0][0].callback_data.split(':')[1];
  await flow.choosePercent('123', token, 25);
  const confirmationToken = sent.at(-1).keyboard[0][0].callback_data.split(':')[1];
  now += 501;
  const result = await flow.confirm('123', confirmationToken);
  assert.match(result, /kedaluwarsa/);
});

test('status response shows price direction, wallet, and buy/sell buttons', async () => {
  const { formatStatus } = await import('../src/status.js');
  const result = formatStatus({ latest: { price: 120, observedAt: '2026-01-01T00:00:00.000Z' }, previous: 100, account: { balances: [{ asset: 'IDR', free: '50000', locked: '0' }, { asset: 'BTC', free: '0.2', locked: '0' }] }, marketConnected: true });
  assert.match(result.text, /naik/i);
  assert.match(result.text, /20,00%/);
  assert.match(result.text, /BTC\/IDR/);
  assert.equal(result.keyboard.flat().map(button => button.text).join(' '), '🟢 BELI BTC 🔴 JUAL BTC 🔄 PERBARUI');
});

test('wallet displays BTC available balance value change with signed rupiah and percentage', async () => {
  const { formatWallet } = await import('../src/indodax.js');
  const text = formatWallet({ balances: [{ asset: 'BTC', free: '0.00001101', locked: '0' }] }, { price: 1461240000, entryPrice: 1500000000 });
  assert.match(text, /₿ Bitcoin \(BTC\) \| -2,58% \(-Rp426,75\)/);
  assert.match(text, /Tersedia : 0,00001101 BTC/);
});

test('wallet omits BTC value change when entry price is unknown', async () => {
  const { formatWallet } = await import('../src/indodax.js');
  const text = formatWallet({ balances: [{ asset: 'BTC', free: '0.00001101', locked: '0' }] }, { price: 1461240000 });
  assert.match(text, /perubahan nilai belum tersedia/i);
});

test('status reports signed rupiah movement from tracked buy price and BTC quantity', async () => {
  const { formatStatus } = await import('../src/status.js');
  const base = { latest: { price: 120000, observedAt: '2026-01-01T00:00:00.000Z' }, previous: 119000, account: null, marketConnected: true };
  const gain = formatStatus({ ...base, position: { entryPrice: 100000, quantity: 0.5 } }).text;
  assert.match(gain, /Perubahan sejak beli: \+Rp20\.000 per BTC/);
  assert.match(gain, /Estimasi nilai posisi: \+Rp10\.000/);
  const loss = formatStatus({ ...base, latest: { ...base.latest, price: 80000 }, position: { entryPrice: 100000, quantity: 0.5 } }).text;
  assert.match(loss, /Perubahan sejak beli: -Rp20\.000/);
  assert.match(loss, /Estimasi nilai posisi: -Rp10\.000/);
  const missing = formatStatus({ ...base, position: { entryPrice: 100000 } }).text;
  assert.match(missing, /ukuran posisi BTC tidak tercatat/i);
});

test('wallet handler is registered and reads the private account API', async () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /bot\.command\('wallet'/);
  assert.match(source, /getInfo\(\)/);
});
