// Minimal static file server for dist/ — SPA fallback, long-cache on hashed assets.
const http = require("http"), fs = require("fs"), p = require("path");
const ROOT = p.join(__dirname, "dist");
const PORT = Number(process.env.PORT || 8788);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json" };

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let file = p.normalize(p.join(ROOT, url));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = p.join(ROOT, "index.html");
  const ext = p.extname(file);
  const hashed = /\/a\//.test(file);
  res.writeHead(200, {
    "content-type": TYPES[ext] || "application/octet-stream",
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log("dist/ served on http://127.0.0.1:" + PORT));
