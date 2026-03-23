require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, EmbedBuilder } = require('discord.js');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const { createQR } = require('vietqr');
const cron = require('node-cron');
const TIMEZONE = 'Asia/Ho_Chi_Minh';
// ================= POSTGRESQL =================
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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
      updatedAt BIGINT
    )
  `);
}

async function getMember(id) {
  const res = await pool.query('SELECT * FROM members WHERE id=$1', [id]);
  return res.rows[0];
}

async function upsertMember(id, data) {
  const now = Date.now();
  const fields = {
    plan: data.plan || null,
    expireAt: data.expireAt || null,
    currency: data.currency || null,
    transferNote: data.transferNote || null,
    awaitingBill: data.awaitingBill || false,
    lastBill: data.lastBill || null,
    updatedAt: now
  };
  await pool.query(`
    INSERT INTO members (id, plan, expireAt, currency, transferNote, awaitingBill, lastBill, updatedAt)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO UPDATE
    SET plan=$2, expireAt=$3, currency=$4, transferNote=$5, awaitingBill=$6, lastBill=$7, updatedAt=$8
  `, [id, fields.plan, fields.expireAt, fields.currency, fields.transferNote, fields.awaitingBill, fields.lastBill, fields.updatedAt]);
}

// ================= CONFIG =================
const ROLE_BY_PLAN = { '1m': process.env.ROLE_1T_ID, '6m': process.env.ROLE_6T_ID, '1y': process.env.ROLE_1Y_ID };
const PRICE_VN = { '1m': 2000000, '6m': 11000000, '1y': 22000000 };
const PRICE_JP = { '1m': 11000, '6m': 60500, '1y': 121000 };
const PAYMENT_VN = { bankName: "Techcombank", bankBin: '970407', accountNumber: '86196868888', accountName: 'NGUYEN DUY THINH' };
const PAYMENT_JP = { bankName: "三井住友銀行", branch: "目白支店　(メジロ) 677", accountNumber: "6970894", accountName: "グエンズイテイン" };
const VIP_ROLE_ID = process.env.VIP_ROLE_ID;

const addMonths = (base, m) => { const d = new Date(base); d.setMonth(d.getMonth() + m); return d.getTime(); };
const planToMonth = p => (p === '6m' ? 6 : p === '1y' ? 12 : 1);

// ================= CLIENT =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

// ================= ROLE FUNC =================
async function updateFinalRole(guild, userId, plan) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  for (const r of Object.values(ROLE_BY_PLAN)) await member.roles.remove(r).catch(() => {});
  await member.roles.add(ROLE_BY_PLAN[plan]).catch(() => {});
}

// ================= VIP MENU =================
function vipMenu() {
  const embed = new EmbedBuilder()
    .setTitle("📝 ĐĂNG KÝ THÀNH VIÊN KEMINVEST")
    .setDescription("Kính gửi quý thành viên.\n• Hệ thống tự động hỗ trợ thanh toán.\n• Chọn gói bên dưới để tiếp tục.")
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

// ================= STARTUP =================
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot ready: ${client.user.tag}`);
  await initDB();
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  await guild.members.fetch();

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    const roles = Object.entries(ROLE_BY_PLAN).filter(([plan, roleId]) => member.roles.cache.has(roleId));
    if (roles.length > 0) {
      const plan = roles[0][0];
      await upsertMember(member.id, { plan, expireAt: null });
    } else {
      await upsertMember(member.id, {});
    }
  }

  const now = Date.now();
  const res = await pool.query('SELECT * FROM members WHERE expireAt IS NOT NULL AND expireAt <= $1', [now]);
  for (const m of res.rows) {
    const member = await guild.members.fetch(m.id).catch(() => null);
    if (member) {
      for (const r of Object.values(ROLE_BY_PLAN)) await member.roles.remove(r).catch(() => {});
      await upsertMember(m.id, { plan: null, expireAt: null });
    }
  }
  console.log("✅ Startup complete: members loaded & expired roles removed");
});

// ================= COMMAND =================
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  if (msg.content === "!vip") {
    const { embed, row } = vipMenu();
    return msg.channel.send({ embeds: [embed], components: [row] });
  }
});

// ================= INTERACTIONS =================
client.on(Events.InteractionCreate, async i => {
  if (!i.isButton()) return;
  const id = i.user.id;
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  let memberData = await getMember(id);
  if (!memberData) { await upsertMember(id, {}); memberData = await getMember(id); }

  // Chọn gói
  if (['1m','6m','1y'].includes(i.customId)) {
    await upsertMember(id, { plan: i.customId, awaitingBill: false });
    const embed = new EmbedBuilder().setTitle("💰 Thanh toán").setDescription("Chọn phương thức thanh toán").setColor("#00C853");
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pay_vn').setLabel('🇻🇳 VNĐ').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('pay_jp').setLabel('🇯🇵 JPY').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('cancel_plan').setLabel('❌ Cancel / Thay đổi plan').setStyle(ButtonStyle.Secondary)
    );
    return i.reply({ embeds: [embed], components: [row], flags: 64 });
  }

  // Cancel plan
  if (i.customId === 'cancel_plan') {
    await upsertMember(id, { plan: null, awaitingBill: false });
    return i.reply({ content: "✅ Bạn đã hủy lựa chọn gói. Vui lòng chọn lại gói VIP.", flags: 64 });
  }

 // ==================== PAY VN ====================
if (i.customId === 'pay_vn') {
  await i.deferReply({ flags: 64 });
  const data = await getMember(id);
  if (!data.plan) return i.editReply({ content: "❌ Vui lòng chọn gói trước.", embeds: [], components: [] });

  // Cập nhật currency + transfer note
  await upsertMember(id, { currency: 'VN', transferNote: `${id}` });

  let qrBuffer = null;
  try {
    const qrString = createQR({
      accountName: PAYMENT_VN.accountName,
      accountNumber: PAYMENT_VN.accountNumber,
      bankCode: PAYMENT_VN.bankBin,
      amount: PRICE_VN[data.plan],
      addInfo: `${id}`
    });
    qrBuffer = await QRCode.toBuffer(qrString, { type: 'png', width: 350 });
  } catch {
    qrBuffer = null;
  }

  // Fallback description nếu QR lỗi
  const description = qrBuffer
    ? `📷 Quét QR để thanh toán nhanh hoặc dùng thông tin trên nếu QR lỗi.`
    : `❌ QR lỗi, vui lòng sử dụng thông tin chuyển khoản bên dưới.`;

  // Tạo embed hiển thị thông tin thanh toán
  const embed = new EmbedBuilder()
    .setTitle("🇻🇳 Thanh toán VNĐ")
    .setColor("#FFD700")
    .setDescription(
      `💰 Số tiền: ${PRICE_VN[data.plan].toLocaleString()} VND\n` +
      `👤 Chủ tài khoản: ${PAYMENT_VN.accountName}\n` +
      `🏦 Ngân hàng: ${PAYMENT_VN.bankName}\n` +
      `💳 STK: ${PAYMENT_VN.accountNumber}\n` +
      `📝 Nội dung chuyển khoản: ${id}\n\n` +
      description
    );

  // Nút “Đã thanh toán”
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('done_payment').setLabel('✅ Đã Thanh toán').setStyle(ButtonStyle.Success)
  );

  // Gửi reply + attach QR nếu có
  return i.editReply({
    embeds: [embed],
    files: qrBuffer ? [{ attachment: qrBuffer, name: 'qr.png' }] : [],
    components: [row]
  });
}

  // Pay JP
  if (i.customId === 'pay_jp') {
    await i.deferReply({ flags: 64 });
    const data = await getMember(id);
    if (!data.plan) return i.editReply({ content: "❌ Vui lòng chọn gói trước.", embeds: [], components: [] });
    await upsertMember(id, { currency: 'JP' });

    const embed = new EmbedBuilder()
      .setTitle("🇯🇵 Thanh toán JPY")
      .addFields(
        { name: "Số tiền", value: `${PRICE_JP[data.plan]} JPY` },
        { name: "Ngân hàng", value: PAYMENT_JP.bankName },
        { name: "Chi nhánh", value: PAYMENT_JP.branch },
        { name: "STK", value: PAYMENT_JP.accountNumber },
        { name: "Chủ tài khoản", value: PAYMENT_JP.accountName }
      )
      .setColor("#4CAF50");

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('done_payment').setLabel('✅ Đã Thanh toán').setStyle(ButtonStyle.Success)
    );

    return i.editReply({ embeds: [embed], components: [row] });
  }

  // Done payment
  if (i.customId === 'done_payment') {
    await upsertMember(id, { awaitingBill: true });
    await i.reply({ content: "✅ Vui lòng gửi ảnh bill để admin phê duyệt.", flags: 64 });

    const dm = await i.user.createDM();
    const filter = m => m.author.id === id && m.attachments.size > 0 && m.attachments.some(a => a.contentType?.startsWith('image/'));
    const collector = dm.createMessageCollector({ filter, time: 5*60*1000, max: 1 });

    setTimeout(() => { if (!collector.ended) dm.send("⌛ Bạn còn 1 phút để gửi bill, nếu không sẽ hủy.").catch(()=>{}); }, 4*60*1000);

    collector.on('collect', async m => {
      const attachment = m.attachments.find(a => a.contentType?.startsWith('image/'));
      if (!attachment) return dm.send("❌ Vui lòng gửi ảnh hợp lệ.").catch(() => {});
      const adminChannel = guild.channels.cache.get(process.env.ADMIN_CHANNEL_ID);
      if (!adminChannel) return dm.send("❌ Không tìm thấy channel phê duyệt.").catch(() => {});

      const embed = new EmbedBuilder()
        .setTitle("💳 Xác nhận thanh toán")
        .setDescription(`Người dùng <@${id}> gửi bill.\nGói: **${memberData.plan}**`)
        .setColor("#FFA500")
        .setImage(attachment.url)
        .setFooter({ text: "Bấm nút APPROVE nếu đã nhận tiền" });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve_${id}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success)
      );

      await adminChannel.send({ embeds: [embed], components: [row] });
      dm.send("🎉 Bill đã gửi admin phê duyệt.").catch(() => {});
    });

  collector.on('end', async collected => {
  await upsertMember(id, { awaitingBill: false });
  if (collected.size === 0) {
    dm.send("❌ Bạn chưa gửi bill kịp thời, vui lòng thử lại!").catch(() => {});
  }
});
  }

// ================= APPROVE ADMIN + DM USER (Fix not found user) =================
if (i.customId.startsWith('approve_')) {
  const userId = String(i.customId.split('_')[1]);
  const memberData = await getMember(userId);

  // Kiểm tra user trong DB
  if (!memberData) {
    await i.reply({ content: `❌ Không tìm thấy thông tin user ${userId} trong database. Vui lòng kiểm tra lại.`, flags: 64 });
    return;
  }

  // Kiểm tra user đã chọn gói chưa
  if (!memberData.plan) {
    await i.reply({ content: "❌ User chưa chọn gói VIP.", flags: 64 });
    return;
  }

  const plan = memberData.plan;
  const newExpire = addMonths(Math.max(Date.now(), memberData.expireAt || 0), planToMonth(plan));

  // Cập nhật expireAt + awaitingBill = false trong DB
  await upsertMember(userId, { expireAt: newExpire, awaitingBill: false });

  // --- Cập nhật role VIP ---
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  let member = null;
  if (guild) {
    member = await guild.members.fetch(userId).catch(() => null);
  }

  if (member) {
    await updateFinalRole(guild, userId, plan);
  } else {
    // Nếu không tìm thấy member trong guild, log cho admin
    console.log(`⚠️ Approve: user ${userId} không có trong guild, chỉ cập nhật DB expireAt.`);
  }

  // --- Disable button trên message admin ---
  if (i.message.components.length > 0) {
    i.message.components.forEach(row => row.components.forEach(c => c.setDisabled(true)));
    const adminEmbed = EmbedBuilder.from(i.message.embeds[0])
      .setFooter({ text: `✅ Approved bởi ${i.user.tag}` })
      .setColor("#00C853");
    await i.update({ content: null, embeds: [adminEmbed], components: i.message.components });
  }

  // --- Gửi DM user nếu có ---
  if (member) {
    const expireDate = new Date(newExpire).toLocaleDateString('vi-VN');
    const embed = new EmbedBuilder()
      .setTitle("🎉 Kích hoạt VIP thành công!")
      .setDescription(`Xin chúc mừng, gói VIP **${plan}** của bạn đã được kích hoạt.`)
      .addFields(
        { name: "📅 Hết hạn", value: `**${expireDate}**`, inline: true },
        { name: "💳 Gói hiện tại", value: `**${plan}**`, inline: true }
      )
      .setColor("#FFD700") // vàng nổi bật
      .setThumbnail("https://i.imgur.com/8QfQ3Vx.png") // icon VIP
      .setFooter({ text: "Hãy gia hạn trước ngày hết hạn để duy trì quyền lợi VIP" });

    await member.user.send({ embeds: [embed] }).catch(() => {
      console.log(`⚠️ Không thể gửi DM cho user ${userId}`);
    });
  }
}

  // Open VIP menu
  if (i.customId === 'open_vip_menu') {
    const { embed, row } = vipMenu();
    return i.reply({ embeds: [embed], components: [row], flags: 64 });
  }
});

// ================= CRON REMINDERS 23/25/27 =================
async function sendDMInBatches(userIds, embed, row, batchSize = 10) {
  for (let i = 0; i < userIds.length; i += batchSize) {
    const batch = userIds.slice(i, i + batchSize);
    await Promise.all(batch.map(async id => {
      const user = await client.users.fetch(id).catch(() => null);
      if (user) {
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        const member = await guild.members.fetch(id).catch(() => null);
        // Chỉ gửi DM cho user chưa có role VIP
        await member.fetch(); // đảm bảo roles được load
        if (!member || !member.roles.cache.has(VIP_ROLE_ID)) {
          await user.send({ embeds: [embed], components: [row] }).catch(() => {});
           // ✅ log DM sent
      console.log(`DM sent to expired VIP: ${id}`);
        }
      }
    }));
    // Delay 2s giữa các batch để tránh rate limit
    await new Promise(res => setTimeout(res, 2000));
  }
}

// --- Ngày 23: nhắc gia hạn sớm ---
cron.schedule(`0 0 14 23 * *`, async () => {
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
  const members = await pool.query('SELECT * FROM members WHERE expireAt IS NOT NULL AND expireAt > $1', [now]);
  await sendDMInBatches(members.rows.map(r => r.id), embed, row);
}, { timezone: TIMEZONE });

// --- Ngày 25: hạn chót ---
cron.schedule(`0 0 14 25 * *`, async () => {
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
  const members = await pool.query('SELECT * FROM members WHERE expireAt IS NOT NULL AND expireAt > $1', [now]);
  await sendDMInBatches(members.rows.map(r => r.id), embed, row);
}, { timezone: TIMEZONE });

// --- Ngày 27: hết hạn + xóa role ---
cron.schedule(`0 0 14 27 * *`, async () => {
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

  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  const now = Date.now();
  const expired = await pool.query('SELECT * FROM members WHERE expireAt IS NOT NULL AND expireAt <= $1', [now]);

  for (const m of expired.rows) {
    const member = await guild.members.fetch(m.id).catch(() => null);
    if (member) {
      for (const r of Object.values(ROLE_BY_PLAN)) await member.roles.remove(r).catch(() => {});
      await upsertMember(m.id, { plan: null, expireAt: null });
    }
  }

  await sendDMInBatches(expired.rows.map(r => r.id), embed, row);
}, { timezone: TIMEZONE });
// ================= START BOT =================
client.login(process.env.TOKEN);
process.on('unhandledRejection', e => console.error('UnhandledRejection:', e));
