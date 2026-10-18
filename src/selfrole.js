const {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const crypto = require('crypto');
const cfg = require('./config');
const { db } = require('./db');
const { renderCaptcha } = require('./card');

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

// ------------------------------------------------------------------ verifikasi (captcha gambar)
const VERIFY_ON = process.env.SELFROLE_VERIFY !== '0'; // 0 = matikan verifikasi
const MIN_ACCOUNT_DAYS = Number(process.env.VERIFY_MIN_ACCOUNT_DAYS) || 0; // umur akun minimal (hari), 0 = bebas
const CODE_TTL = 3 * 60_000;
const MAX_TRIES = 3;
const LOCK_MS = 2 * 60_000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa O/0/I/1 supaya tidak membingungkan

db.exec(`
  CREATE TABLE IF NOT EXISTS selfrole_verified (
    guild_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    verified_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
`);
const isVerified = (guildId, userId) => !!db.prepare('SELECT 1 FROM selfrole_verified WHERE guild_id=? AND user_id=?').get(guildId, userId);
const markVerified = (guildId, userId) =>
  db.prepare('INSERT OR REPLACE INTO selfrole_verified (guild_id, user_id, verified_at) VALUES (?, ?, ?)').run(guildId, userId, Date.now());

const pending = new Map(); // "guild:user" -> { code, expires, tries }
const locked = new Map(); // "guild:user" -> timestamp sampai kapan diblokir
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  for (const [k, t] of locked) if (t < now) locked.delete(k);
}, 5 * 60_000).unref();

async function startVerify(i) {
  const key = `${i.guildId}:${i.user.id}`;
  if (isVerified(i.guildId, i.user.id)) {
    return i.reply({ content: '✅ Kamu sudah terverifikasi. Silakan pilih **Boy** atau **Girl**.', flags: EPHEMERAL });
  }
  const ageDays = (Date.now() - i.user.createdTimestamp) / 86_400_000;
  if (MIN_ACCOUNT_DAYS && ageDays < MIN_ACCOUNT_DAYS) {
    return i.reply({ content: `❌ Akun kamu masih terlalu baru. Coba lagi dalam ${Math.ceil(MIN_ACCOUNT_DAYS - ageDays)} hari.`, flags: EPHEMERAL });
  }
  const until = locked.get(key) || 0;
  if (until > Date.now()) {
    return i.reply({ content: `⏳ Terlalu banyak salah. Coba lagi dalam ${Math.ceil((until - Date.now()) / 1000)} detik.`, flags: EPHEMERAL });
  }

  const code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  pending.set(key, { code, expires: Date.now() + CODE_TTL, tries: 0 });

  const png = renderCaptcha(code);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vf:enter').setLabel('Jawab captcha').setEmoji('⌨️').setStyle(ButtonStyle.Success)
  );
  return i.reply({
    content: '🔐 **Verifikasi Captcha**\nBaca kode pada gambar, klik tombol di bawah, lalu ketik kodenya (berlaku 3 menit, tidak peka huruf besar/kecil).',
    files: [new AttachmentBuilder(png, { name: 'captcha.png' })],
    components: [row],
    flags: EPHEMERAL,
  });
}

async function showCodeModal(i) {
  const p = pending.get(`${i.guildId}:${i.user.id}`);
  if (!p || p.expires < Date.now()) {
    return i.reply({ content: '⌛ Captcha kedaluwarsa. Klik **Verifikasi** di panel untuk captcha baru.', flags: EPHEMERAL });
  }
  const modal = new ModalBuilder()
    .setCustomId('vf:modal')
    .setTitle('Verifikasi Captcha')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('code').setLabel('Ketik kode dari gambar').setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(12).setRequired(true)
      )
    );
  return i.showModal(modal);
}

async function checkCode(i) {
  const key = `${i.guildId}:${i.user.id}`;
  const p = pending.get(key);
  if (!p || p.expires < Date.now()) {
    pending.delete(key);
    return i.reply({ content: '⌛ Captcha kedaluwarsa. Klik **Verifikasi** di panel untuk captcha baru.', flags: EPHEMERAL });
  }

  const input = i.fields.getTextInputValue('code').replace(/\s+/g, '').toUpperCase();
  if (input === p.code) {
    pending.delete(key);
    markVerified(i.guildId, i.user.id);
    return i.reply({ content: '✅ Verifikasi berhasil!\nSekarang pilih **Boy** atau **Girl** di panel untuk membuka channel.', flags: EPHEMERAL });
  }
  p.tries++;
  if (p.tries >= MAX_TRIES) {
    pending.delete(key);
    locked.set(key, Date.now() + LOCK_MS);
    return i.reply({ content: '❌ Salah 3 kali. Coba lagi dalam 2 menit.', flags: EPHEMERAL });
  }
  return i.reply({ content: `❌ Kode salah. Sisa percobaan: **${MAX_TRIES - p.tries}**. Klik **Jawab captcha** lagi (captcha yang sama masih berlaku).`, flags: EPHEMERAL });
}

const findRole = (guild, key) => guild.roles.cache.find((r) => r.name.toLowerCase() === ROLES[key].name.toLowerCase());

async function ensureRole(guild, key) {
  let role = findRole(guild, key);
  if (!role) {
    role = await guild.roles.create({
      name: ROLES[key].name,
      colors: { primaryColor: ROLES[key].color },
      reason: 'Self role setup',
    });
  }
  return role;
}

async function setupPermissions(guild, boy, girl) {
  const everyone = guild.roles.everyone;
  const publicIds = new Set([ANNOUNCEMENT_ID, PICK_CHANNEL_ID]);
  const log = { locked: 0, failed: [] };

  const me = await guild.members.fetchMe();
  const botTarget = me.roles.botRole || me;
  const R = { reason: 'Self role setup' };

  // Urutan penting: bot memberi izin ke DIRINYA dulu, baru menutup @everyone.
  // Kalau terbalik, bot kehilangan akses lihat channel dan jadi "Missing Permissions".
  const lock = async (ch) => {
    try {
      await ch.permissionOverwrites.edit(botTarget, { ViewChannel: true, ManageChannels: true, ManageRoles: true }, R);
      for (const r of [boy, girl]) await ch.permissionOverwrites.edit(r, { ViewChannel: true }, R);
      for (const id of KEEP_ROLE_IDS) await ch.permissionOverwrites.edit(id, { ViewChannel: true }, R);
      await ch.permissionOverwrites.edit(everyone, { ViewChannel: false }, R);
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
    if (cat.permissionOverwrites) await lock(cat);
    const children = guild.channels.cache.filter((c) => c.parentId === catId && c.permissionOverwrites);
    for (const child of children.values()) {
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
      await ch.permissionOverwrites.edit(botTarget, { ViewChannel: true, SendMessages: true, EmbedLinks: true }, R);
      const perms = { ViewChannel: true, SendMessages: false, AddReactions: false };
      await ch.permissionOverwrites.edit(everyone, perms, R);
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
      (VERIFY_ON ? '**1.** Klik **Verifikasi**, lalu jawab captcha yang muncul.\n**2.** Pilih role di bawah untuk membuka semua channel server.\n\n' : 'Pilih salah satu role di bawah untuk membuka semua channel server.\n\n') +
        `${ROLES.boy.emoji} **Boy**\n${ROLES.girl.emoji} **Girl**\n\n` +
        'Klik tombol role lagi untuk melepasnya. Memilih satu role otomatis mengganti role lainnya.'
    );
  const row = new ActionRowBuilder();
  if (VERIFY_ON) row.addComponents(new ButtonBuilder().setCustomId('vf:start').setLabel('Verifikasi').setEmoji('✅').setStyle(ButtonStyle.Success));
  row.addComponents(
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
    let step = 'ambil data role';
    try {
      await guild.roles.fetch(); // pastikan cache role lengkap
      step = 'membuat role Boy/Girl';
      const boy = await ensureRole(guild, 'boy');
      const girl = await ensureRole(guild, 'girl');
      let report = '';

      if (sub === 'setup') {
        step = 'mengatur izin channel';
        const log = await setupPermissions(guild, boy, girl);
        report = `🔒 ${log.locked} kategori/channel dikunci untuk @everyone, dibuka untuk ${boy} & ${girl}.`;
        if (log.failed.length) report += `\n⚠️ Gagal:\n${log.failed.slice(0, 10).map((f) => `• ${f}`).join('\n')}`;
      }

      step = 'mengirim panel ke ambil-roles';
      const pick = await guild.channels.fetch(PICK_CHANNEL_ID).catch(() => null);
      if (!pick?.isTextBased()) return i.editReply(`${report}\n❌ Channel ambil-roles tidak ditemukan.`);
      await pick.send(panelPayload());
      return i.editReply(`✅ Selesai. Panel dikirim ke ${pick}.\n${report}`.trim());
    } catch (err) {
      console.error('[selfrole] error:', err);
      return i.editReply(`❌ Gagal saat **${step}**: \`${String(err.message).slice(0, 300)}\`\nPastikan bot punya Manage Roles + Manage Channels dan role bot ada di atas Boy/Girl.`);
    }
  },
};

async function handleSelfRoleInteraction(i) {
  if (i.isModalSubmit()) {
    if (i.customId !== 'vf:modal') return false;
    await checkCode(i);
    return true;
  }
  if (!i.isButton()) return false;
  if (i.customId === 'vf:start') {
    await startVerify(i);
    return true;
  }
  if (i.customId === 'vf:enter') {
    await showCodeModal(i);
    return true;
  }
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

  // Mengambil role pertama kali wajib verifikasi (yang sudah punya Boy/Girl dianggap terverifikasi)
  const already = member.roles.cache.has(role.id) || (otherRole && member.roles.cache.has(otherRole.id));
  if (VERIFY_ON && !already && !isVerified(i.guildId, i.user.id)) {
    await i.reply({ content: '🔐 Verifikasi dulu: klik tombol **✅ Verifikasi** di panel, lalu jawab captcha-nya.', flags: EPHEMERAL });
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

module.exports = { command, handleSelfRoleInteraction, handleSelfRoleButton: handleSelfRoleInteraction };
