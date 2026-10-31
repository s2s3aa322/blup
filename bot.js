const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChat = process.env.TELEGRAM_ADMIN_CHAT_ID;
const bot = token ? new TelegramBot(token, { polling: false }) : null;

async function notifyAdmin(sale) {
  if (!bot || !adminChat) return;
  const isWithdraw = sale.network === 'Вывод с сайта';
  const text = [
    isWithdraw ? '💸 Новая заявка на вывод' : '🔔 Новая заявка на продажу',
    '',
    `👤 Пользователь: ${sale.nickname || 'гость'}`,
    `🪙 Актив: ${sale.coin}`,
    sale.amount ? `💰 Количество: ${sale.amount} ${sale.coin}` : '',
    sale.network && !isWithdraw ? `🌐 Сеть: ${sale.network}` : '',
    `🕒 Время: ${new Date().toLocaleString('ru-RU')}`
  ].filter(Boolean).join('\n');
  try { await bot.sendMessage(adminChat, text); }
  catch (e) { console.error('Ошибка отправки уведомления в Telegram:', e.message); }
}

module.exports = { notifyAdmin };
