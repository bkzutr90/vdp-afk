// XP dari voice: tiap menit, user yang tidak deafen (dan tidak mute, kalau VOICE_REQUIRE_UNMUTED aktif) dan berada di channel dengan minimal VOICE_MIN_USERS orang (bukan bot) dapat XP.
// Set VOICE_XP_DEBUG=1 untuk melihat di log kenapa seseorang dapat / tidak dapat XP.
const cfg = require('./config');
const { addXp } = require('./xp');
const { announceLevelUp } = require('./levelup');

function startVoiceXp(client) {
  const perMinute = cfg.xp.voicePerMinute;
  if (!perMinute) return;
  const debug = cfg.xp.voiceDebug;
  const log = (...a) => debug && console.log('[voicexp]', ...a);

  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      const byChannel = new Map();
      for (const vs of guild.voiceStates.cache.values()) {
        if (!vs.channelId) continue;
        if (vs.channelId === guild.afkChannelId) {
          log(`lewati ${vs.id}: channel ${vs.channelId} adalah AFK channel bawaan server`);
          continue;
        }
        const member = vs.member ?? (await guild.members.fetch(vs.id).catch(() => null));
        if (!member) {
          log(`lewati ${vs.id}: data member tidak ditemukan`);
          continue;
        }
        if (member.user.bot) continue;
        if (!byChannel.has(vs.channelId)) byChannel.set(vs.channelId, []);
        byChannel.get(vs.channelId).push({
          id: vs.id,
          tag: member.user.tag,
          deaf: vs.selfDeaf || vs.serverDeaf,
          muted: vs.selfMute || vs.serverMute,
        });
      }

      if (debug && byChannel.size === 0) log('tidak ada user (non-bot) di voice channel manapun');
      for (const [channelId, humans] of byChannel) {
        if (humans.length < cfg.xp.voiceMinUsers) {
          log(`channel ${channelId}: ${humans.length} user < minimal ${cfg.xp.voiceMinUsers} -> tidak ada XP`);
          continue;
        }
        for (const h of humans) {
          if (h.deaf) {
            log(`lewati ${h.tag}: sedang deafen`);
            continue;
          }
          if (cfg.xp.voiceRequireUnmuted && h.muted) {
            log(`lewati ${h.tag}: sedang mute`);
            continue;
          }
          const res = addXp(guild.id, h.id, perMinute, false);
          log(`+${perMinute} XP ke ${h.tag} (channel ${channelId}, total ${res.xp})`);
          if (res.leveledUp) announceLevelUp(guild, h.id, res.level, channelId);
        }
      }
    }
  }, 60_000).unref();

  console.log(`[voicexp] aktif: ${perMinute} XP/menit, minimal ${cfg.xp.voiceMinUsers} user di channel${cfg.xp.voiceRequireUnmuted ? ', wajib unmute' : ''}${debug ? ', debug ON' : ''}`);
}

module.exports = { startVoiceXp };
