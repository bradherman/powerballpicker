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

async function fetchLatestDrawFromPowerballCom(env) {
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

    // Debug: log HTML snippet if in test mode
    if (env.DEBUG_PARSING) {
      console.log("HTML length:", html.length);
      // Log a snippet around "winning" or "numbers"
      const winningIndex = html.toLowerCase().indexOf("winning");
      if (winningIndex >= 0) {
        console.log(
          "HTML snippet around 'winning':",
          html.slice(Math.max(0, winningIndex - 200), winningIndex + 500)
        );
      }
    }

    let winningNumbers = null;
    let drawDate = null;
    let multiplier = null;

    // Method 1: Parse from HTML structure (most reliable for powerball.com)
    // Structure: "Winning Numbers" -> date in title-date -> white-balls divs -> powerball div -> multiplier

    // Find the "Winning Numbers" section
    const winningIndex = html.toLowerCase().indexOf("winning numbers");
    if (winningIndex >= 0) {
      const section = html.slice(winningIndex, winningIndex + 3000);

      // Extract date from title-date class
      const dateMatch = section.match(/title-date[^>]*>([^<]+)</i);
      if (dateMatch) {
        const dateStr = dateMatch[1].trim();
        // Try parsing the date - powerball.com uses format like "Mon, Dec 22, 2025"
        const parsed = new Date(dateStr);
        if (Number.isFinite(parsed.getTime())) {
          drawDate = parsed.toISOString();
        } else {
          // Fallback: try to parse manually if standard Date parsing fails
          // Format: "Mon, Dec 22, 2025" or "Monday, December 22, 2025"
          const monthMap = {
            jan: 0,
            feb: 1,
            mar: 2,
            apr: 3,
            may: 4,
            jun: 5,
            jul: 6,
            aug: 7,
            sep: 8,
            oct: 9,
            nov: 10,
            dec: 11,
          };
          const parts = dateStr.match(/(\w+),\s+(\w+)\s+(\d+),\s+(\d+)/i);
          if (parts) {
            const monthName = parts[2].toLowerCase().substring(0, 3);
            const month = monthMap[monthName];
            if (month !== undefined) {
              const day = Number.parseInt(parts[3], 10);
              const year = Number.parseInt(parts[4], 10);
              const parsedDate = new Date(year, month, day);
              if (Number.isFinite(parsedDate.getTime())) {
                drawDate = parsedDate.toISOString();
              }
            }
          }
        }
      }

      // Extract white balls (look for "white-balls" class followed by a number)
      const whiteBallMatches = [
        ...section.matchAll(/white-balls[^>]*>(\d{1,2})</gi),
      ];
      const whiteBalls = [];
      for (const match of whiteBallMatches) {
        const num = Number.parseInt(match[1], 10);
        if (
          Number.isFinite(num) &&
          num >= 1 &&
          num <= 69 &&
          !whiteBalls.includes(num)
        ) {
          whiteBalls.push(num);
        }
        if (whiteBalls.length >= 5) break;
      }

      // Extract powerball - it's in a div with class containing "powerball" but NOT "white-balls"
      // The structure shows: <div class="form-control col powerball item-powerball">7</div>
      // We need to find the powerball div that comes after the white-balls divs
      const lastWhiteBallIndex = section.lastIndexOf("white-balls");
      if (lastWhiteBallIndex >= 0) {
        // Look for powerball div after the last white ball
        const afterWhiteBalls = section.substring(lastWhiteBallIndex);
        // Find div with "powerball" class (but not "white-balls")
        const powerballDivMatch = afterWhiteBalls.match(
          /<div[^>]*class="[^"]*\bpowerball\b[^"]*"[^>]*>(\d{1,2})</i
        );
        if (powerballDivMatch) {
          const pb = Number.parseInt(powerballDivMatch[1], 10);
          if (
            Number.isFinite(pb) &&
            pb >= 1 &&
            pb <= 26 &&
            whiteBalls.length === 5
          ) {
            winningNumbers = {
              main: whiteBalls,
              powerball: pb,
            };
          }
        }
      }

      // Extract multiplier (look for "multiplier" class)
      const multiplierMatch = section.match(/multiplier[^>]*>(\d+)x?</i);
      if (multiplierMatch) {
        const mult = Number.parseInt(multiplierMatch[1], 10);
        if (Number.isFinite(mult) && mult >= 2 && mult <= 10) {
          multiplier = mult;
        }
      }
    }

    // First, try to find in JSON data embedded in script tags (most reliable)
    const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    if (scriptMatches) {
      for (const script of scriptMatches) {
        try {
          // Look for JSON objects that might contain draw data
          // Try to find objects with winning numbers or draw information
          const jsonCandidates = script.match(
            /\{[^{}]*"winningNumbers"[^{}]*\}|\{[^{}]*"numbers"[^{}]*\}|\{[^{}]*"whiteBalls"[^{}]*\}|\{[^{}]*"drawDate"[^{}]*\}/gi
          );

          if (jsonCandidates) {
            for (const candidate of jsonCandidates) {
              try {
                const jsonData = JSON.parse(candidate);

                // Try various field names for numbers
                const nums =
                  jsonData.winningNumbers ||
                  jsonData.numbers ||
                  jsonData.whiteBalls ||
                  jsonData.mainNumbers ||
                  jsonData.white;
                const pb =
                  jsonData.powerball ||
                  jsonData.redBall ||
                  jsonData.powerBall ||
                  jsonData.red;

                if (Array.isArray(nums) && nums.length === 5 && pb != null) {
                  const mainNums = nums
                    .map((n) => Number(n))
                    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 69);
                  const pbNum = Number(pb);

                  if (
                    mainNums.length === 5 &&
                    Number.isFinite(pbNum) &&
                    pbNum >= 1 &&
                    pbNum <= 26
                  ) {
                    winningNumbers = {
                      main: mainNums,
                      powerball: pbNum,
                    };

                    // Also get date and multiplier if available
                    if (
                      jsonData.drawDate ||
                      jsonData.drawingDate ||
                      jsonData.date
                    ) {
                      const dateStr =
                        jsonData.drawDate ||
                        jsonData.drawingDate ||
                        jsonData.date;
                      const parsed = new Date(dateStr);
                      if (Number.isFinite(parsed.getTime())) {
                        drawDate = parsed.toISOString();
                      }
                    }

                    if (jsonData.multiplier || jsonData.powerPlay) {
                      const mult = Number(
                        jsonData.multiplier || jsonData.powerPlay
                      );
                      if (Number.isFinite(mult) && mult >= 2) {
                        multiplier = mult;
                      }
                    }

                    break;
                  }
                }
              } catch {
                // Try to parse larger JSON objects
                try {
                  // Look for larger JSON structures
                  const largerMatch = script.match(/\{[\s\S]{100,10000}\}/);
                  if (largerMatch) {
                    const jsonData = JSON.parse(largerMatch[0]);

                    // Recursively search for winning numbers
                    const findNumbers = (obj) => {
                      if (!obj || typeof obj !== "object") return null;

                      for (const key in obj) {
                        const val = obj[key];
                        if (Array.isArray(val) && val.length === 5) {
                          const nums = val
                            .map((n) => Number(n))
                            .filter(
                              (n) => Number.isFinite(n) && n >= 1 && n <= 69
                            );
                          if (nums.length === 5) {
                            // Look for powerball nearby
                            const pbKey = Object.keys(obj).find(
                              (k) =>
                                k.toLowerCase().includes("power") ||
                                k.toLowerCase().includes("red") ||
                                k.toLowerCase().includes("pb")
                            );
                            const pb = pbKey ? Number(obj[pbKey]) : null;

                            if (
                              pb != null &&
                              Number.isFinite(pb) &&
                              pb >= 1 &&
                              pb <= 26
                            ) {
                              return { main: nums, powerball: pb };
                            }
                          }
                        }
                        if (typeof val === "object") {
                          const found = findNumbers(val);
                          if (found) return found;
                        }
                      }
                      return null;
                    };

                    const found = findNumbers(jsonData);
                    if (found) {
                      winningNumbers = found;

                      // Try to find date
                      const findDate = (obj) => {
                        if (!obj || typeof obj !== "object") return null;
                        for (const key in obj) {
                          const val = obj[key];
                          if (
                            typeof key === "string" &&
                            (key.toLowerCase().includes("date") ||
                              key.toLowerCase().includes("draw"))
                          ) {
                            const parsed = new Date(val);
                            if (Number.isFinite(parsed.getTime())) {
                              return parsed.toISOString();
                            }
                          }
                          if (typeof val === "object") {
                            const found = findDate(val);
                            if (found) return found;
                          }
                        }
                        return null;
                      };

                      drawDate = findDate(jsonData);
                    }
                  }
                } catch {
                  // Continue
                }
              }
            }
          }
        } catch {
          // Continue to next script
        }
      }
    }

    // Fallback: Try to find numbers in HTML text patterns
    if (!winningNumbers) {
      // Look for patterns like "12 34 56 78 90 26" where first 5 are 1-69 and last is 1-26
      const numberPattern =
        /(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})/g;
      let match;
      while ((match = numberPattern.exec(html)) !== null) {
        const nums = match.slice(1, 7).map((n) => Number.parseInt(n, 10));
        const main = nums.slice(0, 5);
        const pb = nums[5];

        if (
          main.every((n) => Number.isFinite(n) && n >= 1 && n <= 69) &&
          Number.isFinite(pb) &&
          pb >= 1 &&
          pb <= 26 &&
          new Set(main).size === 5 // All unique
        ) {
          // Check if this appears near "winning" or "numbers" text
          const contextStart = Math.max(0, match.index - 200);
          const contextEnd = Math.min(
            html.length,
            match.index + match[0].length + 200
          );
          const context = html.slice(contextStart, contextEnd).toLowerCase();

          if (
            context.includes("winning") ||
            context.includes("numbers") ||
            context.includes("draw")
          ) {
            winningNumbers = { main, powerball: pb };
            break;
          }
        }
      }
    }

    // Try to find draw date in HTML text
    if (!drawDate) {
      const datePatterns = [
        /Drawing\s+Date[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
        /Draw\s+Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i,
        /(\d{4}-\d{2}-\d{2})/,
        /([A-Za-z]+\s+\d{1,2},?\s+\d{4})/,
      ];

      for (const pattern of datePatterns) {
        const match = html.match(pattern);
        if (match) {
          const dateStr = match[1];
          const parsed = new Date(dateStr);
          if (Number.isFinite(parsed.getTime())) {
            drawDate = parsed.toISOString();
            break;
          }
        }
      }
    }

    // Try to find Power Play multiplier
    if (!multiplier) {
      const multiplierPatterns = [
        /Power\s+Play[:\s]+(\d+)x?/i,
        /Multiplier[:\s]+(\d+)/i,
        /"multiplier"\s*:\s*(\d+)/i,
      ];

      for (const pattern of multiplierPatterns) {
        const match = html.match(pattern);
        if (match) {
          const mult = Number.parseInt(match[1], 10);
          if (Number.isFinite(mult) && mult >= 2 && mult <= 10) {
            multiplier = mult;
            break;
          }
        }
      }
    }

    if (!winningNumbers) {
      return null;
    }

    return {
      drawDate,
      main: winningNumbers.main,
      powerball: winningNumbers.powerball,
      multiplier,
    };
  } catch (e) {
    console.error("Failed to fetch latest draw from powerball.com:", e);
    return null;
  }
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

  let draws = [];
  let jsonUpdated = false;

  if (res.status === 304) {
    // JSON hasn't changed, but we still need to check powerball.com for newer results
    // Load existing draws from KV
    const stored = await env.POWERBALL_KV.get(KV_DRAWS_KEY, "json");
    if (stored?.draws) {
      draws = stored.draws;
    }
    jsonUpdated = false;
  } else {
    if (!res.ok) {
      throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
    }

    const payload = await res.json();
    draws = normalizeSocrataRowsJson(payload);
    jsonUpdated = true;
  }

  // Always try to fetch the latest draw from powerball.com (even if JSON didn't update)
  const powerballComDraw = await fetchLatestDrawFromPowerballCom(env);

  if (
    powerballComDraw &&
    powerballComDraw.main &&
    powerballComDraw.main.length === 5
  ) {
    const pbComDate = powerballComDraw.drawDate
      ? new Date(powerballComDraw.drawDate).toISOString().split("T")[0]
      : null;

    // Find the latest draw from JSON
    const latestJsonDraw = draws.length > 0 ? draws[0] : null;
    const latestJsonDate = latestJsonDraw?.drawDate
      ? new Date(latestJsonDraw.drawDate).toISOString().split("T")[0]
      : null;

    // Check if powerball.com has a newer draw
    const isNewer =
      !latestJsonDate ||
      (pbComDate && pbComDate > latestJsonDate) ||
      (pbComDate === latestJsonDate &&
        // Compare numbers to see if they're different (in case same date but updated)
        (!latestJsonDraw ||
          JSON.stringify(latestJsonDraw.main?.sort()) !==
            JSON.stringify(powerballComDraw.main.sort()) ||
          latestJsonDraw.powerball !== powerballComDraw.powerball));

    if (isNewer) {
      // Prepend the powerball.com draw to the beginning of the draws array
      draws = [
        {
          drawDate: powerballComDraw.drawDate,
          main: powerballComDraw.main,
          powerball: powerballComDraw.powerball,
          multiplier: powerballComDraw.multiplier,
        },
        ...draws,
      ];
    }
  }

  const newEtag = jsonUpdated ? res.headers.get("ETag") : existingMeta?.etag;
  const now = new Date().toISOString();

  // Track if we actually updated anything
  let wasUpdated = jsonUpdated;

  // Find the latest draw from JSON (before potentially adding powerball.com)
  const latestJsonDrawBefore = draws.length > 0 ? draws[0] : null;
  const latestJsonDateBefore = latestJsonDrawBefore?.drawDate
    ? new Date(latestJsonDrawBefore.drawDate).toISOString().split("T")[0]
    : null;

  // Check if powerball.com has newer data
  if (
    powerballComDraw &&
    powerballComDraw.main &&
    powerballComDraw.main.length === 5
  ) {
    const pbComDate = powerballComDraw.drawDate
      ? new Date(powerballComDraw.drawDate).toISOString().split("T")[0]
      : null;

    // Check if powerball.com has a newer draw
    const isNewer =
      !latestJsonDateBefore ||
      (pbComDate && pbComDate > latestJsonDateBefore) ||
      (pbComDate === latestJsonDateBefore &&
        // Compare numbers to see if they're different (in case same date but updated)
        (!latestJsonDrawBefore ||
          JSON.stringify(latestJsonDrawBefore.main?.sort()) !==
            JSON.stringify(powerballComDraw.main.sort()) ||
          latestJsonDrawBefore.powerball !== powerballComDraw.powerball));

    if (isNewer) {
      // Prepend the powerball.com draw to the beginning of the draws array
      draws = [
        {
          drawDate: powerballComDraw.drawDate,
          main: powerballComDraw.main,
          powerball: powerballComDraw.powerball,
          multiplier: powerballComDraw.multiplier,
        },
        ...draws,
      ];
      wasUpdated = true; // We updated with powerball.com data
    }
  }

  // Find the latest draw (after potentially adding powerball.com draw)
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

  // Only update KV if we actually have changes
  if (wasUpdated || latestDrawDate !== lastDrawDate) {
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
  } else {
    // Still update lastCheckedAt even if nothing changed
    await env.POWERBALL_KV.put(
      KV_META_KEY,
      JSON.stringify({
        ...existingMeta,
        lastCheckedAt: now,
      })
    );
  }

  return {
    updated: wasUpdated,
    drawCount: draws.length,
    winningsChecked: winningsResult !== null,
    winnings: winningsResult,
    powerballComChecked: powerballComDraw !== null,
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

    // Test endpoint to debug powerball.com parsing
    if (
      request.method === "GET" &&
      url.pathname === "/api/powerball/test-parse"
    ) {
      try {
        // Enable debug mode
        const debugEnv = { ...env, DEBUG_PARSING: true };
        const result = await fetchLatestDrawFromPowerballCom(debugEnv);

        // Also fetch the raw HTML for inspection
        let htmlSnippet = null;
        try {
          const res = await fetch("https://www.powerball.com/", {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; PowerballSync/1.0)",
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (res.ok) {
            const html = await res.text();
            // Find relevant sections
            const winningIndex = html.toLowerCase().indexOf("winning");
            if (winningIndex >= 0) {
              htmlSnippet = html.slice(
                Math.max(0, winningIndex - 300),
                Math.min(html.length, winningIndex + 1000)
              );
            }
          }
        } catch {
          // Ignore
        }

        return jsonResponse(
          {
            found: result !== null,
            draw: result,
            timestamp: new Date().toISOString(),
            htmlSnippet: htmlSnippet?.substring(0, 2000), // Limit size
          },
          {
            headers: {
              "Cache-Control": "no-cache",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      } catch (e) {
        return jsonResponse(
          { error: e?.message || "Failed to parse", stack: e?.stack },
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
