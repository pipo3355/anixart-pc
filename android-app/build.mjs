// Сборка веб-части приложения: src/ → www/app.js (один файл) + hls.js рядом.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const stub = (name) => path.join(root, "src", "stubs", name);

mkdirSync(path.join(root, "www", "vendor"), { recursive: true });
copyFileSync(
  path.join(root, "node_modules", "hls.js", "dist", "hls.min.js"),
  path.join(root, "www", "vendor", "hls.min.js"),
);

await build({
  entryPoints: [path.join(root, "src", "main.js")],
  outfile: path.join(root, "www", "app.js"),
  bundle: true,
  format: "iife",
  target: ["chrome89"],
  minify: false,
  sourcemap: false,
  legalComments: "none",
  // AnixartJS написан для Node: подменяем то немногое, чего нет в WebView
  alias: {
    "form-data": stub("form-data.js"),
    "node:crypto": stub("crypto.js"),
  },
  define: {
    __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version),
  },
  logLevel: "info",
});
