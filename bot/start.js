// Пусковой файл. Разбирается сам, нужен ли флаг --experimental-sqlite:
// в Node 22 без него node:sqlite недоступен, в свежих версиях флага может
// уже не быть. Поэтому не гадаем, а проверяем.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error(
    `\nНужен Node.js 22.5 или новее, у тебя ${process.versions.node}.\n` +
    `Обнови с nodejs.org (кнопка LTS), в Termux: pkg upgrade nodejs\n`
  );
  process.exit(1);
}

// Node предупреждает, что node:sqlite экспериментальный. Мы это знаем —
// глушим, чтобы предупреждение не выглядело как поломка.
const emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === "warning" && data?.name === "ExperimentalWarning" &&
      /SQLite/i.test(data.message ?? "")) return false;
  return emit.call(this, name, data, ...rest);
};

const entry = fileURLToPath(new URL("index.js", import.meta.url));

let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

if (hasSqlite) {
  await import("./index.js");
} else {
  const child = spawn(
    process.execPath,
    ["--experimental-sqlite", "--disable-warning=ExperimentalWarning", entry],
    { stdio: "inherit" }
  );
  child.on("exit", (code, sig) => process.exit(sig ? 1 : code ?? 0));
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
}
