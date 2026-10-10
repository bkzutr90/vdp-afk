const { Client, GatewayIntentBits, MessageFlags, REST, Routes } = require('discord.js');
const cfg = require('./config');
const { commands, handleButton } = require('./commands');
const { addXp } = require('./xp');
const { startAfk } = require('./voice');
const { startVoiceXp } = require('./voicexp');

if (!cfg.token) {
  console.error('DISCORD_TOKEN wajib diisi (Variables di Railway / .env)');
  process.exit(1);
}

// Tidak butuh intent privileged (Message Content / Server Members).
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
});

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
  if (res.leveledUp && cfg.levelUpMessages) {
    const ch = cfg.levelUpChannelId ? m.guild.channels.cache.get(cfg.levelUpChannelId) : m.channel;
    ch?.send({ content: `🎉 ${m.author} naik ke **level ${res.level}**!`, allowedMentions: { users: [m.author.id] } }).catch(() => {});
  }
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
