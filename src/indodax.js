import crypto from 'node:crypto';

const BASE_URL = 'https://api.indodax.com';

export function signV2(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

export function signPayload(params, secret) {
  const body = new URLSearchParams(params).toString();
  const sign = crypto.createHmac('sha512', secret).update(body).digest('hex');
  return { body, sign };
}

export function formatWallet(account, { price = null, entryPrice = null } = {}) {
  if (!account || !Array.isArray(account.balances)) throw new Error('Format saldo akun Indodax tidak dikenali.');
  const wanted = new Map(account.balances
    .filter(item => item && ['IDR', 'BTC'].includes(String(item.asset).toUpperCase()))
    .map(item => [String(item.asset).toUpperCase(), item]));
  const fmt = (value, asset) => {
    const amount = Number(value ?? 0);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Nilai saldo akun tidak valid.');
    return new Intl.NumberFormat('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: asset === 'BTC' ? 8 : 0 }).format(amount);
  };
  const idr = wanted.get('IDR');
  const btc = wanted.get('BTC');
  const btcFree = Number(btc?.free ?? 0);
  let btcChange = 'perubahan nilai belum tersedia (harga beli belum tercatat)';
  const currentPrice = Number(price);
  const boughtAt = Number(entryPrice);
  if (Number.isFinite(currentPrice) && currentPrice > 0 && Number.isFinite(boughtAt) && boughtAt > 0) {
    const pct = (currentPrice - boughtAt) / boughtAt * 100;
    const valueDelta = (currentPrice - boughtAt) * btcFree;
    const sign = valueDelta >= 0 ? '+' : '-';
    const rupiah = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Math.abs(valueDelta));
    const percent = `${pct >= 0 ? '+' : ''}${pct.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
    btcChange = `${percent} (${sign}Rp${rupiah}) estimasi BTC tersedia`;
  }
  const lines = [
    `🇮🇩 Rupiah (IDR)\n   Tersedia : Rp${fmt(idr?.free, 'IDR')}\n   Terkunci : Rp${fmt(idr?.locked, 'IDR')}`,
    `₿ Bitcoin (BTC) | ${btcChange}\n   Tersedia : ${fmt(btc?.free, 'BTC')} BTC\n   Terkunci : ${fmt(btc?.locked, 'BTC')} BTC`,
  ];
  return ['💼 WALLET INDODAX', '━━━━━━━━━━━━━━━━', ...lines, '━━━━━━━━━━━━━━━━', 'Saldo tersedia dan terkunci ditampilkan terpisah.'].join('\n');
}

export function percentageAmount(balance, percent) {
  if (!Number.isFinite(balance) || balance < 0) throw new Error('Saldo tidak valid.');
  if (![25, 50, 75, 100].includes(Number(percent))) throw new Error('Persentase harus 25, 50, 75, atau 100.');
  return balance * Number(percent) / 100;
}

export class IndodaxPrivateApi {
  constructor({ key, secret, fetchImpl = fetch }) {
    if (!key || !secret) throw new Error('INDODAX_API_KEY dan INDODAX_API_SECRET wajib diisi.');
    this.key = key;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
    this.lastNonce = 0;
    this.pairsCache = null;
  }

  async call(method, params = {}, httpMethod = 'GET') {
    const allParams = { ...params, timestamp: String(Date.now()) };
    const serialized = new URLSearchParams(allParams).toString();
    const signature = signV2(serialized, this.secret);
    const url = new URL(`${BASE_URL}/api/v2/${method}`);
    const options = {
      method: httpMethod,
      headers: { 'X-APIKEY': this.key, Sign: signature, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    };
    if (httpMethod === 'GET') url.search = serialized;
    else {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.body = serialized;
    }
    const response = await this.fetchImpl(url, options);
    const data = await response.json();
    if (!response.ok || (data?.code !== undefined && Number(data.code) !== 0) || data?.success === 0) {
      throw new Error(data?.msg || data?.error || `Indodax HTTP ${response.status}`);
    }
    return data;
  }

  async getInfo() { return this.call('account'); }

  async getPairs() {
    if (this.pairsCache) return this.pairsCache;
    const response = await fetch('https://indodax.com/api/pairs', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Pairs HTTP ${response.status}`);
    const data = await response.json();
    this.pairsCache = data;
    return data;
  }

  async getPairInfo(symbol) {
    const pairs = await this.getPairs();
    return pairs.find(p => p.id === symbol.toLowerCase()) ?? null;
  }

  async createOrder({ symbol = 'BTCIDR', side, quoteAmount, quantity }) {
    if (!['BUY', 'SELL'].includes(side)) throw new Error('Sisi order tidak valid.');
    const params = { symbol: symbol.toUpperCase(), side, type: 'MARKET', recvWindow: '5000' };
    if (side === 'BUY') {
      if (!Number.isFinite(quoteAmount) || quoteAmount < 1) throw new Error('Nominal IDR order tidak valid.');
      params.quoteOrderQty = String(Math.floor(quoteAmount));
    } else {
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Jumlah order tidak valid.');
      params.quantity = String(quantity);
    }
    return this.call('order', params, 'POST');
  }
}
