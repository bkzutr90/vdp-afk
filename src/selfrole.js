const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const cfg = require('./config');

const EPHEMERAL = MessageFlags.Ephemeral;

const ROLES = {
  boy: { name: 'Boy', emoji: '👦', color: 0x3498db },
  girl: { name: 'Girl', emoji: '👧', color: 0xe91e8c },
};

const ANNOUNCEMENT_ID = process.env.ANNOUNCEMENT_CHANNEL_ID || '1517467522658603090';
const PICK_CHANNEL_ID = process.env.PICKROLE_CHANNEL_ID || '1558849936668368918'; // ambil-roles
const CATEGORY_IDS = (
  process.env.LOCKED_CATEGORY_IDS ||
  '1517465897453752461,1558067239561732186,1535628521135808572,1535628788564492348,1558423985048526869,1535629531757412473'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Role lain yang tetap boleh melihat channel (staff dll), opsional. Pisahkan dengan koma.
const KEEP_ROLE_IDS = (process.env.SELFROLE_KEEP_ROLE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// Role (mis. Manager) yang boleh menjalankan /selfrole selain yang punya izin Manage Roles/Channels/Server. Pisahkan dengan koma.
const MANAGER_ROLE_IDS = (process.env.SELFROLE_MANAGER_ROLE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

function canManage(i) {
  if (i.guild.ownerId === i.user.id) return true;
  const p = i.memberPermissions;
  if (p?.has(PermissionFlagsBits.Administrator)) return true;
  if (p?.has(PermissionFlagsBits.ManageRoles) || p?.has(PermissionFlagsBits.ManageChannels) || p?.has(PermissionFlagsBits.ManageGuild)) return true;
  return MANAGER_ROLE_IDS.some((id) => i.member?.roles?.cache?.has(id));
}

const findRole = (guild, key) => guild.roles.cache.find((r) => r.name.toLowerCase() === ROLES[key].name.toLowerCase());

async function ensureRole(guild, key) {
  let role = findRole(guild, key);
  if (!role) {
    role = await guild.roles.create({
      name: ROLES[key].name,
      color: ROLES[key].color,
      reason: 'Self role setup',
    });
  }
  return role;
}

async function setupPermissions(guild, boy, girl) {
  const everyone = guild.roles.everyone;
  const publicIds = new Set([ANNOUNCEMENT_ID, PICK_CHANNEL_ID]);
  const log = { locked: 0, failed: [] };

  const lock = async (ch) => {
    try {
      await ch.permissionOverwrites.edit(everyone, { ViewChannel: false }, { reason: 'Self role setup' });
      for (const r of [boy, girl]) await ch.permissionOverwrites.edit(r, { ViewChannel: true }, { reason: 'Self role setup' });
      for (const id of KEEP_ROLE_IDS) await ch.permissionOverwrites.edit(id, { ViewChannel: true }, { reason: 'Self role setup' });
      log.locked++;
    } catch (err) {
      log.failed.push(`${ch.name} (${err.message})`);
    }
  };

  await guild.channels.fetch(); // isi cache semua channel

  for (const catId of CATEGORY_IDS) {
    const cat = guild.channels.cache.get(catId);
    if (!cat) {
      log.failed.push(`kategori ${catId} tidak ditemukan`);
      continue;
    }
    await lock(cat);
    for (const child of cat.children.cache.values()) {
      if (publicIds.has(child.id)) continue;
      await lock(child);
    }
  }

  // Channel publik: announcement & ambil-roles terlihat semua orang
  for (const id of publicIds) {
    const ch = guild.channels.cache.get(id);
    if (!ch) {
      log.failed.push(`channel ${id} tidak ditemukan`);
      continue;
    }
    try {
      const perms = { ViewChannel: true, SendMessages: false, AddReactions: false };
      await ch.permissionOverwrites.edit(everyone, perms, { reason: 'Self role setup' });
    } catch (err) {
      log.failed.push(`${ch.name} (${err.message})`);
    }
  }
  return log;
}

function panelPayload() {
  const embed = new EmbedBuilder()
    .setColor(cfg.accent)
    .setTitle('🎭 Ambil Role')
    .setDescription(
      'Pilih salah satu role di bawah untuk membuka semua channel server.\n\n' +
        `${ROLES.boy.emoji} **Boy**\n${ROLES.girl.emoji} **Girl**\n\n` +
        'Klik tombol lagi untuk melepas role. Memilih satu role otomatis mengganti role lainnya.'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sr:boy').setLabel('Boy').setEmoji(ROLES.boy.emoji).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sr:girl').setLabel('Girl').setEmoji(ROLES.girl.emoji).setStyle(ButtonStyle.Danger)
  );
  return { embeds: [embed], components: [row] };
}

const command = {
  data: new SlashCommandBuilder()
    .setName('selfrole')
    .setDescription('Setup role Boy/Girl & channel terkunci')
    .addSubcommand((s) => s.setName('setup').setDescription('Buat role, kunci kategori, dan kirim panel ke #ambil-roles'))
    .addSubcommand((s) => s.setName('panel').setDescription('Kirim ulang panel ambil role saja')),
  async execute(i) {
    if (!canManage(i)) {
      return i.reply({ content: '❌ Kamu tidak punya izin untuk memakai command ini.', flags: EPHEMERAL });
    }
    await i.deferReply({ flags: EPHEMERAL });
    const guild = i.guild;
    const sub = i.options.getSubcommand();
    try {
      await guild.roles.fetch(); // pastikan cache role lengkap
      const boy = await ensureRole(guild, 'boy');
      const girl = await ensureRole(guild, 'girl');
      let report = '';

      if (sub === 'setup') {
        const log = await setupPermissions(guild, boy, girl);
        report = `🔒 ${log.locked} kategori/channel dikunci untuk @everyone, dibuka untuk ${boy} & ${girl}.`;
        if (log.failed.length) report += `\n⚠️ Gagal:\n${log.failed.slice(0, 10).map((f) => `• ${f}`).join('\n')}`;
      }

      const pick = await guild.channels.fetch(PICK_CHANNEL_ID).catch(() => null);
      if (!pick?.isTextBased()) return i.editReply(`${report}\n❌ Channel ambil-roles tidak ditemukan.`);
      await pick.send(panelPayload());
      return i.editReply(`✅ Selesai. Panel dikirim ke ${pick}.\n${report}`.trim());
    } catch (err) {
      return i.editReply(`❌ Error: \`${String(err.message).slice(0, 300)}\`\nPastikan bot punya Manage Roles + Manage Channels dan role bot ada di atas Boy/Girl.`);
    }
  },
};

async function handleSelfRoleButton(i) {
  if (!i.customId.startsWith('sr:')) return false;
  const key = i.customId.slice(3);
  if (!ROLES[key]) return true;
  const other = key === 'boy' ? 'girl' : 'boy';

  const role = findRole(i.guild, key);
  const otherRole = findRole(i.guild, other);
  if (!role) {
    await i.reply({ content: '❌ Role belum dibuat. Hubungi admin.', flags: EPHEMERAL });
    return true;
  }

  const member = await i.guild.members.fetch(i.user.id).catch(() => null);
  if (!member) {
    await i.reply({ content: '❌ Gagal mengambil data kamu.', flags: EPHEMERAL });
    return true;
  }

  try {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role, 'Self role');
      await i.reply({ content: `➖ Role **${role.name}** dilepas. Channel akan tertutup lagi.`, flags: EPHEMERAL });
    } else {
      await member.roles.add(role, 'Self role');
      if (otherRole && member.roles.cache.has(otherRole.id)) await member.roles.remove(otherRole, 'Self role (ganti)');
      await i.reply({ content: `✅ Kamu sekarang **${role.name}**. Semua channel sudah terbuka!`, flags: EPHEMERAL });
    }
  } catch (err) {
    console.warn('[selfrole]', err.message);
    await i.reply({ content: '❌ Bot tidak bisa memberi role. Hubungi admin (role bot harus di atas Boy/Girl).', flags: EPHEMERAL });
  }
  return true;
}

module.exports = { command, handleSelfRoleButton };
