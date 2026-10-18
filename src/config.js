require('dotenv').config();
const path = require('path');

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : d);

module.exports = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID || null, // kosong = command didaftarkan global (bisa lambat muncul)
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Voice AFK 24 jam (opsional: bisa juga diatur lewat /afk join)
  afkChannelId: process.env.VOICE_CHANNEL_ID || null,

  // Channel untuk notifikasi status bot AFK (terputus / masuk lagi / gagal). Kosong = tanpa notifikasi.
  logChannelId: process.env.LOG_CHANNEL_ID || null,

  // Template nama voice sementara. {user} = nama pemilik.
  tempVoiceName: process.env.TEMPVOICE_NAME || '🔊 {user}',

  // Channel untuk laporan background (/background report)
  reportChannelId: process.env.REPORT_CHANNEL_ID || null,

  // Zona waktu (Jakarta = WIB). Dipertahankan kalau dipakai modul lain (mis. stats).
  timezone: process.env.TZ_NAME || 'Asia/Jakarta',

  // Server stats: 1 = hitung bot akurat lewat Server Members Intent (aktifkan juga di Developer Portal). 0 = tanpa intent privileged.
  statsUseMembersIntent: process.env.STATS_USE_MEMBERS_INTENT === '1',

  // Invite tracker. Butuh Server Members Intent aktif di Developer Portal. INVITE_TRACKER=0 untuk mematikan.
  inviteTracker: process.env.INVITE_TRACKER !== '0',
  inviteChannelId: process.env.INVITE_CHANNEL_ID || null, // channel log join/leave + pengundang. Kosong = tanpa log
  inviteFakeDays: num(process.env.INVITE_FAKE_DAYS, 3), // akun lebih muda dari ini dihitung fake

  // Pesan naik level
  levelUpMessages: process.env.LEVELUP_MESSAGES !== '0',
  levelUpChannelId: process.env.LEVELUP_CHANNEL_ID || null, // kosong = di channel tempat user chat

  accent: hex(process.env.ACCENT_COLOR, '#5865F2'),

  xp: {
    min: num(process.env.XP_MIN, 15),
    max: num(process.env.XP_MAX, 25),
    cooldownMs: num(process.env.XP_COOLDOWN_SECONDS, 60) * 1000,
    voicePerMinute: num(process.env.VOICE_XP, 0), // 0 = XP dari voice dimatikan
    voiceRequireUnmuted: process.env.VOICE_REQUIRE_UNMUTED !== '0', // true = user yang mute tidak dapat XP voice
    voiceDebug: process.env.VOICE_XP_DEBUG === '1', // log alasan user dilewati / diberi XP
    voiceMinUsers: num(process.env.VOICE_MIN_USERS, 2), // minimal user (bukan bot) di channel agar dapat XP; 1 = boleh sendirian
  },
};
