// AFK voice 24 jam: bot masuk ke voice channel dan menjaganya tetap terhubung.
// Kalau terputus / dikick / pindah, bot otomatis masuk lagi. Disimpan di database, jadi tetap jalan setelah restart.
// Kejadian penting dikirim ke LOG_CHANNEL_ID (kalau diisi).
const { EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { db } = require('./db');
const cfg = require('./config');

const WATCHDOG_MS = 30_000;
const FAIL_NOTIFY_EVERY_MS = 10 * 60_000; // pesan "gagal" maksimal tiap 10 menit
const COLORS = { ok: 0x2ecc71, warn: 0xf39c12, error: 0xe74c3c, info: 0x3498db };

const desired = new Map(); // guildId -> channelId yang harus dijaga
const busy = new Set(); // guild yang sedang proses (hindari join ganda)
const outageSince = new Map(); // guildId -> waktu mulai terputus (untuk 1 notifikasi per gangguan)
const lastFailNotify = new Map();
let client = null;

const dbAll = () => db.prepare('SELECT guild_id, channel_id FROM afk_channels').all();
const dbSet = (g, c) =>
  db.prepare('INSERT INTO afk_channels (guild_id, channel_id) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id').run(g, c);
const dbDel = (g) => db.prepare('DELETE FROM afk_channels WHERE guild_id=?').run(g);

const dead = (conn) => !conn || [VoiceConnectionStatus.Destroyed, VoiceConnectionStatus.Disconnected].includes(conn.state.status);

// ------------------------------------------------------------------ notifikasi ke channel log
function fmtDur(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} detik`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} menit ${s % 60} detik`;
  return `${Math.floor(m / 60)} jam ${m % 60} menit`;
}

async function notify(guildId, type, text) {
  if (!cfg.logChannelId || !client) return;
  try {
    const ch = await client.channels.fetch(cfg.logChannelId);
    if (!ch?.isTextBased()) return;
    const embed = new EmbedBuilder().setColor(COLORS[type]).setDescription(text).setTimestamp();
    const guildName = client.guilds.cache.get(guildId)?.name;
    if (guildName) embed.setFooter({ text: guildName });
    await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn('[afk] gagal kirim notifikasi ke channel log:', err.message);
  }
}

// Satu notifikasi "terputus" per gangguan, supaya tidak spam saat bot mencoba masuk lagi.
function markOutage(guildId, text) {
  if (!desired.has(guildId) || outageSince.has(guildId)) return;
  outageSince.set(guildId, Date.now());
  notify(guildId, 'warn', text);
}

// ------------------------------------------------------------------ koneksi
async function connect(guildId, channelId) {
  const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId));
  const channel = await guild.channels.fetch(channelId);
  if (!channel || !channel.isVoiceBased()) throw new Error('Voice channel tidak ditemukan');
  if (!channel.joinable) throw new Error('Bot tidak punya izin View/Connect di channel itu, atau channel penuh');

  const existing = getVoiceConnection(guildId);
  if (existing) {
    if (existing.joinConfig.channelId === channelId && !dead(existing)) return; // sudah benar
    if (existing.state.status !== VoiceConnectionStatus.Destroyed) existing.destroy();
  }

  const conn = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: true,
  });

  conn.on('error', (err) => console.warn(`[afk] voice error (${guildId}):`, err.message));
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Kalau cuma dipindah channel / reconnect otomatis, tunggu sebentar
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      markOutage(guildId, `⚠️ Koneksi voice ke <#${channelId}> terputus. Mencoba masuk lagi...`);
      if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
      setTimeout(() => ensure(guildId), 3_000);
    }
  });

  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
    throw new Error(`Tidak berhasil tersambung ke voice dalam 20 detik (${err.message}). Cek izin Connect/Speak dan region channel.`);
  }

  const since = outageSince.get(guildId);
  outageSince.delete(guildId);
  lastFailNotify.delete(guildId);
  if (since) notify(guildId, 'ok', `✅ Berhasil masuk lagi ke <#${channelId}> setelah terputus selama ${fmtDur(Date.now() - since)}.`);
  else notify(guildId, 'ok', `🎧 Bot masuk ke <#${channelId}> dan siap menjaga voice.`);
}

// Pastikan bot ada di channel yang diinginkan (aman dipanggil berulang)
async function ensure(guildId) {
  const channelId = desired.get(guildId);
  if (!channelId || busy.has(guildId)) return;
  busy.add(guildId);
  try {
    await connect(guildId, channelId);
  } catch (err) {
    console.warn(`[afk] gagal join (${guildId}):`, err.message);
    if (err.code === 10003) {
      // channel sudah dihapus
      clear(guildId);
      notify(guildId, 'error', `🗑️ Voice channel <#${channelId}> sudah dihapus. Mode AFK dimatikan. Pakai \`/afk join\` untuk mengatur ulang.`);
      return;
    }
    if (!outageSince.has(guildId)) outageSince.set(guildId, Date.now());
    if (Date.now() - (lastFailNotify.get(guildId) || 0) > FAIL_NOTIFY_EVERY_MS) {
      lastFailNotify.set(guildId, Date.now());
      notify(guildId, 'error', `❌ Gagal masuk ke <#${channelId}>: \`${String(err.message).slice(0, 200)}\`\nBot mencoba lagi tiap 30 detik.`);
    }
  } finally {
    busy.delete(guildId);
  }
}

function clear(guildId) {
  desired.delete(guildId);
  outageSince.delete(guildId);
  lastFailNotify.delete(guildId);
  dbDel(guildId);
}

// ------------------------------------------------------------------ API untuk command
async function setAfk(guildId, channelId) {
  desired.set(guildId, channelId);
  dbSet(guildId, channelId);
  busy.add(guildId);
  try {
    await connect(guildId, channelId);
  } finally {
    busy.delete(guildId);
  }
}

function stopAfk(guildId) {
  clear(guildId);
  const conn = getVoiceConnection(guildId);
  if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
}

function statusOf(guildId) {
  const channelId = desired.get(guildId) || null;
  const conn = getVoiceConnection(guildId);
  return { channelId, state: conn?.state.status || 'tidak terhubung' };
}

// ------------------------------------------------------------------ start
async function startAfk(c) {
  client = c;

  for (const row of dbAll()) desired.set(row.guild_id, row.channel_id);

  // Channel default dari env (hanya dipakai kalau server itu belum punya pengaturan sendiri)
  if (cfg.afkChannelId) {
    try {
      const ch = await client.channels.fetch(cfg.afkChannelId);
      if (ch?.guildId && !desired.has(ch.guildId)) {
        desired.set(ch.guildId, ch.id);
        dbSet(ch.guildId, ch.id);
      }
    } catch (err) {
      console.warn('[afk] VOICE_CHANNEL_ID tidak valid:', err.message);
    }
  }

  for (const guildId of desired.keys()) ensure(guildId);

  // Watchdog: cek berkala, kalau terputus masuk lagi
  setInterval(() => {
    for (const [guildId, channelId] of desired) {
      const conn = getVoiceConnection(guildId);
      const actual = client.guilds.cache.get(guildId)?.members.me?.voice.channelId;
      const ready = conn?.state.status === VoiceConnectionStatus.Ready;
      if (dead(conn) || (ready && actual !== channelId)) {
        markOutage(guildId, `⚠️ Bot tidak terdeteksi di <#${channelId}>. Mencoba masuk lagi...`);
        ensure(guildId);
      }
    }
  }, WATCHDOG_MS).unref();

  // Bot dipindah admin -> ikuti channel baru. Bot dikeluarkan -> masuk lagi.
  client.on('voiceStateUpdate', (oldS, newS) => {
    if (newS.id !== client.user.id) return;
    const guildId = newS.guild.id;
    if (!desired.has(guildId)) return;
    if (newS.channelId && newS.channelId !== desired.get(guildId)) {
      desired.set(guildId, newS.channelId);
      dbSet(guildId, newS.channelId);
      notify(guildId, 'info', `🔀 Bot dipindahkan ke <#${newS.channelId}>. Sekarang menjaga channel ini.`);
    } else if (!newS.channelId) {
      markOutage(guildId, '⚠️ Bot keluar dari voice (dikeluarkan atau terputus). Mencoba masuk lagi...');
      setTimeout(() => ensure(guildId), 3_000);
    }
  });

  console.log(`[afk] menjaga ${desired.size} voice channel${cfg.logChannelId ? ', notifikasi ke channel log aktif' : ''}`);
}

module.exports = { startAfk, setAfk, stopAfk, statusOf };
