const { Client, GatewayIntentBits, MessageFlags, REST, Routes } = require('discord.js');
const cfg = require('./config');
const { commands, handleButton } = require('./commands');
const { addXp } = require('./xp');
const { announceLevelUp } = require('./levelup');
const { startAfk } = require('./voice');
const { startVoiceXp } = require('./voicexp');
const { startTempVoice, handleTempVoiceInteraction } = require('./tempvoice');
const { handleSelfRoleInteraction } = require('./selfrole');
const { startBirthday } = require('./birthday');
const { startStats } = require('./stats');
const { handleSiderInteraction } = require('./sider');

if (!cfg.token) {
  console.error('DISCORD_TOKEN wajib diisi (Variables di Railway / .env)');
  process.exit(1);
}

// Default tanpa intent privileged. Server Members hanya dipakai kalau STATS_USE_MEMBERS_INTENT=1.
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages];
if (cfg.statsUseMembersIntent) intents.push(GatewayIntentBits.GuildMembers);
const client = new Client({ intents });

async function registerCommands(clientId) {
  try {
    const body = [...commands.values()].map((c) => c.data.toJSON());
    const rest = new REST({ version: '10' }).setToken(cfg.token);
    const route = cfg.guildId ? Routes.applicationGuildCommands(clientId, cfg.guildId) : Routes.applicationCommands(clientId);
    await rest.put(route, { body });
    console.log(`✅ ${body.length} command terdaftar (${cfg.guildId ? `server ${cfg.guildId}` : 'global'})`);
  } catch (err) {
    console.error('[register] gagal daftar command:', err);
  }
}

client.once('clientReady', async () => {
  console.log(`🔥 Online sebagai ${client.user.tag}`);
  await registerCommands(client.user.id);
  startAfk(client).catch((err) => console.error('[afk] gagal start:', err));
  startVoiceXp(client);
  startTempVoice(client);
  startBirthday(client);
  startStats(client);
});

// ---- XP dari chat (dengan cooldown per user)
const lastXp = new Map();
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

client.on('messageCreate', (m) => {
  if (!m.guild || m.author.bot || m.webhookId) return;
  const key = `${m.guildId}:${m.author.id}`;
  const now = Date.now();
  if (now - (lastXp.get(key) || 0) < cfg.xp.cooldownMs) return;
  lastXp.set(key, now);

  const res = addXp(m.guildId, m.author.id, rand(cfg.xp.min, cfg.xp.max));
  if (res.leveledUp) announceLevelUp(m.guild, m.author.id, res.level, m.channelId);
});
setInterval(() => {
  const cutoff = Date.now() - cfg.xp.cooldownMs;
  for (const [k, t] of lastXp) if (t < cutoff) lastXp.delete(k);
}, 10 * 60_000).unref();

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) {
      const cmd = commands.get(i.commandName);
      if (cmd) await cmd.execute(i, client);
      return;
    }
    // Panel voice sementara: tombol, modal, dan menu pilih (customId diawali "tv:")
    if ((i.isButton() || i.isModalSubmit() || i.isStringSelectMenu()) && i.customId.startsWith('tv:')) {
      await handleTempVoiceInteraction(i);
      return;
    }
    // Ambil role Boy/Girl + verifikasi (customId diawali "sr:" / "vf:", termasuk modal kode)
    if ((i.isButton() || i.isModalSubmit()) && (await handleSelfRoleInteraction(i))) return;
    // Tombol "Sudah baca" untuk cek sider (customId "sd:read")
    if (i.isButton() && (await handleSiderInteraction(i))) return;
    if (i.isButton() && (await handleButton(i))) return;
  } catch (err) {
    console.error('[interaction] error:', err);
    const msg = '❌ Terjadi error. Coba lagi sebentar lagi.';
    try {
      if (i.deferred || i.replied) await i.editReply({ content: msg, embeds: [], components: [], files: [] });
      else await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
    } catch {}
  }
});

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

client.login(cfg.token);
