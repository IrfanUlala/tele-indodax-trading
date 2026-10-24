import { formatWallet } from './indodax.js';
import { marketOutlook } from './prediction.js';

export function formatStatus({ latest, previous, account, marketConnected, history = [], position = null }) {
  const lines = ['📊 BTC/IDR — STATUS'];
  if (!latest?.price || !Number.isFinite(Number(latest.price))) lines.push('Harga terakhir: belum tersedia');
  else {
    lines.push(`Harga terakhir: Rp${Number(latest.price).toLocaleString('id-ID')}`);
    const old = Number(previous);
    if (Number.isFinite(old) && old > 0) {
      const changePct = (Number(latest.price) - old) / old * 100;
      const direction = changePct > 0 ? 'NAIK' : changePct < 0 ? 'TURUN' : 'TETAP';
      lines.push(`Perubahan harga: ${direction} ${changePct >= 0 ? '+' : ''}${changePct.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);
    } else lines.push('Perubahan harga: menunggu data pembanding');
    if (latest.observedAt) lines.push(`Diperbarui: ${new Date(latest.observedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`);
  }
  lines.push(`Koneksi market: ${marketConnected ? 'tersambung' : 'terputus'}`);
  if (account) lines.push('', formatWallet(account, { price: latest?.price, entryPrice: position?.entryPrice }));
  else lines.push('', '💼 Wallet: tidak dapat dibaca saat ini.');
  if (position) {
    const entryPrice = Number(position.entryPrice);
    const currentPrice = Number(latest?.price);
    const deltaPerBtc = currentPrice - entryPrice;
    const rupiah = value => `${value >= 0 ? '+' : '-'}Rp${Math.abs(value).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
    lines.push('', `Posisi tercatat: BTC dibeli di Rp${entryPrice.toLocaleString('id-ID')}`);
    if (Number.isFinite(currentPrice) && Number.isFinite(entryPrice)) {
      lines.push(`Perubahan sejak beli: ${rupiah(deltaPerBtc)} per BTC (${deltaPerBtc / entryPrice >= 0 ? '+' : ''}${(deltaPerBtc / entryPrice * 100).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%)`);
      const quantity = Number(position.quantity);
      if (Number.isFinite(quantity) && quantity > 0) lines.push(`Estimasi nilai posisi: ${rupiah(deltaPerBtc * quantity)} untuk ${quantity.toLocaleString('id-ID')} BTC`);
      else lines.push('Total perubahan posisi: tidak dihitung karena ukuran posisi BTC tidak tercatat.');
    } else lines.push('Perubahan sejak beli: harga terkini belum tersedia.');
  }
  const outlook = marketOutlook(history);
  lines.push('', `Arah 15 menit: ${outlook.direction}${outlook.changePct === null ? '' : ` (${outlook.changePct >= 0 ? '+' : ''}${outlook.changePct.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%)`}`);
  lines.push('Catatan: sinyal dan arah harga hanya informasi, bukan kepastian. Order market dapat tereksekusi segera setelah konfirmasi akhir.');
  return {
    text: lines.join('\n'),
    keyboard: [[{ text: '🟢 BELI BTC', callback_data: 'status_buy' }, { text: '🔴 JUAL BTC', callback_data: 'status_sell' }], [{ text: '🔄 PERBARUI', callback_data: 'status_refresh' }]],
  };
}
