import express from "express";
import cors from "cors";
import "dotenv/config";
import Database from "better-sqlite3";
import { Client, GatewayIntentBits } from "discord.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------------------------
// DATABASE
// ---------------------------

const db = new Database("picklebank.sqlite");

// users
db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    minecraftName TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    discordId TEXT
  )
`).run();

// cards
db.prepare(`
  CREATE TABLE IF NOT EXISTS cards (
    cardId TEXT PRIMARY KEY,
    ownerMinecraftName TEXT NOT NULL
  )
`).run();

// transactions
db.prepare(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fromUser TEXT,
    toUser TEXT,
    amount INTEGER NOT NULL,
    date TEXT NOT NULL,
    description TEXT
  )
`).run();

// security codes
db.prepare(`
  CREATE TABLE IF NOT EXISTS security_codes (
    minecraftName TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  )
`).run();

// ---------------------------
// DISCORD BOT
// ---------------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: ["CHANNEL"]
});

if (process.env.DISCORD_TOKEN) {
  client.login(process.env.DISCORD_TOKEN).catch(console.error);
} else {
  console.warn("⚠️ DISCORD_TOKEN ontbreekt in Render Environment Variables");
}

async function sendSecurityCode(discordId, code) {
  try {
    const user = await client.users.fetch(discordId);
    await user.send(`🔐 Jouw PickleBank beveiligingscode is: **${code}**`);
  } catch (e) {
    console.error("Kon Discord-code niet versturen:", e);
  }
}

// ---------------------------
// HELPERS
// ---------------------------

function ensureUser(name) {
  const get = db.prepare("SELECT * FROM users WHERE minecraftName = ?");
  let user = get.get(name);
  if (!user) {
    db.prepare("INSERT INTO users (minecraftName, balance) VALUES (?, 0)").run(name);
    user = get.get(name);
  }
  return user;
}

// ---------------------------
// API ENDPOINTS
// ---------------------------

// GET /balance
app.get("/balance", (req, res) => {
  const user = req.query.user;
  if (!user) return res.json({ success: false, error: "Missing user" });

  const row = ensureUser(user);
  res.json({ success: true, balance: row.balance });
});

// GET /transactions
app.get("/transactions", (req, res) => {
  const user = req.query.user;
  if (!user) return res.json({ success: false, error: "Missing user" });

  const stmt = db.prepare(`
    SELECT date, description, amount
    FROM transactions
    WHERE fromUser = ? OR toUser = ?
    ORDER BY id DESC
    LIMIT 50
  `);

  const rows = stmt.all(user, user);
  res.json({ success: true, transactions: rows });
});

// POST /requestCode
app.post("/requestCode", (req, res) => {
  const { user, cardId } = req.body;

  if (!user || !cardId) {
    return res.json({ success: false, error: "Missing user or cardId" });
  }

  const card = db.prepare("SELECT * FROM cards WHERE cardId = ?").get(cardId);
  if (!card || card.ownerMinecraftName !== user) {
    return res.json({ success: false, error: "Ongeldige bankkaart" });
  }

  const u = ensureUser(user);

  if (!u.discordId) {
    return res.json({ success: false, error: "Geen Discord gekoppeld aan deze speler" });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 5 * 60 * 1000;

  db.prepare(`
    INSERT INTO security_codes (minecraftName, code, expiresAt)
    VALUES (?, ?, ?)
    ON CONFLICT(minecraftName) DO UPDATE SET code = excluded.code, expiresAt = excluded.expiresAt
  `).run(user, code, expiresAt);

  sendSecurityCode(u.discordId, code);

  res.json({ success: true, message: "Security code verstuurd via Discord" });
});

// POST /transfer
app.post("/transfer", (req, res) => {
  const { from, to, amount, cardId, secCode } = req.body;

  if (!from || !to || !amount || !cardId || !secCode) {
    return res.json({ success: false, error: "Missing fields" });
  }

  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) {
    return res.json({ success: false, error: "Invalid amount" });
  }

  const card = db.prepare("SELECT * FROM cards WHERE cardId = ?").get(cardId);
  if (!card || card.ownerMinecraftName !== from) {
    return res.json({ success: false, error: "Ongeldige bankkaart" });
  }

  const codeRow = db.prepare("SELECT * FROM security_codes WHERE minecraftName = ?").get(from);
  if (!codeRow || codeRow.code !== String(secCode) || codeRow.expiresAt < Date.now()) {
    return res.json({ success: false, error: "Ongeldige of verlopen security code" });
  }

  const fromUser = ensureUser(from);
  const toUser = ensureUser(to);

  if (fromUser.balance < amt) {
    return res.json({ success: false, error: "Onvoldoende saldo" });
  }

  const updateBalance = db.prepare("UPDATE users SET balance = ? WHERE minecraftName = ?");
  const insertTx = db.prepare(`
    INSERT INTO transactions (fromUser, toUser, amount, date, description)
    VALUES (?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString().slice(0, 10);

  const tx = db.transaction(() => {
    updateBalance.run(fromUser.balance - amt, from);
    updateBalance.run(toUser.balance + amt, to);

    insertTx.run(from, to, -amt, now, `Overboeking naar ${to}`);
    insertTx.run(from, to, amt, now, `Ontvangen van ${from}`);

    db.prepare("DELETE FROM security_codes WHERE minecraftName = ?").run(from);
  });

  tx();

  const newFrom = ensureUser(from);
  res.json({ success: true, newBalance: newFrom.balance });
});

// POST /withdraw
app.post("/withdraw", (req, res) => {
  const { user, amount } = req.body;

  if (!user || !amount) {
    return res.json({ success: false, error: "Missing fields" });
  }

  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) {
    return res.json({ success: false, error: "Invalid amount" });
  }

  const u = ensureUser(user);

  if (u.balance < amt) {
    return res.json({ success: false, error: "Onvoldoende saldo" });
  }

  const updateBalance = db.prepare("UPDATE users SET balance = ? WHERE minecraftName = ?");
  const insertTx = db.prepare(`
    INSERT INTO transactions (fromUser, toUser, amount, date, description)
    VALUES (?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString().slice(0, 10);

  const tx = db.transaction(() => {
    updateBalance.run(u.balance - amt, user);
    insertTx.run(user, null, -amt, now, "Cash opname");
  });

  tx();

  const newUser = ensureUser(user);

  res.json({
    success: true,
    newBalance: newUser.balance,
    note: "Voer nu handmatig de in‑game cash uit."
  });
});

// ---------------------------
// ADMIN: ADD CARD
// ---------------------------

app.post("/admin/addCard", (req, res) => {
  const { secret, cardId, owner } = req.body;

  if (secret !== process.env.ADMIN_SECRET) {
    return res.json({ success: false, error: "Unauthorized" });
  }

  if (!cardId || !owner) {
    return res.json({ success: false, error: "Missing cardId or owner" });
  }

  try {
    db.prepare(`
      INSERT INTO cards (cardId, ownerMinecraftName)
      VALUES (?, ?)
    `).run(cardId, owner);

    res.json({ success: true, message: "Bankkaart toegevoegd" });
  } catch (e) {
    res.json({ success: false, error: "Kaart bestaat al of databasefout" });
  }
});

// ---------------------------
// ROOT
// ---------------------------

app.get("/", (_, res) => {
  res.json({ ok: true, service: "PickleBank API" });
});

// ---------------------------
// START SERVER
// ---------------------------

app.listen(PORT, () => {
  console.log("PickleBank API draait op poort", PORT);
});
