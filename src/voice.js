// AFK voice 24 jam: bot masuk ke voice channel dan menjaganya tetap terhubung.
// Kalau terputus / dikick / pindah, bot otomatis masuk lagi. Disimpan di database, jadi tetap jalan setelah restart.
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { db } = require('./db');
const cfg = require('./config');

const WATCHDOG_MS = 30_000;
const desired = new Map(); // guildId -> channelId yang harus dijaga
const busy = new Set(); // guild yang sedang proses (hindari join ganda)
let client = null;

const dbAll = () => db.prepare('SELECT guild_id, channel_id FROM afk_channels').all();
const dbSet = (g, c) =>
  db.prepare('INSERT INTO afk_channels (guild_id, channel_id) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id').run(g, c);
const dbDel = (g) => db.prepare('DELETE FROM afk_channels WHERE guild_id=?').run(g);

const dead = (conn) => !conn || [VoiceConnectionStatus.Destroyed, VoiceConnectionStatus.Disconnected].includes(conn.state.status);

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
      if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
      setTimeout(() => ensure(guildId), 3_000);
    }
  });

  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
    throw err;
  }
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
    if (err.code === 10003) clear(guildId); // channel sudah dihapus
  } finally {
    busy.delete(guildId);
  }
}

function clear(guildId) {
  desired.delete(guildId);
  dbDel(guildId);
}

// ---- API untuk command
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

// ---- start
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
      if (dead(conn) || (ready && actual !== channelId)) ensure(guildId);
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
    } else if (!newS.channelId) {
      setTimeout(() => ensure(guildId), 3_000);
    }
  });

  console.log(`[afk] menjaga ${desired.size} voice channel`);
}

module.exports = { startAfk, setAfk, stopAfk, statusOf };
