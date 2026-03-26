// ================= SETUP =================
require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  Events, EmbedBuilder
} = require('discord.js');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const { createQR } = require('vietqr');
const cron = require('node-cron');
const express = require('express');
const app = express();
const joinCooldown = new Set();
const TIMEZONE = 'Asia/Ho_Chi_Minh';
const billLock = new Set();
const ADMIN_KEY = process.env.ADMIN_KEY;
// ================= DB =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
// --- Cấu hình role mapping ---
const ROLE_BY_PLAN = {
  "1m": process.env.ROLE_1T_ID,
  "6m": process.env.ROLE_6T_ID,
  "1y": process.env.ROLE_1Y_ID
};
const WAIT_ROLE_BY_PLAN = {
  "1m": process.env.WAIT_1T_ID,
  "6m": process.env.WAIT_6T_ID,
  "1y": process.env.WAIT_1Y_ID
};
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      plan TEXT,
      expireAt BIGINT,
      currency TEXT,
      transferNote TEXT,
      awaitingBill BOOLEAN DEFAULT false,
      lastBill TEXT,
      updatedAt BIGINT,
      lastReminder INT,
      waitRoleId TEXT  -- cột mới để lưu role chờ
    )
  `);

  // đảm bảo cột tồn tại với các bảng đã có
  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS waitRoleId TEXT
  `);
  await pool.query(`
  ALTER TABLE members
  ADD COLUMN IF NOT EXISTS username TEXT
`);
}

async function getMember(id) {
  const res = await pool.query('SELECT * FROM members WHERE id=$1', [id]);
  return res.rows[0];
}

async function upsertMember(id, data) {
  const old = await getMember(id);
  const now = Date.now();

  const fields = {
    plan: data.plan ?? old?.plan ?? null,
    expireAt: data.expireAt ?? old?.expireAt ?? null,
    currency: data.currency ?? old?.currency ?? null,
    transferNote: data.transferNote ?? old?.transferNote ?? null,
    awaitingBill: data.awaitingBill ?? old?.awaitingBill ?? false,
    lastBill: data.lastBill ?? old?.lastBill ?? null,
    lastReminder: data.lastReminder ?? old?.lastReminder ?? null,
    waitRoleId: data.waitRoleId ?? old?.waitRoleId ?? null, // thêm dòng này
    username: data.username ?? old?.username ?? null,
    updatedAt: now
  };

 await pool.query(`
    INSERT INTO members (id, username, plan, expireAt, currency, transferNote, awaitingBill, lastBill, lastReminder, waitRoleId, updatedAt)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT (id) DO UPDATE SET
  username=$2,
  plan=$3, expireAt=$4, currency=$5, transferNote=$6,
  awaitingBill=$7, lastBill=$8, lastReminder=$9, waitRoleId=$10, updatedAt=$11
  `,[
  id,fields.username,fields.plan,fields.expireAt,fields.currency,fields.transferNote,fields.awaitingBill,fields.lastBill,fields.lastReminder,fields.waitRoleId,fields.updatedAt]);
}
// ================= SYNC MEMBERS =================
async function syncAllMembers() {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  if (!guild) return;

  console.log("🔄 Syncing members...");

  const members = await guild.members.fetch();

  const queries = [];

  for (const [id, member] of members) {
  queries.push(
    pool.query(`
      INSERT INTO members (id, username, updatedAt)
      VALUES ($1,$2,$3)
      ON CONFLICT (id) DO UPDATE SET username=$2
    `, [id, member.user.username, Date.now()])
  );
}

  await Promise.all(queries);

  console.log(`✅ Synced ${queries.length} members`);
}
// ================= CONFIG =================

const VIP_ROLE_ID = process.env.VIP_ROLE_ID;
const WAIT_ROLE_ID = process.env.WAIT_ROLE_ID;

const PRICE_VN = { '1m': 2000000, '6m': 11000000, '1y': 22000000 };
const PRICE_JP = { '1m': 11000, '6m': 60500, '1y': 121000 };

const PAYMENT_VN = {
  bankName: "Techcombank",
  bankBin: '970407',
  accountNumber: '86196868888',
  accountName: 'NGUYEN DUY THINH'
};

const PAYMENT_JP = {
  bankName: "三井住友銀行",
  branch: "目白支店 677",
  accountNumber: "6970894",
  accountName: "グエンズイテイン"
};

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ================= ROLE =================
async function updateFinalRole(guild, userId, plan) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  for (const r of Object.values(ROLE_BY_PLAN)) {
  if (r) await member.roles.remove(r).catch(()=>{});
}
  await member.roles.add(ROLE_BY_PLAN[plan]).catch(() => {});
}

// ================= MENU =================
function vipMenu() {
  const embed = new EmbedBuilder()
    .setTitle("📝 ĐĂNG KÝ VIP")
    .setColor("#5865F2")
    .addFields(
      { name: "⭐ 1 Tháng", value: "2.000.000đ / 11.000¥" },
      { name: "⭐ 6 Tháng", value: "11.000.000đ / 60.500¥" },
      { name: "⭐ 1 Năm", value: "22.000.000đ / 121.000¥" }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('1m').setLabel('1 Tháng').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('6m').setLabel('6 Tháng').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('1y').setLabel('1 Năm').setStyle(ButtonStyle.Danger)
  );

  return { embed, row };
}

// ================= READY =================
client.once(Events.ClientReady, async () => {
  console.log(`✅ Ready: ${client.user.tag}`);
  await initDB();
  await syncAllMembers(); // 
});
// ================= NEW MEMBER DM =================
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (oldMember.user.username !== newMember.user.username) {
    await upsertMember(newMember.id, {
      username: newMember.user.username
    });
    console.log(`🔄 Updated username: ${newMember.user.username}`);
  }
});
  try {
    if (VIP_ROLE_ID && member.roles.cache.has(VIP_ROLE_ID)) return;

    const data = await getMember(member.id);
    const now = Date.now();

    // đang có VIP → bỏ
    if (data?.expireAt && data.expireAt > now) return;

    // anti spam
    if (joinCooldown.has(member.id)) return;
    joinCooldown.add(member.id);
    setTimeout(() => joinCooldown.delete(member.id), 60000);

    // delay tránh block
    await new Promise(res => setTimeout(res, 5000));

    const { embed, row } = vipMenu();

    await member.send({
      content: "🎉 Chào mừng bạn đến server!\n👉 Bạn có thể đăng ký VIP tại đây:",
      embeds: [embed],
      components: [row]
    });

    console.log(`🆕 Sent welcome VIP DM: ${member.user.id}`);

  } catch (err) {
    console.log(`❌ Cannot DM new user: ${member.user.id}`);
  }
});
// ================= COMMAND =================
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  if (msg.content === "!vip") {
    const { embed, row } = vipMenu();
    msg.channel.send({ embeds: [embed], components: [row] });
  }
});

// ================= INTERACTION =================
client.on(Events.InteractionCreate, async i => {
  if (!i.isButton()) return;
  if (!i.inGuild()) return;
  const id = i.user.id;
  const username = i.user.globalName || i.user.username;
await upsertMember(id, { username });
  const guildData = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (!guildData) return;

  // ===== CHỌN PLAN =====
if (['1m', '6m', '1y'].includes(i.customId)) {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const member = await guild.members.fetch(id).catch(() => null);

  // Kiểm tra nếu người dùng đã có role VIP
  if (VIP_ROLE_ID && member?.roles.cache.has(VIP_ROLE_ID)) {
    return i.reply({ content: "❌ Bạn đã có VIP", ephemeral: true });
  }

  await upsertMember(id, { plan: i.customId, awaitingBill: false });

  return i.reply({
    embeds: [new EmbedBuilder().setTitle("💰 Thanh toán").setDescription("Chọn phương thức")],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pay_vn').setLabel('VNĐ').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('pay_jp').setLabel('JPY').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cancel_plan').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      )
    ],
    flags: 64
  });
}

  // ===== CANCEL =====
  if (i.customId === 'cancel_plan') {
    await upsertMember(id, { plan: null, awaitingBill: false });
    return i.reply({ content: "Đã huỷ chọn gói", flags: 64 });
  }

 // ===== PAY VN =====
if (i.customId === 'pay_vn') {
  await i.deferReply({ flags: 64 });
  const data = await getMember(id);
  if (!data?.plan) return i.editReply("Chọn gói trước");

  await upsertMember(id, { currency: 'VN', transferNote: id });

  return i.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🇻🇳 Thanh toán VND")
        .setColor("#00BCD4")
        .setDescription(`
💰 Số tiền: ${PRICE_VN[data.plan].toLocaleString()} VND
🏦 Ngân hàng: ${PAYMENT_VN.bankName}
💳 Số tài khoản: ${PAYMENT_VN.accountNumber}
👤 Chủ tài khoản: ${PAYMENT_VN.accountName}
📝 Nội dung chuyển khoản: Tên đầy đủ của bạn
        `)
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('done_payment').setLabel('Đã thanh toán').setStyle(ButtonStyle.Success)
      )
    ]
  });
}

// ===== PAY JP =====
if (i.customId === 'pay_jp') {
  await i.deferReply({ flags: 64 });
  const data = await getMember(id);
  if (!data?.plan) return i.editReply("Chọn gói trước");

  await upsertMember(id, { currency: 'JP', transferNote: id });

  return i.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🇯🇵 Thanh toán JPY")
        .setColor("#4CAF50")
        .setDescription(`
💰 Số tiền: ${PRICE_JP[data.plan].toLocaleString()} ¥
🏦 Ngân hàng: ${PAYMENT_JP.bankName} - ${PAYMENT_JP.branch}
💳 Số tài khoản: ${PAYMENT_JP.accountNumber}
👤 Chủ tài khoản: ${PAYMENT_JP.accountName}
📝 Nội dung chuyển khoản: Tên đầy đủ của bạn
        `)
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('done_payment').setLabel('Đã thanh toán').setStyle(ButtonStyle.Success)
      )
    ]
  });
}

// ===== DONE PAYMENT + SEND BILL =====
// ===== DONE PAYMENT =====
if (i.customId === 'done_payment') {
  const id = i.user.id;
  const data = await getMember(id);
  if (!data?.plan) return i.reply({ content: "❌ Chọn gói trước", flags: 64 });

  // ✅ Lock tránh spam
  if (billLock.has(id)) return i.reply({ content: "⚠️ Bạn đang gửi yêu cầu, vui lòng chờ", flags: 64 });
  billLock.add(id);
  setTimeout(() => billLock.delete(id), 300000); // 5 phút lock

  // Mark awaitingBill
  await upsertMember(id, { awaitingBill: true });

  // Thêm WAIT_ROLE nếu có
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const member = await guild.members.fetch(id).catch(() => null);
  // Thêm WAIT_ROLE nếu có và lưu vào DB
if (member && data.plan) {
  const waitRoleId = WAIT_ROLE_BY_PLAN[data.plan];
  if (waitRoleId) {
    await member.roles.add(waitRoleId).catch(() => {});
    await upsertMember(id, { waitRoleId }); // lưu wait role vào DB
  }
}

  // DM yêu cầu gửi bill
  const dm = await i.user.createDM();
  await dm.send("📤 Hãy gửi bill qua DM (file hình ảnh)");

  // Collector bill
  if (!client._collectors) client._collectors = {};
  if (client._collectors[id]) client._collectors[id].stop();

  const collector = dm.createMessageCollector({
    filter: m => m.attachments.size > 0,
    time: 300000, // 5 phút
    max: 1
  });
  client._collectors[id] = collector;
  if (client._collectors?.[id]) {
  client._collectors[id].stop();
  delete client._collectors[id];
}

  collector.on('collect', async m => {
    // Lưu lastBill, giữ awaitingBill = true
    await upsertMember(id, { lastBill: m.attachments.first().url });

    // Gửi bill lên admin channel
    const embed = new EmbedBuilder()
      .setTitle("💳 Bill")
      .setDescription(`<@${id}> - ${data.plan}`)
      .setImage(m.attachments.first().url);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${id}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
    .setCustomId(`reject_${id}`)
    .setLabel("Reject")
    .setStyle(ButtonStyle.Danger)
    );

    const adminChannel = await guild.channels.fetch(process.env.ADMIN_CHANNEL_ID).catch(() => null);
    if (!adminChannel) return console.log("❌ Không tìm thấy ADMIN_CHANNEL_ID");

    await adminChannel.send({ embeds: [embed], components: [row] });

    // ✅ Thông báo thân thiện cho user
    await m.reply("✅ Bill đã gửi thành công! Hãy chờ admin duyệt.");
  });

  collector.on('end', async collected => {
  delete client._collectors[id]; // cleanup
  billLock.delete(id);  
  if (collected.size === 0) {
    // Nếu không gửi bill, reset awaitingBill
    await upsertMember(id, { awaitingBill: false });
    console.log(`⏰ Reset awaitingBill (không gửi bill): ${id}`);

    // Lấy lại thông tin về gói và phương thức thanh toán đã chọn
    const data = await getMember(id);
    if (!data?.plan) return; // Nếu không có gói, không làm gì thêm

    // Thông báo thử lại và gửi lại hóa đơn
    await dm.send(`
⚠️ Bạn không gửi hóa đơn trong thời gian yêu cầu. Do đó, yêu cầu của bạn không hợp lệ và đã bị hủy.
👉 Vui lòng gửi lại hóa đơn hợp lệ để tiếp tục quá trình thanh toán.\n\n
👉 Gói bạn đã chọn: ${data.plan} (${data.currency === 'VN' ? 'VNĐ' : 'JPY'})
    `);
  }
});

  // ✅ Confirm defer reply
  await i.reply({ content: "📤 Bạn hãy gửi bill thanh toán cho mình nhé ", flags: 64 });
}

 // ===== APPROVE BILL =====
if (i.customId.startsWith('approve_')) {
  await i.deferReply({ ephemeral: true });

  if (!i.member.roles.cache.has(process.env.ADMIN_ROLE_ID)) {
    return i.followUp({ content: "❌ Bạn không có quyền", ephemeral: true });
  }

  const memberId = i.customId.split('_')[1]; // ✅ FIX

  const data = await getMember(memberId);
  if (!data?.plan) return i.followUp({ content: "❌ User chưa chọn gói", ephemeral: true });

  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const member = await guild.members.fetch(memberId).catch(() => null);
  if (!member) return i.followUp({ content: "❌ Không tìm thấy user", ephemeral: true });

  const now = Date.now();
  const base = data.expireAt && data.expireAt > now ? data.expireAt : now;
  const expire = addMonths(base, planToMonth(data.plan));

  await upsertMember(memberId, {
    expireAt: expire,
    awaitingBill: false,
    lastBill: null,
    waitRoleId: null
  });

  // ❗ remove WAIT role riêng (tối ưu hơn)
  if (data.waitRoleId) {
    await member.roles.remove(data.waitRoleId).catch(()=>{});
  }

  // remove VIP cũ
  await member.roles.remove(Object.values(ROLE_BY_PLAN)).catch(()=>{});

  await member.roles.add(ROLE_BY_PLAN[data.plan]).catch(()=>{});

  await member.send(`🎉 VIP đã duyệt!\nHạn: <t:${Math.floor(expire/1000)}:F>`).catch(()=>{});
  billLock.delete(memberId);
  await i.followUp({ content: `✅ Approved <@${memberId}>`, ephemeral: true });
}

  // ===== REJECT BILL =====
 if (i.customId.startsWith('reject_')) {
  await i.deferReply({ ephemeral: true });

  if (!i.member.roles.cache.has(process.env.ADMIN_ROLE_ID)) {
    return i.followUp({ content: "❌ Bạn không có quyền", ephemeral: true });
  }

  const memberId = i.customId.split('_')[1]; // ✅ FIX

  const data = await getMember(memberId);
  if (!data?.plan) return i.followUp({ content: "❌ User chưa chọn gói", ephemeral: true });

  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const member = await guild.members.fetch(memberId).catch(() => null);
  if (!member) return i.followUp({ content: "❌ Không tìm thấy user", ephemeral: true });

  await member.send(`
❌ Bill không hợp lệ.
👉 Vui lòng gửi lại bill đúng.
  `).catch(()=>{});

  await upsertMember(memberId, {
    awaitingBill: false,
    lastBill: null
  });

  // ❗ remove WAIT role riêng
  if (data.waitRoleId) {
    await member.roles.remove(data.waitRoleId).catch(()=>{});
  }
  billLock.delete(memberId);
  await i.followUp({ content: `🚫 Rejected <@${memberId}>`, ephemeral: true });
}

// --- Hàm tiện ích chuyển gói thành số tháng ---
function planToMonth(plan) {
  switch (plan) {
    case "1m": return 1;
    case "6m": return 6;
    case "1y": return 12;
    default: return 0;
  }
}

// --- Hàm add tháng vào timestamp ---
function addMonths(base, months) {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}
  // ===== OPEN MENU =====
  if (i.customId === 'open_vip_menu') {
    const { embed, row } = vipMenu();
    return i.reply({ embeds: [embed], components: [row], flags: 64 });
  }
});

// ================= CRON REMINDERS 23/25/27 =================

// Hàm gửi DM theo batch
async function sendDMInBatches(userIds, embed, row, batchSize = 10) {
  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(()=>null);
  if (!guild) return;

  for (let i = 0; i < userIds.length; i += batchSize) {
    const batch = userIds.slice(i, i + batchSize);

    await Promise.all(batch.map(async id => {
      try {
        const user = await client.users.fetch(id);
        await user.send({ embeds: [embed], components: [row] });
        console.log(`✅ DM sent: ${id}`);
      } catch (err) {
        console.log(`❌ DM fail: ${id}`);
      }
    }));

    await new Promise(res => setTimeout(res, 2000)); // tránh ratelimit
  }
}

// --- Ngày 23: Nhắc sớm VIP ---
cron.schedule(`0 0 14 23 * *`, async () => {
  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(()=>null);
  if (!guild) return;

  const embed = new EmbedBuilder()
    .setTitle("⏰ Nhắc nhở gia hạn VIP")
    .setDescription("Gói VIP của bạn sắp hết hạn. Vui lòng gia hạn sớm để tiếp tục sử dụng.")
    .setColor("#FF9800");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('open_vip_menu')
      .setLabel("💳 Gia hạn ngay")
      .setStyle(ButtonStyle.Primary)
  );

  const now = Date.now();
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

const upcoming = await pool.query(`
  SELECT * FROM members
  WHERE expireAt IS NOT NULL
    AND expireAt > $1
    AND expireAt - $1 <= $2
    AND (lastReminder IS NULL OR lastReminder < 23)
`, [now, THIRTY_DAYS]);

  // Lọc bỏ user đang có VIP_ROLE_ID
 const userIds = [];
const guildMembers = await guild.members.fetch();

for (const m of upcoming.rows) {
  const member = guildMembers.get(m.id);
  if (!member) continue;

  // ❌ bỏ admin
  if (process.env.ADMIN_ROLE_ID && member.roles.cache.has(process.env.ADMIN_ROLE_ID)) continue;

  // ❌ bỏ VIP free
  if (VIP_ROLE_ID && member.roles.cache.has(VIP_ROLE_ID)) continue;

  userIds.push(m.id);
}

// log
console.log(`📨 Ngày 23: gửi ${userIds.length} user`);

// update DB 1 lần
if (userIds.length > 0) {
  await pool.query(`
    UPDATE members
    SET lastReminder = 23
    WHERE id = ANY($1)
  `, [userIds]);
}

  await sendDMInBatches(userIds, embed, row);
}, { timezone: TIMEZONE });

// --- Ngày 25: Hạn chót ---
cron.schedule(`0 0 14 25 * *`, async () => {
  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(()=>null);
  if (!guild) return;

  const embed = new EmbedBuilder()
    .setTitle("⚠️ Hạn chót gia hạn VIP")
    .setDescription("Gói VIP của bạn sắp hết hạn. Đây là hạn chót, hãy gia hạn ngay để không bị mất quyền lợi.")
    .setColor("#FF5722");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('open_vip_menu')
      .setLabel("💳 Gia hạn ngay")
      .setStyle(ButtonStyle.Primary)
  );

  const now = Date.now();
  const members = await pool.query(`
    SELECT * FROM members
    WHERE lastReminder = 23
      AND (awaitingBill IS NULL OR awaitingBill = false)
      AND expireAt > $1
  `, [now]);

  const userIds = [];
const guildMembers = await guild.members.fetch();

for (const m of members.rows) {
  const member = guildMembers.get(m.id);
  if (!member) continue;

  // ❌ bỏ admin
  if (process.env.ADMIN_ROLE_ID && member.roles.cache.has(process.env.ADMIN_ROLE_ID)) continue;

  // ❌ bỏ VIP free
  if (VIP_ROLE_ID && member.roles.cache.has(VIP_ROLE_ID)) continue;

  userIds.push(m.id);
}

console.log(`📨 Ngày 25: gửi ${userIds.length} user`);
  await sendDMInBatches(userIds, embed, row);
}, { timezone: TIMEZONE });

// --- Ngày 27: Hết hạn, xóa role ---
cron.schedule(`0 0 14 27 * *`, async () => {
  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(()=>null);
  if (!guild) return;

  const embed = new EmbedBuilder()
    .setTitle("❌ VIP hết hạn")
    .setDescription("Gói VIP của bạn đã hết hạn. Quyền lợi sẽ bị tạm ngưng. Vui lòng gia hạn nếu muốn tiếp tục.")
    .setColor("#F44336");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('open_vip_menu')
      .setLabel("💳 Gia hạn ngay")
      .setStyle(ButtonStyle.Primary)
  );

  const now = Date.now();
  const expired = await pool.query(`
    SELECT * FROM members
    WHERE expireAt IS NOT NULL
      AND expireAt <= $1
  `, [now]);

  const userIds = [];
 const guildMembers = await guild.members.fetch(); // fetch tất cả member 1 lần
  for (const m of expired.rows) {
    const member = guildMembers.get(m.id);
    if (!member) continue;

    // ❌ bỏ admin
    if (member.roles.cache.has(process.env.ADMIN_ROLE_ID)) continue;

    // ❌ bỏ VIP free
    if (member.roles.cache.has(VIP_ROLE_ID)) continue;

    // ✅ Remove VIP + WAIT roles
    for (const r of Object.values(ROLE_BY_PLAN)) {
      await member.roles.remove(r).catch(()=>{});
    }
    for (const r of Object.values(WAIT_ROLE_BY_PLAN)) {
  await member.roles.remove(r).catch(() => {});
}

    // Reset DB
    await upsertMember(m.id, { plan: null, expireAt: null });

    // ✅ thêm vào danh sách gửi DM
    userIds.push(m.id);
  }

  await sendDMInBatches(userIds, embed, row);
}, { timezone: TIMEZONE });
// ================= DASHBOARD =================
app.get('/', async (req, res) => {
  const total = await pool.query('SELECT COUNT(*) FROM members');
  const vip = await pool.query(
    'SELECT COUNT(*) FROM members WHERE expireAt > $1',
    [Date.now()]
  );
  const waiting = await pool.query(
    'SELECT COUNT(*) FROM members WHERE awaitingBill = true'
  );

  res.send(`
    <h1>📊 Dashboard VIP</h1>
    <p>Total members: ${total.rows[0].count}</p>
    <p>VIP active: ${vip.rows[0].count}</p>
    <p>Waiting bill: ${waiting.rows[0].count}</p>
  `);
});

app.get('/list', async (req, res) => {
  const data = await pool.query(
    'SELECT * FROM members ORDER BY updatedAt DESC LIMIT 50'
  );

  res.send(`
    <h1>📋 Member list</h1>
    <pre>${JSON.stringify(data.rows, null, 2)}</pre>
  `);
});
app.get('/admin', async (req, res) => {
    // ✅ CHECK KEY
  if (req.query.key !== ADMIN_KEY) {
    return res.send("❌ Unauthorized");
  }
  const { q, status } = req.query;

  let query = `SELECT * FROM members`;
  const conditions = [];
  const values = [];

  if (q) {
  values.push(`%${q}%`);
  conditions.push(`(id LIKE $${values.length} OR username ILIKE $${values.length})`);
}

  if (status === 'waiting') {
    conditions.push(`awaitingBill = true`);
  }

  if (status === 'vip') {
    values.push(Date.now());
    conditions.push(`expireAt > $${values.length}`);
  }

  if (status === 'expired') {
    values.push(Date.now());
    conditions.push(`expireAt <= $${values.length}`);
  }

  if (conditions.length > 0) {
    query += ` WHERE ` + conditions.join(' AND ');
  }

  query += ` ORDER BY updatedAt DESC LIMIT 100`;

  const data = await pool.query(query, values);

  res.send(`
    <h1>🔥 VIP Dashboard</h1>

    <form method="GET">
      <input name="q" placeholder="Search user id..." value="${q || ''}" />
      <select name="status">
        <option value="">All</option>
        <option value="waiting">Waiting bill</option>
        <option value="vip">VIP</option>
        <option value="expired">Expired</option>
      </select>
      <button>Filter</button>
    </form>

    <hr/>

    ${data.rows.map(u => `
      <div style="border:1px solid #ccc;padding:10px;margin:10px">
        <b>User:</b> ${u.username || 'Unknown'} <br/>
        <b>ID:</b> ${u.id}
        <b>Plan:</b> ${u.plan || 'None'} <br/>
        <b>Status:</b> ${
          u.awaitingBill ? '🟡 Waiting bill' :
          (u.expireAt && u.expireAt > Date.now() ? '🟢 VIP' : '🔴 Expired')
        } <br/>
        
        ${u.lastBill ? `<img src="${u.lastBill}" width="200"/><br/>` : ''}

        <a href="/approve/${u.id}?key=${ADMIN_KEY}">✅ Approve</a> |
        <a href="/reject/${u.id}?key=${ADMIN_KEY}">❌ Reject</a>
      </div>
    `).join('')}
  `);
});
app.get('/approve/:id', async (req, res) => {
  // ✅ CHECK KEY
  if (req.query.key !== ADMIN_KEY) {
    return res.send("❌ Unauthorized");
  }
  const memberId = req.params.id;

  const data = await getMember(memberId);
  if (!data?.plan) return res.send("❌ No plan");

  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const member = await guild.members.fetch(memberId).catch(() => null);
  if (!member) return res.send("❌ User not found");

  const now = Date.now();
  const base = data.expireAt && data.expireAt > now ? data.expireAt : now;
  const expire = addMonths(base, planToMonth(data.plan));

  await upsertMember(memberId, {
    expireAt: expire,
    awaitingBill: false,
    lastBill: null,
    waitRoleId: null
  });

  if (data.waitRoleId) {
    await member.roles.remove(data.waitRoleId).catch(()=>{});
  }

  for (const r of Object.values(ROLE_BY_PLAN)) {
    if (r) await member.roles.remove(r).catch(()=>{});
  }

  await member.roles.add(ROLE_BY_PLAN[data.plan]).catch(()=>{});

  await member.send(`🎉 VIP đã duyệt!\nHạn: <t:${Math.floor(expire/1000)}:F>`).catch(()=>{});

  billLock.delete(memberId);

  res.redirect('/admin');
});
app.get('/reject/:id', async (req, res) => {
  // ✅ CHECK KEY
  if (req.query.key !== ADMIN_KEY) {
    return res.send("❌ Unauthorized");
  }
  const memberId = req.params.id;

  const data = await getMember(memberId);
  if (!data) return res.send("❌ Not found");

  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const member = await guild.members.fetch(memberId).catch(() => null);

  if (member) {
    await member.send("❌ Bill bị từ chối. Vui lòng gửi lại.").catch(()=>{});

    if (data.waitRoleId) {
      await member.roles.remove(data.waitRoleId).catch(()=>{});
    }
  }

  await upsertMember(memberId, {
    awaitingBill: false,
    lastBill: null,
    waitRoleId: null
  });

  billLock.delete(memberId);

  res.redirect('/admin');
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Dashboard running on port ${PORT}`);
});
// ================= START BOT =================
client.login(process.env.TOKEN);
process.on('unhandledRejection', e => console.error('UnhandledRejection:', e));
