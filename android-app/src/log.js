// Журнал для отладки на телефоне: последние сообщения console.* и необработанные ошибки.
// Показывается в «Профиль → Журнал», его можно скопировать и прислать.

const MAX = 400;
const lines = [];

function stringify(a) {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function push(level, args) {
  const t = new Date();
  const time = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
  lines.push(`${time} ${level} ${args.map(stringify).join(" ")}`.slice(0, 2000));
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
}

for (const level of ["log", "info", "warn", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    push(level === "log" || level === "info" ? "·" : level === "warn" ? "!" : "✖", args);
    orig(...args);
  };
}
window.addEventListener("error", (e) => push("✖", [`${e.message} @ ${e.filename}:${e.lineno}`]));
window.addEventListener("unhandledrejection", (e) => push("✖", ["unhandled:", e.reason]));

export const log = {
  text: () => lines.join("\n"),
  count: () => lines.length,
  clear: () => { lines.length = 0; },
  add: (...args) => push("·", args),
};
