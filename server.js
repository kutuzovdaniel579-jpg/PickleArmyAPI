import express from "express";
import cors from "cors";
import "dotenv/config";
import db from "./db.js";
import { sendSecurityCode } from "./discord.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// helper: zorg dat user bestaat
function ensureUser(name) {
  const get = db.prepare("SELECT * FROM users WHERE minecraftName = ?");
  let user = get.get(name);
  if (!user) {
    db.prepare("INSERT INTO users (minecraftName, balance) VALUES (?, 0)").run(name);
    user = get.get(name);
  }
  return user;
}

// GET /balance?user=NAME
app.get("/balance", (req, res) => {
  const user = req.query.user;
  if (!user) return res.json({ success: false, error: "Missing user" });

  const row = ensureUser(user);
  res.json({ success: true, balance: row.balance });
});

// GET /transactions?user=NAME
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

// POST /requestCode { user, cardId }
app.post("/requestCode", (req, res) => {
  const { user, cardId } = req.body;
  if (!user || !cardId) return res.json({ success: false, error: "Missing user or cardId" });

  const card = db.prepare("SELECT * FROM cards WHERE cardId = ?").get(cardId);
  if (!card || card.ownerMinecraftName !== user) {
    return res.json({ success: false, error: "Ongeldige bankkaart" });
  }

  const u = ensureUser(user);
  if (!u.discordId) {
    return res.json({ success: false, error: "Geen Discord gekoppeld" });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 5 * 60 * 1000;

  db.prepare(`
    INSERT INTO security_codes (minecraftName, code, expiresAt)
    VALUES (?, ?, ?)
    ON CONFLICT(minecraftName) DO UPDATE SET code = excluded.code, expiresAt = excluded.expiresAt
  `).run(user, code, expiresAt);

  sendSecurityCode(u.discordId, code);
  res.json({ success: true, message: "Security code sent to Discord." });
});

// POST /transfer { from, to, amount, cardId, secCode }
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

// POST /withdraw { user, amount }
app.post("/withdraw", (req, res) => {
  const { user, amount } = req.body;
  if (!user || !amount) return res.json({ success: false, error: "Missing fields" });

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
    note: "Voer nu handmatig de in‑game cash uit (bijv. /give of /eco)."
  });
});

app.get("/", (_, res) => {
  res.json({ ok: true, service: "PickleBank API" });
});

app.listen(PORT, () => {
  console.log("PickleBank API running on port", PORT);
});
