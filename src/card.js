const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const cfg = require('./config');

const W = 934;
const H = 282;

// Font dibundel lewat npm supaya teks tetap tampil di container tanpa font sistem (Railway/Docker).
try {
  GlobalFonts.registerFromPath(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'), 'CardRegular');
  GlobalFonts.registerFromPath(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'), 'CardBold');
} catch (err) {
  console.warn('[card] gagal memuat font:', err.message);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const compact = (n) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
};

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

// Gambar user -> JPEG 934x282 (cover) supaya kecil dan seragam saat disimpan di database.
async function processBackground(buffer) {
  const img = await loadImage(buffer);
  if (!img.width || !img.height || img.width * img.height > 50_000_000) throw new Error('Ukuran gambar tidak valid');
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const scale = Math.max(W / img.width, H / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return canvas.toBuffer('image/jpeg', 85);
}

async function renderRankCard({ name, avatar, level, rank, current, needed, background }) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const accent = cfg.accent;

  // Latar: background user atau gradien default
  let drewBg = false;
  if (background) {
    try {
      ctx.drawImage(await loadImage(background), 0, 0, W, H);
      drewBg = true;
    } catch {}
  }
  if (!drewBg) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#1b1d24');
    g.addColorStop(1, '#2b2f3a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Panel gelap transparan
  roundRect(ctx, 20, 20, W - 40, H - 40, 24);
  ctx.fillStyle = 'rgba(0,0,0,0.58)';
  ctx.fill();

  // Avatar bulat
  const cx = 140;
  const cy = H / 2;
  const r = 85;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  let drewAvatar = false;
  if (avatar) {
    try {
      ctx.drawImage(await loadImage(avatar), cx - r, cy - r, r * 2, r * 2);
      drewAvatar = true;
    } catch {}
  }
  if (!drewAvatar) {
    ctx.fillStyle = '#4f545c';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = accent;
  ctx.stroke();

  const x0 = 250;
  const x1 = W - 55;

  // Kanan atas: RANK #n  LEVEL n
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';
  ctx.font = '40px CardBold';
  ctx.fillStyle = accent;
  const levelNum = String(level);
  ctx.fillText(levelNum, x1, 100);
  const numW = ctx.measureText(levelNum).width;
  ctx.font = '22px CardBold';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('LEVEL', x1 - numW - 8, 100);
  const levelBlockW = numW + 8 + ctx.measureText('LEVEL').width;

  ctx.font = '40px CardBold';
  const rankNum = `#${rank}`;
  const rankNumW = ctx.measureText(rankNum).width;
  const rankX = x1 - levelBlockW - 28;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(rankNum, rankX, 100);
  ctx.font = '22px CardBold';
  ctx.fillStyle = '#b9bbbe';
  ctx.fillText('RANK', rankX - rankNumW - 8, 100);
  const rightBlockW = x1 - (rankX - rankNumW - 8 - ctx.measureText('RANK').width);

  // Nama (kiri atas)
  ctx.textAlign = 'left';
  ctx.font = '34px CardBold';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(fit(ctx, name, x1 - x0 - rightBlockW - 24), x0, 100);

  // Teks XP di atas bar
  ctx.textAlign = 'right';
  ctx.font = '24px CardRegular';
  ctx.fillStyle = '#b9bbbe';
  ctx.fillText(`${compact(current)} / ${compact(needed)} XP`, x1, 165);

  // Progress bar
  const barY = 182;
  const barH = 36;
  const barW = x1 - x0;
  roundRect(ctx, x0, barY, barW, barH, barH / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fill();
  const progress = Math.min(1, Math.max(0, current / needed));
  if (progress > 0) {
    const fw = Math.max(barH, barW * progress);
    roundRect(ctx, x0, barY, fw, barH, barH / 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }

  return canvas.toBuffer('image/png');
}

// Captcha gambar: huruf miring + noise supaya tidak bisa di-copy / dibaca bot sederhana.
function renderCaptcha(code) {
  const CW = 300;
  const CH = 110;
  const canvas = createCanvas(CW, CH);
  const ctx = canvas.getContext('2d');
  const rnd = (a, b) => Math.random() * (b - a) + a;
  const color = (min, max) => `rgb(${Math.floor(rnd(min, max))},${Math.floor(rnd(min, max))},${Math.floor(rnd(min, max))})`;

  // Latar
  const g = ctx.createLinearGradient(0, 0, CW, CH);
  g.addColorStop(0, '#2b2f3a');
  g.addColorStop(1, '#1b1d24');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CW, CH);

  // Noise garis di belakang
  for (let n = 0; n < 8; n++) {
    ctx.strokeStyle = color(70, 140);
    ctx.lineWidth = rnd(1, 3);
    ctx.beginPath();
    ctx.moveTo(rnd(0, CW), rnd(0, CH));
    ctx.bezierCurveTo(rnd(0, CW), rnd(0, CH), rnd(0, CW), rnd(0, CH), rnd(0, CW), rnd(0, CH));
    ctx.stroke();
  }

  // Huruf
  const step = (CW - 60) / code.length;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  [...code].forEach((ch, idx) => {
    ctx.save();
    ctx.translate(40 + step * idx + step / 2, CH / 2 + rnd(-10, 10));
    ctx.rotate(rnd(-0.5, 0.5));
    ctx.font = `${Math.floor(rnd(44, 58))}px CardBold`;
    ctx.fillStyle = color(170, 255);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });

  // Garis coretan di atas huruf
  for (let n = 0; n < 4; n++) {
    ctx.strokeStyle = color(120, 220);
    ctx.lineWidth = rnd(1.5, 3);
    ctx.beginPath();
    ctx.moveTo(rnd(0, 40), rnd(10, CH - 10));
    ctx.bezierCurveTo(rnd(60, 120), rnd(0, CH), rnd(180, 240), rnd(0, CH), rnd(CW - 40, CW), rnd(10, CH - 10));
    ctx.stroke();
  }

  // Titik noise
  for (let n = 0; n < 160; n++) {
    ctx.fillStyle = color(100, 255);
    ctx.fillRect(rnd(0, CW), rnd(0, CH), 2, 2);
  }

  return canvas.toBuffer('image/png');
}

module.exports = { renderRankCard, processBackground, renderCaptcha };
