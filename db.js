const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbPath);

function ensureColumn(table, column, definition) {
  db.all(`PRAGMA table_info(${table})`, (err, rows) => {
    if (err) return console.error(`Не удалось проверить ${table}.${column}:`, err.message);
    if (!rows.some(row => row.name === column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, e => {
        if (e) console.error(`Не удалось добавить ${table}.${column}:`, e.message);
      });
    }
  });
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    nickname TEXT,
    coin TEXT,
    network TEXT,
    wallet TEXT,
    phone TEXT,
    bank TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('stopped', '0')");
  ensureColumn('sales', 'amount', 'TEXT');
  ensureColumn('sales', 'status', "TEXT DEFAULT 'Новая'");
});

module.exports = db;
