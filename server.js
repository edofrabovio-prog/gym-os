
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.LYFTA_API_KEY || "";
const BASE = "https://my.lyfta.app/api/v1";
const DATA_FILE = "./gym-data.json";

let data = {
  workouts: [],
  collections: [],
  templates: [],
  lastSync: null
};

if (fs.existsSync(DATA_FILE)) {
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
  } catch (e) {
    console.error("Errore lettura dati:", e.message);
  }
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function json(res, value, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(value));
}

async function lyfta(endpoint) {
  const response = await fetch(BASE + endpoint, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Lyfta HTTP ${response.status}`);
  }

  return response.json();
}

function extractArray(payload, keys) {
  if (Array.isArray(payload)) return payload;

  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
  }

  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function getPages(endpoint, keys) {
  const all = [];

  for (let page = 1; page <= 30; page++) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const payload = await lyfta(
      `${endpoint}${separator}page=${page}&limit=100`
    );

    const items = extractArray(payload, keys);
    all.push(...items);

    const totalPages =
      payload?.total_pages ??
      payload?.pagination?.total_pages ??
      payload?.meta?.last_page;

    if (totalPages && page >= Number(totalPages)) break;
    if (!totalPages && items.length < 100) break;
    if (!items.length) break;
  }

  return all;
}

async function sync() {
  if (!API_KEY) throw new Error("LYFTA_API_KEY non configurata");

  const workouts = await getPages("/workouts", ["workouts"]);

  const byId = new Map();

  for (const workout of [...data.workouts, ...workouts]) {
    const id = workout.id ?? workout.workout_id;
    if (id != null) byId.set(String(id), workout);
  }

  data.workouts = [...byId.values()];

  // Gli endpoint di pianificazione sono opzionali.
  try {
    data.collections = await getPages("/collections", ["collections"]);
  } catch (e) {
    console.warn("Programmi non disponibili:", e.message);
  }

  try {
    data.templates = await getPages("/templates", ["templates"]);
  } catch (e) {
    console.warn("Template non disponibili:", e.message);
  }

  data.lastSync = new Date().toISOString();
  save();

  return {
    imported: workouts.length,
    total: data.workouts.length,
    lastSync: data.lastSync
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/api/status") {
      return json(res, {
        connected: Boolean(API_KEY),
        lastSync: data.lastSync,
        count: data.workouts.length
      });
    }

    if (url.pathname === "/api/data") {
      return json(res, data);
    }

    if (url.pathname === "/api/sync" && req.method === "POST") {
      return json(res, await sync());
    }

    if (url.pathname === "/api/export") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="gym-os-backup.json"'
      });
      return res.end(JSON.stringify(data, null, 2));
    }

    const file = path.resolve("public/index.html");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(file));

} catch (e) {
  console.error("Errore server:", e);

  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }

  json(res, { error: e.message }, 500);
}

});

server.listen(PORT, () => {
  console.log(`GYM OS 1.2 attiva sulla porta ${PORT}`);
});

// Sincronizzazione giornaliera mentre il server è attivo.
setInterval(() => {
  if (API_KEY) sync().catch(console.error);
}, 24 * 60 * 60 * 1000);
