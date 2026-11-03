// Agent <-> Adobe Express bridge add-on relay (v1)
// Local-only HTTPS server on your machine. The add-on panel (iframe) polls
// for commands and posts results; your agent enqueues commands via curl.
// Zero dependencies. State is in-memory; renditions are written to ./shots.
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8322;
const TOKEN = fs.readFileSync(path.join(dir, "token.txt"), "utf8").trim();
const shotsDir = path.join(dir, "shots");
fs.mkdirSync(shotsDir, { recursive: true });

const cert = fs.readFileSync(path.join(dir, "cert.pem"));
const key = fs.readFileSync(path.join(dir, "key.pem"));

const pending = []; // commands waiting for the add-on
const results = new Map(); // id -> result object

function auth(req) {
  return req.headers["x-bridge-token"] === TOKEN;
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, x-bridge-token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
  });
}

const server = https.createServer({ cert, key }, async (req, res) => {
  const url = new URL(req.url, "https://localhost");
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (url.pathname === "/health") return send(res, 200, { ok: true, pending: pending.length });
  if (!auth(req)) return send(res, 401, { error: "bad token" });

  if (req.method === "POST" && url.pathname === "/enqueue") {
    const cmd = await readBody(req);
    if (!cmd.id || !cmd.type) return send(res, 400, { error: "id and type required" });
    pending.push(cmd);
    return send(res, 200, { queued: cmd.id, depth: pending.length });
  }
  if (req.method === "GET" && url.pathname === "/poll") {
    const cmd = pending.shift() || null;
    return send(res, 200, { cmd });
  }
  if (req.method === "POST" && url.pathname === "/result") {
    const r = await readBody(req);
    if (r.pngBase64) {
      fs.writeFileSync(path.join(shotsDir, `${r.id}.png`), Buffer.from(r.pngBase64, "base64"));
      delete r.pngBase64;
      r.pngSaved = true;
    }
    results.set(r.id, { ...r, at: Date.now() });
    return send(res, 200, { stored: r.id });
  }
  if (req.method === "GET" && url.pathname.startsWith("/result/")) {
    const id = url.pathname.slice("/result/".length);
    return send(res, 200, results.get(id) || { pending: true });
  }
  return send(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`express-bridge relay on https://127.0.0.1:${PORT}`);
});
