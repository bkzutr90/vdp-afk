// XP dari voice: tiap menit, user yang tidak deafen dan berada di channel dengan minimal 2 orang (bukan bot) dapat XP.
const cfg = require('./config');
const { addXp } = require('./xp');

function startVoiceXp(client) {
  const perMinute = cfg.xp.voicePerMinute;
  if (!perMinute) return;

  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      const byChannel = new Map();
      for (const vs of guild.voiceStates.cache.values()) {
        if (!vs.channelId || vs.channelId === guild.afkChannelId) continue;
        const member = vs.member ?? (await guild.members.fetch(vs.id).catch(() => null));
        if (!member || member.user.bot) continue;
        if (!byChannel.has(vs.channelId)) byChannel.set(vs.channelId, []);
        byChannel.get(vs.channelId).push({ id: vs.id, deaf: vs.selfDeaf || vs.serverDeaf });
      }
      for (const humans of byChannel.values()) {
        if (humans.length < 2) continue;
        for (const h of humans) if (!h.deaf) addXp(guild.id, h.id, perMinute, false);
      }
    }
  }, 60_000).unref();

  console.log(`[voicexp] aktif: ${perMinute} XP/menit`);
}

module.exports = { startVoiceXp };
