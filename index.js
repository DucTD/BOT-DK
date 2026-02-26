require('dotenv').config();

/* ================= IMPORT ================= */
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events
} = require('discord.js');

const fs = require('fs');
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

/* ================= DISCORD ================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

/* ================= CONSTANT ================= */
const DAY = 86400000;

/* ================= ROLE CONFIG ================= */
const ROLE_BY_PLAN = {
  '1m': process.env.ROLE_1T_ID,
  '6m': process.env.ROLE_6T_ID,
  '1y': process.env.ROLE_1Y_ID
};

const ROLE_WAIT_BY_PLAN = {
  '1m': process.env.ROLE_WAIT_1T_ID,
  '6m': process.env.ROLE_WAIT_6T_ID,
  '1y': process.env.ROLE_WAIT_1Y_ID
};

/* ================= PRICE ================= */
const PRICE_VN = { '1m': 2000000, '6m': 10000000, '1y': 18000000 };
const PRICE_JP = { '1m': 12000, '6m': 60000, '1y': 108000 };

/* ================= PAYMENT INFO ================= */
const PAYMENT = {
  VN: {
    bank: 'Vietcombank',
    accountName: 'NGUYEN VAN A',
    accountNumber: '0123456789'
  },
  JP: {
    bank: 'MUFG Bank',
    branch: 'Shinjuku',
    accountNumber: '1234567',
    accountName: 'NGUYEN VAN A'
  }
};

/* ================= DATABASE ================= */
const DB_FILE = './members.json';
let members = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE))
  : {};

const saveDB = () =>
  fs.writeFileSync(DB_FILE, JSON.stringify(members, null, 2));

/* ================= UTIL ================= */
const addMonths = (base, m) => {
  const d = new Date(base);
  d.setMonth(d.getMonth() + m);
  return d.getTime();
};

const planToMonth = p => (p === '6m' ? 6 : p === '1y' ? 12 : 1);

/* ================= ROLE LOGIC ================= */
async function updateWaitingRole(guild, userId, plan) {
  const m = await guild.members.fetch(userId).catch(() => null);
  if (!m) return;

  for (const r of Object.values(ROLE_WAIT_BY_PLAN))
    await m.roles.remove(r).catch(() => {});

  await m.roles.add(ROLE_WAIT_BY_PLAN[plan]).catch(() => {});
}

async function updateFinalRole(guild, userId, plan) {
  const m = await guild.members.fetch(userId).catch(() => null);
  if (!m) return;

  for (const r of [
    ...Object.values(ROLE_BY_PLAN),
    ...Object.values(ROLE_WAIT_BY_PLAN)
  ]) {
    await m.roles.remove(r).catch(() => {});
  }

  await m.roles.add(ROLE_BY_PLAN[plan]).catch(() => {});
}

/* ================= INTERACTION ================= */
client.on(Events.InteractionCreate, async i => {
  if (!i.isButton()) return;
  const id = i.user.id;

  if (!members[id]) members[id] = { expireAt: 0 };

  /* PLAN */
  if (['1m', '6m', '1y'].includes(i.customId)) {
    members[id].plan = i.customId;
    saveDB();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pay_VN').setLabel('🇻🇳 VN').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('pay_JP').setLabel('🇯🇵 JP').setStyle(ButtonStyle.Primary)
    );

    return i.reply({
      ephemeral: true,
      content: 'Chọn quốc gia thanh toán:',
      components: [row]
    });
  }

  /* PAYMENT */
  if (i.customId.startsWith('pay_')) {
    const c = i.customId.split('_')[1];
    members[id].payCountry = c;
    members[id].transferNote = `DISCORD_${id}`;
    saveDB();

    if (c === 'VN') {
      const amount = PRICE_VN[members[id].plan];
      return i.reply({
        ephemeral: true,
        content:
`💳 Thanh toán VN
🏦 ${PAYMENT.VN.bank}
👤 ${PAYMENT.VN.accountName}
🔢 ${PAYMENT.VN.accountNumber}
💰 ${amount.toLocaleString()} VND
📝 ${members[id].transferNote}

➡️ Sau khi chuyển khoản, **DM bot gửi ảnh bill**`
      });
    }

    if (c === 'JP') {
      const p = PAYMENT.JP;
      return i.reply({
        ephemeral: true,
        content:
`💳 Thanh toán JP
🏦 ${p.bank} - ${p.branch}
👤 ${p.accountName}
🔢 ${p.accountNumber}
💰 ${PRICE_JP[members[id].plan]} JPY
📝 ${members[id].transferNote}

➡️ Sau khi chuyển khoản, **DM bot gửi ảnh bill**`
      });
    }
  }

  /* ADMIN APPROVE */
  if (i.customId.startsWith('approve_')) {
    const uid = i.customId.split('_')[1];
    const m = members[uid];
    if (!m?.plan) return i.reply({ content: 'User không hợp lệ', ephemeral: true });

    const now = Date.now();
    m.expireAt = m.expireAt > now
      ? addMonths(m.expireAt, planToMonth(m.plan))
      : addMonths(now, planToMonth(m.plan));
    saveDB();

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    await updateFinalRole(guild, uid, m.plan);

    const user = await client.users.fetch(uid).catch(() => null);
    if (user) user.send(`✅ Gói ${m.plan} của bạn đã được duyệt!`);

    return i.reply({ content: 'Approved', ephemeral: true });
  }

  /* ADMIN REJECT */
  if (i.customId.startsWith('reject_')) {
    delete members[i.customId.split('_')[1]];
    saveDB();
    return i.reply({ content: 'Rejected', ephemeral: true });
  }
});

/* ================= DM BILL UPLOAD ================= */
client.on(Events.MessageCreate, async message => {
  if (message.guild) return;
  if (message.author.bot) return;

  const id = message.author.id;

  if (!members[id]?.plan) {
    return message.reply('❌ Bạn chưa chọn gói trong server.');
  }

  if (message.attachments.size === 0) {
    return message.reply('📸 Vui lòng gửi **ảnh bill**.');
  }

  const file = message.attachments.first();
  if (!file.contentType?.startsWith('image/')) {
    return message.reply('❌ Chỉ chấp nhận file ảnh.');
  }

  if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

  const ext = file.name.split('.').pop();
  const filePath = `./uploads/${id}_${Date.now()}.${ext}`;

  const res = await fetch(file.url);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buffer);

  members[id].billFile = filePath;
  saveDB();

  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  await updateWaitingRole(guild, id, members[id].plan);

  const adminCh = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approve_${id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`reject_${id}`).setLabel('Reject').setStyle(ButtonStyle.Danger)
  );

  await adminCh.send({
    content:
`🧾 BILL (DM)
👤 <@${id}>
📦 Plan: ${members[id].plan}
🌏 Pay: ${members[id].payCountry}
📝 Note: ${members[id].transferNote}`,
    files: [{ attachment: filePath }],
    components: [row]
  });

  return message.reply('✅ Đã nhận bill! Vui lòng chờ admin duyệt.');
});

/* ================= AUTO JOB ================= */
setInterval(async () => {
  const now = Date.now();
  const guild = await client.guilds.fetch(process.env.GUILD_ID);

  for (const id in members) {
    if (members[id].expireAt && now > members[id].expireAt + 2 * DAY) {
      const m = await guild.members.fetch(id).catch(() => null);
      if (m) {
        for (const r of [
          ...Object.values(ROLE_BY_PLAN),
          ...Object.values(ROLE_WAIT_BY_PLAN)
        ]) {
          await m.roles.remove(r).catch(() => {});
        }
      }
      delete members[id];
      saveDB();
    }
  }
}, 60 * 60 * 1000);

/* ================= START ================= */
client.login(process.env.TOKEN);