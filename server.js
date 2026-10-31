const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const { notifyAdmin } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'fosfor322322';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret-before-deploying';

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(session({
  name: 'blup.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Automatic indicative market rates. Cached for 60 seconds to avoid unnecessary requests.
let ratesCache = { at: 0, value: null };
app.get('/api/rates', async (req, res) => {
  if (ratesCache.value && Date.now() - ratesCache.at < 60_000) {
    return res.json({ ...ratesCache.value, cached: true });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether,the-open-network&vs_currencies=usd,rub', { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Rate provider returned ${response.status}`);
    const data = await response.json();
    const value = {
      usdt: { usd: data.tether?.usd ?? 1, rub: data.tether?.rub ?? null },
      ton: { usd: data['the-open-network']?.usd ?? null, rub: data['the-open-network']?.rub ?? null },
      source: 'CoinGecko', updatedAt: new Date().toISOString(), indicative: true
    };
    if (value.usdt.rub == null || value.ton.rub == null) throw new Error('Rate data incomplete');
    ratesCache = { at: Date.now(), value };
    res.json(value);
  } catch (e) {
    console.error('Не удалось получить рыночные курсы:', e.message);
    if (ratesCache.value) return res.json({ ...ratesCache.value, stale: true });
    res.status(503).json({ error: 'Курс временно недоступен. Попробуйте позже.' });
  } finally { clearTimeout(timeout); }
});

app.get('/api/status', (req, res) => {
  db.get("SELECT value FROM settings WHERE key='stopped'", (err, row) => {
    if (err) return res.status(500).json({ error: 'Ошибка БД' });
    res.json({ stopped: !!row && row.value === '1' && req.session.isAdmin !== true });
  });
});

app.post('/api/register', (req, res) => {
  let { nickname, password } = req.body || {};
  nickname = typeof nickname === 'string' ? nickname.trim() : '';
  password = typeof password === 'string' ? password : '';
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(nickname) || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Ник: 3–24 символа (буквы, цифры, _ или -). Пароль: минимум 8 символов.' });
  }
  const hash = bcrypt.hashSync(password, 12);
  db.run('INSERT INTO users (nickname, password_hash) VALUES (?, ?)', [nickname, hash], function(err) {
    if (err) return res.status(err.code === 'SQLITE_CONSTRAINT' ? 409 : 500).json({ error: err.code === 'SQLITE_CONSTRAINT' ? 'Такой ник уже занят' : 'Ошибка базы данных' });
    req.session.regenerate(sessionErr => {
      if (sessionErr) return res.status(500).json({ error: 'Не удалось создать сессию' });
      req.session.userId = this.lastID;
      req.session.nickname = nickname;
      req.session.save(saveErr => saveErr ? res.status(500).json({ error: 'Не удалось сохранить сессию' }) : res.json({ ok: true, nickname }));
    });
  });
});

app.post('/api/login', (req, res) => {
  const nickname = typeof req.body?.nickname === 'string' ? req.body.nickname.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  db.get('SELECT * FROM users WHERE nickname = ?', [nickname], (err, user) => {
    if (err) return res.status(500).json({ error: 'Ошибка базы данных' });
    if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(400).json({ error: 'Неверный ник или пароль' });
    req.session.regenerate(sessionErr => {
      if (sessionErr) return res.status(500).json({ error: 'Не удалось создать сессию' });
      req.session.userId = user.id;
      req.session.nickname = user.nickname;
      req.session.save(saveErr => saveErr ? res.status(500).json({ error: 'Не удалось сохранить сессию' }) : res.json({ ok: true, nickname: user.nickname }));
    });
  });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ nickname: req.session.nickname || null }));

// Regular users see their own history; admins can see all records.
app.get('/api/history', (req, res) => {
  if (!req.session.userId && !req.session.isAdmin) return res.status(401).json({ error: 'Войдите, чтобы посмотреть историю' });
  const sql = req.session.isAdmin
    ? 'SELECT id, nickname, coin, network, amount, status, created_at FROM sales ORDER BY id DESC LIMIT 200'
    : 'SELECT id, nickname, coin, network, amount, status, created_at FROM sales WHERE user_id = ? ORDER BY id DESC LIMIT 100';
  const params = req.session.isAdmin ? [] : [req.session.userId];
  db.all(sql, params, (err, rows) => err ? res.status(500).json({ error: 'Ошибка базы данных' }) : res.json(rows || []));
});

app.post('/api/sell', (req, res) => {
  db.get("SELECT value FROM settings WHERE key='stopped'", (err, row) => {
    if (err) return res.status(500).json({ error: 'Ошибка базы данных' });
    if (row?.value === '1' && req.session.isAdmin !== true) return res.status(403).json({ error: 'Приём заявок временно остановлен' });
    if (!req.session.userId) return res.status(401).json({ error: 'Сначала войдите в аккаунт' });
    const { coin, network, wallet, phone, bank, amount } = req.body || {};
    const validAmount = amount !== undefined && amount !== null && String(amount).trim() !== '' && Number.isFinite(Number(amount)) && Number(amount) > 0 && Number(amount) <= 1000000000;
    if (!coin || !wallet || !phone || !bank || !validAmount) return res.status(400).json({ error: 'Укажите корректное количество актива, телефон и банк' });
    db.run('INSERT INTO sales (user_id, nickname, coin, network, wallet, phone, bank, amount, status) VALUES (?,?,?,?,?,?,?,?,?)',
      [req.session.userId, req.session.nickname, String(coin).slice(0, 30), String(network || '').slice(0, 50), String(wallet).slice(0, 200), String(phone).slice(0, 100), String(bank).slice(0, 150), String(amount).slice(0, 30), 'Новая'],
      function(insertErr) {
        if (insertErr) return res.status(500).json({ error: 'Не удалось сохранить заявку' });
        notifyAdmin({ id: this.lastID, nickname: req.session.nickname, coin, network, amount }).catch(e => console.error('Telegram:', e.message));
        res.json({ ok: true, id: this.lastID });
      });
  });
});

app.post('/api/admin/login', (req, res) => {
  if (typeof req.body?.password === 'string' && req.body.password === ADMIN_PASSWORD) {
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Не удалось создать сессию' });
      req.session.isAdmin = true;
      req.session.save(saveErr => saveErr ? res.status(500).json({ error: 'Не удалось сохранить сессию' }) : res.json({ ok: true }));
    });
  } else res.status(403).json({ error: 'Неверный пароль' });
});

app.get('/api/admin/stopped', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'forbidden' });
  db.get("SELECT value FROM settings WHERE key='stopped'", (err, row) => err ? res.status(500).json({ error: 'Ошибка БД' }) : res.json({ stopped: row?.value === '1' }));
});
app.post('/api/admin/toggle-stop', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'forbidden' });
  db.get("SELECT value FROM settings WHERE key='stopped'", (err, row) => {
    if (err) return res.status(500).json({ error: 'Ошибка БД' });
    const next = row?.value === '1' ? '0' : '1';
    db.run("INSERT INTO settings (key, value) VALUES ('stopped', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [next], e => e ? res.status(500).json({ error: 'Ошибка БД' }) : res.json({ stopped: next === '1' }));
  });
});
app.get('/api/admin/history', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'forbidden' });
  db.all('SELECT id, nickname, coin, network, amount, status, created_at FROM sales ORDER BY id DESC LIMIT 200', [], (err, rows) => err ? res.status(500).json({ error: 'Ошибка БД' }) : res.json(rows || []));
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.listen(PORT, () => console.log(`BLUP запущен на порту ${PORT}`));
