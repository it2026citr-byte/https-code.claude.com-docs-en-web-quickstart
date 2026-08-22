#!/data/data/com.termux/files/usr/bin/sh
#
# Сторож бота для Termux.
#
#   * не даёт запуститься второй копии — Telegram пускает к очереди
#     только одного, вторая получит ошибку 409;
#   * держит замок пробуждения, чтобы Android не усыплял процесс;
#   * поднимает бота обратно, если тот упал;
#   * пишет лог и не даёт ему разрастись.
#
# Запуск вручную:  sh ~/repo/bot/termux-run.sh
# Остановка:       sh ~/repo/bot/termux-run.sh stop

DIR="$(cd "$(dirname "$0")" && pwd)"
STORAGE="$DIR/storage"
PIDFILE="$STORAGE/supervisor.pid"
NODEPID="$STORAGE/node.pid"
LOG="$STORAGE/bot.log"
MAXLOG=2000000          # 2 МБ, дальше обрезаем

mkdir -p "$STORAGE"

alive() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null
}

if [ "$1" = "stop" ]; then
  STOPPED=0
  # Сначала сторож, чтобы он не поднял бота обратно, потом сам бот.
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null && STOPPED=1
    rm -f "$PIDFILE"
  fi
  if [ -f "$NODEPID" ]; then
    kill "$(cat "$NODEPID")" 2>/dev/null && STOPPED=1
    rm -f "$NODEPID"
  fi
  [ "$STOPPED" = 1 ] && echo "остановлен" || echo "не был запущен"
  exit 0
fi

if [ "$1" = "status" ]; then
  if alive; then
    echo "сторож работает, PID $(cat "$PIDFILE")"
    [ -f "$NODEPID" ] && kill -0 "$(cat "$NODEPID")" 2>/dev/null \
      && echo "бот работает,   PID $(cat "$NODEPID")" \
      || echo "бот сейчас перезапускается"
  else
    echo "не работает"
  fi
  exit 0
fi

if alive; then
  echo "уже работает, PID $(cat "$PIDFILE") — вторая копия не нужна"
  exit 0
fi

echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE" "$NODEPID"' EXIT INT TERM

termux-wake-lock 2>/dev/null

while true; do
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt "$MAXLOG" ]; then
    tail -c 400000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  fi
  # PID бота храним отдельно: так stop убивает его без pkill,
  # которого в голом Termux может не оказаться.
  node "$DIR/start.js" >> "$LOG" 2>&1 &
  echo $! > "$NODEPID"
  wait $!
  rm -f "$NODEPID"
  echo "--- бот остановился, поднимаю через 10 секунд ---" >> "$LOG"
  sleep 10
done
