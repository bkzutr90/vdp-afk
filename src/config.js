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

  // Channel untuk laporan background (/background report)
  reportChannelId: process.env.REPORT_CHANNEL_ID || null,

  // Pesan naik level
  levelUpMessages: process.env.LEVELUP_MESSAGES !== '0',
  levelUpChannelId: process.env.LEVELUP_CHANNEL_ID || null, // kosong = di channel tempat user chat

  accent: hex(process.env.ACCENT_COLOR, '#5865F2'),

  xp: {
    min: num(process.env.XP_MIN, 15),
    max: num(process.env.XP_MAX, 25),
    cooldownMs: num(process.env.XP_COOLDOWN_SECONDS, 60) * 1000,
    voicePerMinute: num(process.env.VOICE_XP, 0), // 0 = XP dari voice dimatikan
  },
};
