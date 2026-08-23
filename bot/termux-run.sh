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
LOCKDIR="$STORAGE/supervisor.lock"
BOTLOCK="$STORAGE/bot.lock"
LOG="$STORAGE/bot.log"
MAXLOG=2000000          # 2 МБ, дальше обрезаем

mkdir -p "$STORAGE"

# Проверяем не только «жив ли номер», но и что это ИМЕННО наш сторож.
# После перезагрузки номера процессов начинают выдаваться заново, и в
# старом pid-файле может оказаться номер чужого живого процесса — тогда
# сторож решал, что бот уже работает, и молча не запускался.
alive() {
  [ -f "$PIDFILE" ] || return 1
  pid="$(cat "$PIDFILE" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)"
  case "$cmd" in *termux-run.sh*) return 0 ;; *) rm -f "$PIDFILE"; return 1 ;; esac
}

nodeAlive() {
  [ -f "$NODEPID" ] || return 1
  npid="$(cat "$NODEPID" 2>/dev/null)"
  [ -n "$npid" ] || return 1
  kill -0 "$npid" 2>/dev/null || return 1
  ncmd="$(tr '\0' ' ' < "/proc/$npid/cmdline" 2>/dev/null)"
  case "$ncmd" in *start.js*|*index.js*) return 0 ;; *) return 1 ;; esac
}

# Ищем забытые копии бота напрямую в /proc — без ps и pkill,
# которых в урезанной сборке может не оказаться.
# Проверяем не текст целиком, а что процесс ЯВЛЯЕТСЯ node: иначе
# в улов попадают оболочки, где эти слова просто упомянуты.
strays() {
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    [ "$pid" = "$$" ] && continue
    # Процесс мог умереть между перечислением и чтением — это норма,
    # а не ошибка, поэтому просто пропускаем.
    [ -r "$d/cmdline" ] || continue
    cmd="$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)" || continue
    [ -z "$cmd" ] && continue
    exe="${cmd%% *}"
    case "$exe" in
      node|*/node) ;;
      *) continue ;;
    esac
    case "$cmd" in
      *start.js*|*index.js*) echo "$pid" ;;
    esac
  done
}

# Забытые сторожа: их «stop» не берёт, потому что в pid-файле записан
# только один. Из-за этого после restart оставался второй сторож,
# который бесконечно поднимал бота, а тот сразу выходил по замку.
# Не свой ли это предок. Оболочка, из которой запущен restart, содержит
# имя скрипта в командной строке — без этой проверки скрипт убивал
# терминал, из которого его позвали, вместе со всей цепочкой запуска.
isAncestor() {
  p=$$
  while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ]; do
    [ "$p" = "$1" ] && return 0
    p=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null)
  done
  return 1
}

straySupervisors() {
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    isAncestor "$pid" && continue
    [ -r "$d/cmdline" ] || continue
    cmd="$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)"
    case "$cmd" in
      *termux-run.sh*) echo "$pid" ;;
    esac
  done
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
  rmdir "$LOCKDIR" 2>/dev/null
  rm -f "$BOTLOCK"
  [ "$STOPPED" = 1 ] && echo "остановлен" || echo "не был запущен"
  exit 0
fi

if [ "$1" = "doctor" ]; then
  echo "═══ проверка бота ═══"
  echo
  printf "версия файлов:  "; git -C "$DIR" log -1 --format="%h от %cd" --date=format:"%d.%m %H:%M" 2>/dev/null || echo "не определить"
  printf "Node.js:        "; node -v 2>/dev/null || echo "НЕ УСТАНОВЛЕН"
  printf "папка бота:     "; [ -f "$DIR/index.js" ] && echo "на месте" || echo "НЕТ ФАЙЛОВ"
  printf "токен .env:     "; [ -s "$DIR/.env" ] && echo "есть" || echo "НЕТ — бот не запустится"
  printf "стратегий:      "; ls "$DIR/strategies"/*.js 2>/dev/null | grep -vc index.js
  printf "состояние:      "; sh "$0" status
  echo
  printf "интернет:       "
  if node -e "fetch('https://api.mexc.com/api/v3/ping').then(r=>{console.log(r.ok?'MEXC отвечает':'MEXC ошибка '+r.status)}).catch(e=>console.log('НЕТ СВЯЗИ: '+e.message))" 2>/dev/null; then :; else echo "проверить не удалось"; fi
  echo
  echo "последние строки лога:"
  tail -n 8 "$LOG" 2>/dev/null | sed 's/^/    /' || echo "    лога ещё нет"
  echo
  echo "если бот не работает — выполни:  sh $0 restart"
  exit 0
fi

if [ "$1" = "restart" ]; then
  echo "1/4 останавливаю сторожа…"
  sh "$0" stop >/dev/null 2>&1

  echo "2/4 ищу забытые копии…"
  FOUND=0
  for pid in $(straySupervisors); do
    kill "$pid" 2>/dev/null && FOUND=$((FOUND+1))
  done
  for pid in $(strays); do
    kill "$pid" 2>/dev/null && FOUND=$((FOUND+1))
  done
  sleep 2
  for pid in $(straySupervisors); do kill -9 "$pid" 2>/dev/null; done
  for pid in $(strays); do kill -9 "$pid" 2>/dev/null; done
  [ "$FOUND" -gt 0 ] && echo "    убрано процессов: $FOUND" || echo "    забытых копий не было"

  echo "3/4 запускаю заново…"
  rm -f "$PIDFILE" "$NODEPID" "$BOTLOCK"
  rmdir "$LOCKDIR" 2>/dev/null
  (nohup sh "$0" >/dev/null 2>&1 &)
  sleep 6

  echo "4/4 проверяю:"
  sh "$0" status | sed 's/^/    /'
  echo
  echo "последние строки лога:"
  tail -n 5 "$LOG" 2>/dev/null | sed 's/^/    /'
  echo
  if grep -q "ещё один экземпляр" "$LOG" 2>/dev/null; then
    echo "ВНИМАНИЕ: в логе есть следы конфликта двух копий."
    echo "Если он в самом конце — повтори restart ещё раз."
  fi
  exit 0
fi

if [ "$1" = "status" ]; then
  if alive; then
    echo "сторож работает, PID $(cat "$PIDFILE")"
    nodeAlive && echo "бот работает,   PID $(cat "$NODEPID")" \
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

# Атомарная защёлка. mkdir либо создаёт каталог, либо падает — третьего
# не дано, поэтому два одновременных запуска не проскочат оба, как это
# бывает с проверкой «файл существует» и последующей записью.
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  if alive; then
    echo "уже работает, PID $(cat "$PIDFILE") — вторая копия не нужна"
    exit 0
  fi
  rmdir "$LOCKDIR" 2>/dev/null
  mkdir "$LOCKDIR" 2>/dev/null || { echo "не удалось занять защёлку, выхожу"; exit 0; }
fi

echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE" "$NODEPID"; rmdir "$LOCKDIR" 2>/dev/null' EXIT INT TERM

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
