const DEFAULT_SOURCE_URL =
  "https://data.ny.gov/api/views/d6yy-54nr/rows.json?accessType=DOWNLOAD";

const KV_DRAWS_KEY = "powerball:draws:v1";
const KV_META_KEY = "powerball:meta:v1";

function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

function normalizeString(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

function findColumnIndex(columns, candidates) {
  if (!Array.isArray(columns)) return -1;
  const candidateSet = new Set(candidates.map((c) => normalizeString(c)));

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i] ?? {};
    const keysToCheck = [col.fieldName, col.name, col.displayName];
    for (const key of keysToCheck) {
      const normalized = normalizeString(key);
      if (candidateSet.has(normalized)) return i;
    }
  }

  // Fuzzy fallback: contains match
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i] ?? {};
    const haystack = `${normalizeString(col.fieldName)} ${normalizeString(
      col.name
    )} ${normalizeString(col.displayName)}`;
    for (const candidate of candidateSet) {
      if (candidate && haystack.includes(candidate)) return i;
    }
  }

  return -1;
}

function getBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function parseWinningNumbers(winningNumbers) {
  const parts = String(winningNumbers ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const nums = parts
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n));

  if (nums.length < 6) return null;

  const main = nums.slice(0, 5);
  const powerball = nums[5];

  return { main, powerball };
}

function toIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

function normalizeSocrataRowsJson(payload) {
  const columns = payload?.meta?.view?.columns ?? payload?.meta?.columns ?? [];
  const data = payload?.data ?? [];

  const idxDrawDate = findColumnIndex(columns, ["draw date", "draw_date"]);
  const idxWinning = findColumnIndex(columns, [
    "winning numbers",
    "winning_numbers",
  ]);
  const idxMultiplier = findColumnIndex(columns, ["multiplier"]);

  if (idxWinning === -1) return [];

  const draws = [];

  for (const row of data) {
    if (!Array.isArray(row)) continue;

    const parsed = parseWinningNumbers(row[idxWinning]);
    if (!parsed) continue;

    draws.push({
      drawDate: idxDrawDate === -1 ? null : row[idxDrawDate],
      main: parsed.main,
      powerball: parsed.powerball,
      multiplier: idxMultiplier === -1 ? null : toIntOrNull(row[idxMultiplier]),
    });
  }

  draws.sort((a, b) => {
    const ad = a.drawDate ? new Date(a.drawDate).getTime() : 0;
    const bd = b.drawDate ? new Date(b.drawDate).getTime() : 0;
    return bd - ad;
  });

  return draws;
}

async function syncLatestDraws(env) {
  const sourceUrl = env.POWERBALL_SOURCE_URL || DEFAULT_SOURCE_URL;

  const existingMeta = (await env.POWERBALL_KV.get(KV_META_KEY, "json")) ?? {};
  const etag = existingMeta?.etag ?? null;

  const res = await fetch(sourceUrl, {
    headers: etag ? { "If-None-Match": etag } : {},
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (res.status === 304) {
    await env.POWERBALL_KV.put(
      KV_META_KEY,
      JSON.stringify({ ...existingMeta, lastCheckedAt: new Date().toISOString() })
    );
    return { updated: false };
  }

  if (!res.ok) {
    throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
  }

  const payload = await res.json();
  const draws = normalizeSocrataRowsJson(payload);

  const newEtag = res.headers.get("ETag");
  const now = new Date().toISOString();

  await env.POWERBALL_KV.put(KV_DRAWS_KEY, JSON.stringify({ draws, updatedAt: now }));
  await env.POWERBALL_KV.put(
    KV_META_KEY,
    JSON.stringify({
      etag: newEtag,
      updatedAt: now,
      lastCheckedAt: now,
      sourceUrl,
      drawCount: draws.length,
    })
  );

  return { updated: true, drawCount: draws.length };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/powerball/sync") {
      if (request.method !== "POST") {
        return jsonResponse(
          { error: "Use POST /api/powerball/sync" },
          { status: 405 }
        );
      }

      const configuredToken = env.POWERBALL_SYNC_TOKEN;
      if (!configuredToken) {
        return jsonResponse(
          {
            error:
              "Sync token not configured. Set POWERBALL_SYNC_TOKEN as a Worker secret.",
          },
          { status: 500 }
        );
      }

      const providedToken =
        getBearerToken(request) ||
        request.headers.get("x-sync-token") ||
        url.searchParams.get("token");

      if (!providedToken || providedToken !== configuredToken) {
        return jsonResponse({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        const result = await syncLatestDraws(env);
        return jsonResponse({ ok: true, ...result });
      } catch (e) {
        return jsonResponse(
          { ok: false, error: e?.message || "Sync failed" },
          { status: 502 }
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/api/powerball/draws") {
      const stored = await env.POWERBALL_KV.get(KV_DRAWS_KEY, "json");
      if (!stored) {
        return jsonResponse(
          { draws: [], updatedAt: null, source: "kv", missing: true },
          { status: 404 }
        );
      }

      return jsonResponse(stored, {
        headers: {
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(syncLatestDraws(env));
  },
};


