// Без зависимостей. Нужен Node.js 18+.  Запуск: node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");

// --- мини-загрузчик .env (понимает и ".env", и "env" без точки) ---
const envFile = [".env", "env"].map((f) => path.join(__dirname, f)).find((f) => fs.existsSync(f));
if (envFile) {
  fs.readFileSync(envFile, "utf8").split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)?\s*$/);
    if (m && !line.trim().startsWith("#") && !(m[1] in process.env)) process.env[m[1]] = (m[2] || "").trim();
  });
} else {
  console.warn("Файл .env не найден рядом с server.js");
}

// Папка с сайтом: public/ если она есть, иначе та же папка, где лежит server.js
const PUBLIC = fs.existsSync(path.join(__dirname, "public", "index.html")) ? path.join(__dirname, "public") : __dirname;
const PRIVATE = new Set(["env", ".env", "env.example", ".env.example", "server.js", "package.json", "package-lock.json", "gitignore", ".gitignore", "readme.md"]);

const {
  GEMINI_API_KEY, GEMINI_MODEL = "gemini-3.5-flash", GEMINI_THINKING = "low",
  FISH_API_KEY, FISH_VOICE_NAME = "edit", FISH_VOICE_ID = "", FISH_MODEL = "s2-pro",
  PORT = 3000,
} = process.env;

if (!GEMINI_API_KEY) console.warn("⚠ GEMINI_API_KEY пуст");
if (!FISH_API_KEY) console.warn("⚠ FISH_API_KEY пуст");

const SYSTEM_PROMPT = [
  "Ты голосовой ассистент. Твой ответ будет озвучен вслух.",
  "Отвечай очень коротко и точно: обычно одно–два предложения, без вступлений и воды.",
  "Максимально старайся дать правильный и полезный ответ: сначала главное, потом (только если нужно) одна важная деталь. Если не уверен — честно скажи об этом, ничего не выдумывай.",
  "Характер: дружелюбный и чуть-чуть прикольный — лёгкая ирония или короткая шутка к месту, но не в каждом ответе и никогда в ущерб точности.",
  "Отвечай на том языке, на котором говорит пользователь.",
  "Никакого markdown, списков, эмодзи и спецсимволов — только живая разговорная речь.",
].join(" ");

let voiceId = FISH_VOICE_ID;
async function resolveVoice() {
  if (voiceId) return voiceId;
  const url = `https://api.fish.audio/model?self=true&page_size=50&title=${encodeURIComponent(FISH_VOICE_NAME)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${FISH_API_KEY}` } });
  if (!r.ok) throw new Error(`Fish Audio: не удалось получить список голосов (${r.status})`);
  const { items = [] } = await r.json();
  const hit = items.find((i) => i.title?.toLowerCase() === FISH_VOICE_NAME.toLowerCase()) || items[0];
  if (!hit) throw new Error(`Голос «${FISH_VOICE_NAME}» не найден. Укажи FISH_VOICE_ID в .env`);
  voiceId = hit._id;
  console.log(`Голос: ${hit.title} (${voiceId})`);
  return voiceId;
}

const readJson = (req) =>
  new Promise((res, rej) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch (e) { rej(e); } });
  });

const send = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

async function handleChat(req, res) {
  const { text = "", previousId = null } = await readJson(req);
  const body = {
    model: GEMINI_MODEL,
    input: String(text).slice(0, 4000),
    system_instruction: SYSTEM_PROMPT,
    generation_config: { thinking_level: GEMINI_THINKING },
  };
  if (previousId) body.previous_interaction_id = previousId;

  const call = (b) => fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify(b),
  });
  let r = await call(body);
  let data = await r.json().catch(() => ({}));
  // если старый диалог недоступен — начинаем новый
  if (!r.ok && previousId) { delete body.previous_interaction_id; r = await call(body); data = await r.json().catch(() => ({})); }
  if (!r.ok) {
    const msg = data.error?.message || `HTTP ${r.status}`;
    console.error(`[Gemini ${r.status}] модель=${GEMINI_MODEL}:`, JSON.stringify(data.error || data).slice(0, 500));
    return send(res, 502, { error: `Gemini ${r.status}: ${msg}` });
  }
  const reply = (data.steps || [])
    .filter((st) => st.type === "model_output")
    .flatMap((st) => st.content || [])
    .map((c) => c.text || "")
    .join(" ").trim();
  send(res, 200, { reply: reply || "Не расслышал, повтори, пожалуйста.", id: data.id || null });
}

async function handleTts(req, res) {
  const { text = "" } = await readJson(req);
  const clean = String(text).replace(/[*_`#>~]/g, "").slice(0, 1200);
  const id = await resolveVoice();
  const r = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: { Authorization: `Bearer ${FISH_API_KEY}`, "Content-Type": "application/json", model: FISH_MODEL },
    body: JSON.stringify({ text: clean, reference_id: id, format: "mp3", latency: "balanced", normalize: true }),
  });
  if (!r.ok) {
    const t = (await r.text()).slice(0, 300);
    console.error(`[Fish Audio ${r.status}] голос=${id} модель=${FISH_MODEL}:`, t);
    return send(res, 502, { error: `Fish Audio ${r.status}: ${t}` });
  }
  res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
  res.end(Buffer.from(await r.arrayBuffer()));
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/chat") return await handleChat(req, res);
    if (req.method === "POST" && req.url === "/api/tts") return await handleTts(req, res);
    const file = req.url.split("?")[0] === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
    const full = path.join(PUBLIC, path.normalize(file));
    const rel = path.relative(PUBLIC, full);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).some((p) => PRIVATE.has(p.toLowerCase()) || p === "node_modules")) {
      return send(res, 404, { error: "not found" });
    }
    fs.readFile(full, (err, buf) => {
      if (err) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
      res.end(buf);
    });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`Открой http://localhost:${PORT}`));
