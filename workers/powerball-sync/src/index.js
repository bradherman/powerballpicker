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
  const lastDrawDate = existingMeta?.lastDrawDate ?? null;

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

  // Find the latest draw
  const latestDraw = draws.length > 0 ? draws[0] : null;
  const latestDrawDate = latestDraw?.drawDate
    ? new Date(latestDraw.drawDate).toISOString().split("T")[0]
    : null;

  // Check for winning picks if we have a new draw
  let winningsResult = null;
  if (
    latestDraw &&
    latestDrawDate &&
    latestDrawDate !== lastDrawDate &&
    env.powerball_picks
  ) {
    try {
      winningsResult = await checkWinningPicks(env, latestDraw);
    } catch (e) {
      console.error("Failed to check winning picks:", e);
    }
  }

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
      lastDrawDate: latestDrawDate,
    })
  );

  return {
    updated: true,
    drawCount: draws.length,
    winningsChecked: winningsResult !== null,
    winnings: winningsResult,
  };
}

function computePrize(whiteMatches, pbMatch, powerPlayMultiplier) {
  // Hard-coded from https://www.powerball.com/powerball-prize-chart
  // Power Play does not multiply the Jackpot. Match-5 (no PB) is always $2M with PP (regardless of multiplier).
  const baseTable = {
    "5-1": "JACKPOT",
    "5-0": 1000000,
    "4-1": 50000,
    "4-0": 100,
    "3-1": 100,
    "3-0": 7,
    "2-1": 7,
    "1-1": 4,
    "0-1": 4,
  };

  const key = `${whiteMatches}-${pbMatch ? 1 : 0}`;
  const base = baseTable[key] ?? 0;

  if (powerPlayMultiplier == null) {
    return { base, withPowerPlay: null };
  }

  const m = Number(powerPlayMultiplier);
  const validM = Number.isFinite(m) && m >= 2 ? m : null;
  if (!validM) return { base, withPowerPlay: null };

  if (base === "JACKPOT") return { base, withPowerPlay: "JACKPOT" };
  if (base === 0) return { base: 0, withPowerPlay: 0 };
  if (key === "5-0") return { base, withPowerPlay: 2000000 };
  return { base, withPowerPlay: base * validM };
}

async function savePicks(env, picks) {
  if (!Array.isArray(picks) || picks.length === 0) {
    return { saved: 0 };
  }

  const now = new Date().toISOString();
  let saved = 0;

  for (const pick of picks) {
    if (
      !pick ||
      !Array.isArray(pick.main) ||
      pick.main.length !== 5 ||
      typeof pick.powerball !== "number"
    ) {
      continue;
    }

    try {
      await env.powerball_picks
        .prepare(
          `INSERT INTO picks (main_numbers, powerball, generated_at) VALUES (?, ?, ?)`
        )
        .bind(JSON.stringify(pick.main), pick.powerball, now)
        .run();
      saved++;
    } catch (e) {
      console.error("Failed to save pick:", e);
    }
  }

  return { saved };
}

async function checkWinningPicks(env, draw) {
  if (
    !draw ||
    !Array.isArray(draw.main) ||
    draw.main.length !== 5 ||
    typeof draw.powerball !== "number"
  ) {
    return { checked: 0, winners: 0, totalWinnings: 0, maxSingleWin: 0 };
  }

  const winningSet = new Set(draw.main);
  const drawDate = draw.drawDate
    ? new Date(draw.drawDate).toISOString().split("T")[0]
    : null;
  const powerPlayMultiplier = draw.multiplier || null;

  // Get all unchecked picks
  const uncheckedPicks = await env.powerball_picks
    .prepare(
      `SELECT id, main_numbers, powerball FROM picks WHERE checked = 0 ORDER BY generated_at ASC`
    )
    .all();

  let checked = 0;
  let winners = 0;
  let totalWinnings = 0; // in cents
  let maxSingleWin = 0; // in cents

  for (const row of uncheckedPicks.results || []) {
    const pick = {
      id: row.id,
      main: JSON.parse(row.main_numbers),
      powerball: row.powerball,
    };

    if (!Array.isArray(pick.main) || pick.main.length !== 5) {
      continue;
    }

    const whiteMatches = pick.main.reduce(
      (acc, n) => acc + (winningSet.has(n) ? 1 : 0),
      0
    );
    const pbMatch = pick.powerball === draw.powerball;
    const prize = computePrize(whiteMatches, pbMatch, powerPlayMultiplier);

    const basePrize = prize.base === "JACKPOT" ? 0 : Number(prize.base) || 0;
    const ppPrize =
      prize.withPowerPlay === "JACKPOT" ? 0 : Number(prize.withPowerPlay) || 0;
    const maxPrize = Math.max(basePrize, ppPrize);

    // Convert to cents
    const basePrizeCents = basePrize * 100;
    const ppPrizeCents = ppPrize * 100;
    const maxPrizeCents = maxPrize * 100;

    // Update the pick record
    await env.powerball_picks
      .prepare(
        `UPDATE picks SET
        checked = 1,
        draw_date = ?,
        white_matches = ?,
        powerball_match = ?,
        prize_base = ?,
        prize_with_pp = ?,
        power_play_multiplier = ?
      WHERE id = ?`
      )
      .bind(
        drawDate,
        whiteMatches,
        pbMatch ? 1 : 0,
        basePrizeCents,
        ppPrizeCents,
        powerPlayMultiplier,
        pick.id
      )
      .run();

    checked++;

    if (maxPrizeCents > 0) {
      winners++;
      totalWinnings += maxPrizeCents;
      if (maxPrizeCents > maxSingleWin) {
        maxSingleWin = maxPrizeCents;
      }
    }
  }

  // Update or insert winnings summary
  if (checked > 0 && drawDate) {
    await env.powerball_picks
      .prepare(
        `INSERT INTO winnings_summary (draw_date, total_picks_checked, winning_picks, total_winnings_cents, max_single_win_cents, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(draw_date) DO UPDATE SET
         total_picks_checked = ?,
         winning_picks = ?,
         total_winnings_cents = ?,
         max_single_win_cents = ?,
         updated_at = ?`
      )
      .bind(
        drawDate,
        checked,
        winners,
        totalWinnings,
        maxSingleWin,
        new Date().toISOString(),
        checked,
        winners,
        totalWinnings,
        maxSingleWin,
        new Date().toISOString()
      )
      .run();
  }

  return { checked, winners, totalWinnings, maxSingleWin };
}

async function getTotalWinnings(env) {
  try {
    const result = await env.powerball_picks
      .prepare(
        `SELECT
        SUM(total_winnings_cents) as total_cents,
        MAX(max_single_win_cents) as max_single_cents,
        SUM(winning_picks) as total_winners,
        SUM(total_picks_checked) as total_checked
      FROM winnings_summary`
      )
      .first();

    return {
      totalWinnings: result?.total_cents ? Number(result.total_cents) : 0,
      maxSingleWin: result?.max_single_cents
        ? Number(result.max_single_cents)
        : 0,
      totalWinners: result?.total_winners ? Number(result.total_winners) : 0,
      totalChecked: result?.total_checked ? Number(result.total_checked) : 0,
    };
  } catch (e) {
    console.error("Failed to get total winnings:", e);
    return {
      totalWinnings: 0,
      maxSingleWin: 0,
      totalWinners: 0,
      totalChecked: 0,
    };
  }
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
        const body = await request.json().catch(() => ({}));
        const incrementBy = Math.max(1, Math.floor(Number(body.count) || 1));

        const current = await env.POWERBALL_KV.get(KV_COUNTER_KEY, "json");
        const currentCount = current?.count ?? 0;
        const newCount = currentCount + incrementBy;

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

    if (request.method === "POST" && url.pathname === "/api/powerball/picks") {
      try {
        const body = await request.json().catch(() => ({}));
        const picks = Array.isArray(body.picks) ? body.picks : [];

        if (!env.powerball_picks) {
          return jsonResponse(
            { error: "Database not available" },
            { status: 503 }
          );
        }

        const result = await savePicks(env, picks);

        return jsonResponse(
          { saved: result.saved },
          {
            headers: {
              "Cache-Control": "no-cache",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      } catch (e) {
        return jsonResponse(
          { error: e?.message || "Failed to save picks" },
          { status: 500 }
        );
      }
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/powerball/winnings"
    ) {
      try {
        if (!env.powerball_picks) {
          return jsonResponse(
            {
              totalWinnings: 0,
              maxSingleWin: 0,
              totalWinners: 0,
              totalChecked: 0,
            },
            {
              headers: {
                "Cache-Control": "public, max-age=300",
                "Access-Control-Allow-Origin": "*",
              },
            }
          );
        }

        const winnings = await getTotalWinnings(env);

        return jsonResponse(winnings, {
          headers: {
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        return jsonResponse(
          { error: e?.message || "Failed to get winnings" },
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
