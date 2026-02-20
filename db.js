import Database from "better-sqlite3";

const db = new Database("picklebank.sqlite");

// users: minecraftName, balance, discordId
db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    minecraftName TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    discordId TEXT
  )
`).run();

// cards: cardId, ownerMinecraftName
db.prepare(`
  CREATE TABLE IF NOT EXISTS cards (
    cardId TEXT PRIMARY KEY,
    ownerMinecraftName TEXT NOT NULL
  )
`).run();

// transactions: id, fromUser, toUser, amount, date, description
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

// security_codes: minecraftName, code, expiresAt
db.prepare(`
  CREATE TABLE IF NOT EXISTS security_codes (
    minecraftName TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  )
`).run();

export default db;
