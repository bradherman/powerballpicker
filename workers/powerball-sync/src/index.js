const DEFAULT_SOURCE_URL =
  "https://data.ny.gov/api/views/d6yy-54nr/rows.json?accessType=DOWNLOAD";

const KV_DRAWS_KEY = "powerball:draws:v1";
const KV_META_KEY = "powerball:meta:v1";
const KV_JACKPOT_KEY = "powerball:jackpot:v1";
const KV_COUNTER_KEY = "powerball:counter:v1";

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

export function parseJackpotAmount(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  // Prefer the number that follows a "$" if present (avoids picking up digits from classnames like "lh-1").
  const dollarNumberMatch = lower.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  const anyNumberMatch = lower.match(/(\d[\d,]*(?:\.\d+)?)/);
  const numericStr = (dollarNumberMatch?.[1] ?? anyNumberMatch?.[1]) || null;
  if (!numericStr) return null;

  const numeric = parseFloat(numericStr.replace(/,/g, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  let multiplier = 1;
  if (
    /\bbillion\b|\bbil\b/.test(lower) ||
    /(\d|\.)\s*b\b/.test(lower) ||
    /\$\s*[\d,.]+\s*b\b/.test(lower)
  ) {
    multiplier = 1_000_000_000;
  } else if (
    /\bmillion\b/.test(lower) ||
    /(\d|\.)\s*m\b/.test(lower) ||
    /\$\s*[\d,.]+\s*m\b/.test(lower)
  ) {
    multiplier = 1_000_000;
  } else if (
    /\bthousand\b/.test(lower) ||
    /(\d|\.)\s*k\b/.test(lower) ||
    /\$\s*[\d,.]+\s*k\b/.test(lower)
  ) {
    multiplier = 1_000;
  }

  return Math.round(numeric * multiplier);
}

export function extractJackpotAmountFromHtml(html) {
  const text = String(html ?? "");
  if (!text) return null;

  // 1) Prefer the "Estimated Jackpot" section explicitly.
  const estSectionPatterns = [
    /Estimated\s+Jackpot[\s\S]{0,800}?\$\s*[\d,.]+\s*(?:Billion|Million|Thousand)\b/gi,
    /Estimated\s+Jackpot[\s\S]{0,800}?\$\s*[\d,.]+\s*[BMK]\b/gi,
  ];

  const estAmounts = [];
  for (const re of estSectionPatterns) {
    for (const m of text.matchAll(re)) {
      const amount = parseJackpotAmount(m[0]);
      if (Number.isFinite(amount) && amount > 0) estAmounts.push(amount);
    }
  }
  if (estAmounts.length > 0) return Math.max(...estAmounts);

  // 2) Otherwise, parse all "$X Million/Billion/K" amounts on the page and take the largest.
  const all = [];
  const reAll = /\$\s*[\d,.]+\s*(?:billion|million|thousand|[BMK])\b/gi;
  for (const m of text.matchAll(reAll)) {
    const amount = parseJackpotAmount(m[0]);
    if (Number.isFinite(amount) && amount > 0) all.push(amount);
  }
  if (all.length > 0) return Math.max(...all);

  // 3) Fallback: full numeric "$1,234,567,890"
  const full = text.match(/\$\s*([\d,]{9,})/);
  if (full?.[1]) {
    const n = Number.parseInt(full[1].replace(/,/g, ""), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return null;
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
      JSON.stringify({
        ...existingMeta,
        lastCheckedAt: new Date().toISOString(),
      })
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

  await env.POWERBALL_KV.put(
    KV_DRAWS_KEY,
    JSON.stringify({ draws, updatedAt: now })
  );
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

async function fetchJackpot(env) {
  // Try to fetch from powerball.com
  try {
    const res = await fetch("https://www.powerball.com/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PowerballSync/1.0)",
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch powerball.com: ${res.status}`);
    }

    const html = await res.text();

    const amountFromHtml = extractJackpotAmountFromHtml(html);
    if (Number.isFinite(amountFromHtml) && amountFromHtml > 0) {
      const now = new Date().toISOString();
      await env.POWERBALL_KV.put(
        KV_JACKPOT_KEY,
        JSON.stringify({
          amount: amountFromHtml,
          updatedAt: now,
          source: "powerball.com",
        })
      );
      return { amount: amountFromHtml, updatedAt: now };
    }

    // Try to find JSON data in script tags
    const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    if (scriptMatches) {
      for (const script of scriptMatches) {
        try {
          // Look for JSON objects with jackpot data
          const jsonMatch = script.match(/\{[\s\S]*"jackpot"[\s\S]*\}/i);
          if (jsonMatch) {
            const jsonData = JSON.parse(jsonMatch[0]);
            const jackpotValue =
              jsonData.jackpot ||
              jsonData.jackpotAmount ||
              jsonData.currentJackpot;

            if (jackpotValue) {
              const amount = parseJackpotAmount(jackpotValue);
              if (Number.isFinite(amount) && amount > 0) {
                const now = new Date().toISOString();
                await env.POWERBALL_KV.put(
                  KV_JACKPOT_KEY,
                  JSON.stringify({
                    amount,
                    updatedAt: now,
                    source: "powerball.com",
                  })
                );
                return { amount, updatedAt: now };
              }
            }
          }
        } catch {
          // Continue to next script
        }
      }
    }

    throw new Error("Could not parse jackpot from powerball.com");
  } catch (e) {
    // If fetching fails, return cached value if available
    const cached = await env.POWERBALL_KV.get(KV_JACKPOT_KEY, "json");
    if (cached) {
      return cached;
    }
    throw e;
  }
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
        // Also try to fetch jackpot (non-blocking)
        fetchJackpot(env).catch(() => {
          // Silently fail - jackpot fetch is optional
        });
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
      const jackpot = await env.POWERBALL_KV.get(KV_JACKPOT_KEY, "json");

      if (!stored) {
        return jsonResponse(
          { draws: [], updatedAt: null, jackpot, source: "kv", missing: true },
          { status: 404 }
        );
      }

      return jsonResponse(
        { ...stored, jackpot },
        {
          headers: {
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    if (request.method === "GET" && url.pathname === "/api/powerball/jackpot") {
      // Try to fetch fresh jackpot if it's been more than 5 minutes since last update
      const cached = await env.POWERBALL_KV.get(KV_JACKPOT_KEY, "json");
      const forceRefresh =
        url.searchParams.get("refresh") === "1" ||
        url.searchParams.get("refresh") === "true";
      const shouldRefresh =
        forceRefresh ||
        !cached ||
        !cached.updatedAt ||
        Date.now() - new Date(cached.updatedAt).getTime() > 300000; // 5 min

      if (shouldRefresh) {
        try {
          const fresh = await fetchJackpot(env);
          return jsonResponse(fresh, {
            headers: {
              "Cache-Control": "public, max-age=300",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } catch (e) {
          // Return cached if available, even if stale
          if (cached) {
            return jsonResponse(cached, {
              headers: {
                "Cache-Control": "public, max-age=60",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }
          return jsonResponse(
            { error: "Jackpot data unavailable" },
            { status: 503 }
          );
        }
      }

      return jsonResponse(cached, {
        headers: {
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/powerball/counter/increment"
    ) {
      try {
        const current = await env.POWERBALL_KV.get(KV_COUNTER_KEY, "json");
        const currentCount = current?.count ?? 0;
        const newCount = currentCount + 1;

        await env.POWERBALL_KV.put(
          KV_COUNTER_KEY,
          JSON.stringify({
            count: newCount,
            updatedAt: new Date().toISOString(),
          })
        );

        return jsonResponse(
          { count: newCount, updatedAt: new Date().toISOString() },
          {
            headers: {
              "Cache-Control": "no-cache",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      } catch (e) {
        return jsonResponse(
          { error: e?.message || "Failed to increment counter" },
          { status: 500 }
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/api/powerball/counter") {
      try {
        const stored = await env.POWERBALL_KV.get(KV_COUNTER_KEY, "json");
        const count = stored?.count ?? 0;

        return jsonResponse(
          { count, updatedAt: stored?.updatedAt ?? null },
          {
            headers: {
              "Cache-Control": "public, max-age=60",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      } catch (e) {
        return jsonResponse(
          { error: e?.message || "Failed to get counter" },
          { status: 500 }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      Promise.all([
        syncLatestDraws(env),
        fetchJackpot(env).catch(() => {
          // Silently fail - jackpot fetch is optional
        }),
      ])
    );
  },
};
