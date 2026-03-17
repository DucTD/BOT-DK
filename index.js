require('dotenv').config();

/* ================= IMPORT ================= */
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  EmbedBuilder
} = require('discord.js');

const fs = require('fs');
const QRCode = require('qrcode');

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

/* ================= DEBUG ENV ================= */
console.log("================ ENV DEBUG ================");
console.log("TOKEN:", process.env.TOKEN ? "OK" : "NULL");
console.log("GUILD_ID:", process.env.GUILD_ID);
console.log("ADMIN_CHANNEL_ID:", process.env.ADMIN_CHANNEL_ID);
console.log("===========================================");

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

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
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
    bankName: 'Techcombank',
    bankBin: '970407',
    accountName: 'NGUYEN DUY THINH',
    accountNumber: '86196868888'
  },
  JP: {
    bank: 'SMBC Bank',
    branch: '目白支店　(メジロ) 677',
    accountNumber: '６９７０８９４',
    accountName: 'グエンズイテイン'
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

/* ================= VIETQR ================= */

function generateVietQR({ bin, account, amount, note }) {

  const payload =
`00020101021138540010A00000072701240006${bin}0108${account}0208QRIBFTTA530370454${amount}5802VN6220${note.length}${note}6304`;

  return payload;
}

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

/* ================= START ================= */

client.login(process.env.TOKEN)
  .then(() => console.log("🚀 LOGIN SUCCESS"))
  .catch(err => console.error("❌ LOGIN ERROR:", err));

require('http')
  .createServer((_, res) => res.end('OK'))
  .listen(process.env.PORT || 3000);
