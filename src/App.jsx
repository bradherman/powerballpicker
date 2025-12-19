import React, { useEffect, useMemo, useRef, useState } from "react";
import { Tooltip } from "react-tooltip";
import "react-tooltip/dist/react-tooltip.css";

const PowerballGenerator = () => {
  const rawData = useMemo(
    () =>
      import.meta.env.DEV
        ? [
            ["11 21 27 36 62 24", "3"],
            ["14 18 36 49 67 18", "2"],
            ["18 31 36 43 47 20", "2"],
            ["06 24 30 53 56 19", "2"],
            ["05 18 23 40 50 18", "3"],
            ["21 37 52 53 58 05", "2"],
            ["06 10 31 37 44 23", "2"],
          ]
        : [],
    []
  );

  const clampInt = (value, min, max) => {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) return min;
    return Math.max(min, Math.min(max, n));
  };

  const toggleInSet = (arr, value) => {
    return arr.includes(value)
      ? arr.filter((n) => n !== value)
      : [...arr, value];
  };

  const fallbackDraws = useMemo(() => {
    return rawData
      .map(([winningNumbers, multiplier]) => {
        const nums = String(winningNumbers ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((n) => Number.parseInt(n, 10))
          .filter((n) => Number.isFinite(n));

        if (nums.length < 6) return null;

        return {
          drawDate: null,
          main: nums.slice(0, 5),
          powerball: nums[5],
          multiplier:
            multiplier === null || multiplier === undefined || multiplier === ""
              ? null
              : clampInt(multiplier, 0, 100),
        };
      })
      .filter(Boolean);
  }, [rawData]);

  const [draws, setDraws] = useState(() => fallbackDraws);
  const [drawsUpdatedAt, setDrawsUpdatedAt] = useState(null);
  const [jackpot, setJackpot] = useState(null);
  const [combinationsGenerated, setCombinationsGenerated] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/powerball/draws", {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return;

        const payload = await res.json();
        const nextDraws = payload?.draws;
        if (!Array.isArray(nextDraws) || nextDraws.length === 0) return;

        if (cancelled) return;
        setDraws(nextDraws);
        setDrawsUpdatedAt(payload?.updatedAt ?? null);
      } catch {
        // fall back to embedded data
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Also fetch jackpot separately in case it wasn't in the draws response
  useEffect(() => {
    const refreshJackpot =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("refreshJackpot") === "1";

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(
          refreshJackpot
            ? "/api/powerball/jackpot?refresh=1"
            : "/api/powerball/jackpot",
          {
            headers: { Accept: "application/json" },
          }
        );
        if (!res.ok || cancelled) return;

        const payload = await res.json();
        if (payload?.amount && !cancelled) {
          setJackpot(payload);
        }
      } catch {
        // Silently fail
      }
    })();

    // Make the refresh param one-shot (prevents reloading / repeated refreshes when sharing the link).
    if (refreshJackpot && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("refreshJackpot");
      window.history.replaceState({}, "", url.toString());
    }

    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch combinations counter and count initial picks
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/powerball/counter", {
          headers: { Accept: "application/json" },
        });
        if (!res.ok || cancelled) return;

        const payload = await res.json();
        if (payload?.count != null && !cancelled) {
          setCombinationsGenerated(payload.count);
        }
      } catch {
        // Silently fail
      }

      // Count the initial 5 picks generated on page load (only once)
      if (!initialPicksCountedRef.current && !cancelled) {
        initialPicksCountedRef.current = true;
        try {
          const incrementRes = await fetch("/api/powerball/counter/increment", {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ count: 5 }),
          });
          if (incrementRes.ok && !cancelled) {
            const incrementPayload = await incrementRes.json();
            if (incrementPayload?.count != null) {
              setCombinationsGenerated(incrementPayload.count);
            }
          }
        } catch {
          // Silently fail - counter is not critical
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const analysis = useMemo(() => {
    const mainFreq = {};
    const pbFreq = {};

    draws.forEach((draw) => {
      draw.main.forEach((n) => {
        mainFreq[n] = (mainFreq[n] || 0) + 1;
      });

      const pb = draw.powerball;
      if (Number.isFinite(pb)) {
        pbFreq[pb] = (pbFreq[pb] || 0) + 1;
      }
    });

    return { mainFreq, pbFreq };
  }, [draws]);

  const clampNumber = (value, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  };

  const mainBaseWeights = useMemo(() => {
    const weights = new Map();
    for (let n = 1; n <= 69; n++) {
      weights.set(n, (analysis.mainFreq[n] || 0) + 1); // +1 smoothing so nothing is impossible
    }
    return weights;
  }, [analysis]);

  const pbBaseWeights = useMemo(() => {
    const weights = new Map();
    for (let n = 1; n <= 26; n++) {
      weights.set(n, (analysis.pbFreq[n] || 0) + 1); // +1 smoothing
    }
    return weights;
  }, [analysis]);

  const pickOneBlended = (availableNums, baseWeights, alpha) => {
    // alpha: 0 -> fully weighted; 1 -> fully uniform
    const a = clampNumber(alpha, 0, 1);
    const uniformP = 1 / availableNums.length;

    let sumW = 0;
    for (const n of availableNums) sumW += baseWeights.get(n) || 0;
    if (sumW <= 0) sumW = availableNums.length;

    let r = Math.random();
    let cumulative = 0;

    for (const n of availableNums) {
      const w = baseWeights.get(n) || 1;
      const weightedP = w / sumW;
      const p = (1 - a) * weightedP + a * uniformP;
      cumulative += p;

      if (r <= cumulative) return n;
    }

    return availableNums[availableNums.length - 1];
  };

  const generatePicks = (
    count,
    randomnessPct,
    lockedMainNums,
    pbLockedNums
  ) => {
    const safeCount = clampInt(count, 1, 50);
    const alpha = clampNumber(randomnessPct, 0, 100) / 100;
    const picks = [];

    const lockedMain = (lockedMainNums || []).slice(0, 5);
    const powerballCandidates = pbLockedNums || [];

    for (let i = 0; i < safeCount; i++) {
      // If the user provided PB-eligible locked numbers (1..26), pick the PB
      // from that set (so it can vary across lines).
      const lockedPowerballCandidate =
        powerballCandidates.length > 0
          ? pickOneBlended(powerballCandidates, pbBaseWeights, alpha)
          : null;

      const availableMain = [];
      for (let n = 1; n <= 69; n++) availableMain.push(n);

      const main = [];
      for (const forced of lockedMain) {
        if (!main.includes(forced)) {
          main.push(forced);
          const idx = availableMain.indexOf(forced);
          if (idx !== -1) availableMain.splice(idx, 1);
        }
      }

      while (main.length < 5) {
        const selected = pickOneBlended(availableMain, mainBaseWeights, alpha);
        main.push(selected);
        availableMain.splice(availableMain.indexOf(selected), 1);
      }

      const availablePb = [];
      for (let n = 1; n <= 26; n++) availablePb.push(n);
      const powerball =
        lockedPowerballCandidate ??
        pickOneBlended(availablePb, pbBaseWeights, alpha);

      picks.push({
        main: main.sort((a, b) => a - b),
        powerball,
      });
    }

    return picks;
  };

  const [numLines, setNumLines] = useState(5);
  const [randomness, setRandomness] = useState(70);
  const [mainLocked, setMainLocked] = useState([]);
  const [powerballLocked, setPowerballLocked] = useState([]);
  const [showMainLockedPicker, setShowMainLockedPicker] = useState(false);
  const [showPowerballLockedPicker, setShowPowerballLockedPicker] =
    useState(false);
  const [mainLockedUiError, setMainLockedUiError] = useState(null);

  const lockedError = useMemo(() => {
    if (mainLocked.length > 5)
      return "Main locked can include at most 5 numbers (since there are only 5 main balls).";
    return null;
  }, [mainLocked]);

  const mainBallNumbers = useMemo(
    () => Array.from({ length: 69 }, (_, i) => i + 1),
    []
  );
  const powerballNumbers = useMemo(
    () => Array.from({ length: 26 }, (_, i) => i + 1),
    []
  );

  const [picks, setPicks] = useState(() => generatePicks(5, 70, [], []));
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState(null);
  const [copied, setCopied] = useState(null);
  const [justGenerated, setJustGenerated] = useState(false);
  const [animatingBalls, setAnimatingBalls] = useState(new Set());
  const [displayPicks, setDisplayPicks] = useState(() => generatePicks(5, 70, [], []));
  const [showStats, setShowStats] = useState(true);
  const [showChecker, setShowChecker] = useState(false);
  const [showPrizeTable, setShowPrizeTable] = useState(false);
  const checkerRef = useRef(null);
  const initialPicksCountedRef = useRef(false);
  const [checkerInput, setCheckerInput] = useState("");
  const [checkerResults, setCheckerResults] = useState([]);

  // Sync displayPicks with picks when not animating
  useEffect(() => {
    if (animatingBalls.size === 0 && picks.length > 0) {
      setDisplayPicks(picks);
    }
  }, [animatingBalls.size, picks]);

  const latestDraw = useMemo(() => {
    if (!Array.isArray(draws) || draws.length === 0) return null;

    const candidates = draws
      .map((d) => {
        const main = Array.isArray(d?.main) ? d.main : [];
        const powerball = d?.powerball;
        const hasValidNums =
          main.length === 5 &&
          main.every((n) => Number.isFinite(n)) &&
          Number.isFinite(powerball);

        if (!hasValidNums) return null;

        const rawDate = d?.drawDate;
        const ms =
          rawDate instanceof Date
            ? rawDate.getTime()
            : typeof rawDate === "string" || typeof rawDate === "number"
            ? Date.parse(String(rawDate))
            : Number.NaN;

        return { ...d, _drawDateMs: Number.isFinite(ms) ? ms : null };
      })
      .filter(Boolean);

    if (candidates.length === 0) return null;

    const anyHasDate = candidates.some((d) => d._drawDateMs != null);
    if (!anyHasDate) return candidates[0];

    return candidates.reduce((best, cur) => {
      if (best?._drawDateMs == null) return cur;
      if (cur?._drawDateMs == null) return best;
      return cur._drawDateMs > best._drawDateMs ? cur : best;
    }, candidates[0]);
  }, [draws]);

  const latestDrawMainSet = useMemo(
    () => new Set(latestDraw?.main ?? []),
    [latestDraw]
  );

  const formatDrawDateLabel = (draw) => {
    const ms = draw?._drawDateMs;
    if (ms == null) return null;
    const dt = new Date(ms);
    if (!Number.isFinite(dt.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(dt);
  };

  const formatLatestResultInline = (draw) => {
    if (!draw) return null;
    const main = draw.main.map((n) => String(n).padStart(2, "0")).join(" ");
    const pb = String(draw.powerball).padStart(2, "0");
    const mult =
      Number.isFinite(draw.multiplier) && draw.multiplier > 0
        ? ` (x${draw.multiplier})`
        : "";
    const date = formatDrawDateLabel(draw);
    const datePart = date ? ` • ${date}` : "";
    return `${main} + ${pb}${mult}${datePart}`;
  };

  const getEtParts = (date) => {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const parts = Object.fromEntries(
      dtf.formatToParts(date).map((p) => [p.type, p.value])
    );

    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      weekdayShort: parts.weekday,
      hour: Number(parts.hour),
      minute: Number(parts.minute),
    };
  };

  const addDaysUtc = (date, days) =>
    new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

  const weekdayIndex = (short) => {
    switch (short) {
      case "Sun":
        return 0;
      case "Mon":
        return 1;
      case "Tue":
        return 2;
      case "Wed":
        return 3;
      case "Thu":
        return 4;
      case "Fri":
        return 5;
      case "Sat":
        return 6;
      default:
        return null;
    }
  };

  const zonedTimeToUtc = (timeZone, y, m, d, hh, mm) => {
    // Convert a wall-clock time in a named time zone to a UTC Date without extra deps.
    // We do this by starting with a UTC guess, seeing what wall time it maps to in
    // the zone, and adjusting a couple times.
    let guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));

    for (let i = 0; i < 3; i++) {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      const p = Object.fromEntries(
        fmt.formatToParts(guess).map((x) => [x.type, x.value])
      );
      const gotY = Number(p.year);
      const gotM = Number(p.month);
      const gotD = Number(p.day);
      const gotH = Number(p.hour);
      const gotMin = Number(p.minute);

      const desired = Date.UTC(y, m - 1, d, hh, mm, 0);
      const got = Date.UTC(gotY, gotM - 1, gotD, gotH, gotMin, 0);
      const diffMs = desired - got;

      if (diffMs === 0) break;
      guess = new Date(guess.getTime() + diffMs);
    }

    return guess;
  };

  const computeNextPowerballDraw = (now) => {
    // Official draw schedule: Mon / Wed / Sat at 10:59 PM ET.
    const DRAW_DOW = new Set([1, 3, 6]); // Mon, Wed, Sat
    const DRAW_HOUR = 22;
    const DRAW_MIN = 59;

    const etNow = getEtParts(now);
    const etDow = weekdayIndex(etNow.weekdayShort);

    // Build a "date anchor" representing today's ET Y/M/D at noon UTC, then add days.
    const etDateAnchorUtc = new Date(
      Date.UTC(etNow.year, etNow.month - 1, etNow.day, 12, 0, 0)
    );

    const isDrawDay = etDow != null && DRAW_DOW.has(etDow);
    const isBeforeDrawTime =
      etNow.hour < DRAW_HOUR ||
      (etNow.hour === DRAW_HOUR && etNow.minute < DRAW_MIN);

    let daysAhead = 0;
    if (!(isDrawDay && isBeforeDrawTime)) {
      for (let i = 1; i <= 7; i++) {
        const candidateUtc = addDaysUtc(etDateAnchorUtc, i);
        const candidateEt = getEtParts(candidateUtc);
        const dow = weekdayIndex(candidateEt.weekdayShort);
        if (dow != null && DRAW_DOW.has(dow)) {
          daysAhead = i;
          break;
        }
      }
    }

    const targetEtDate = getEtParts(addDaysUtc(etDateAnchorUtc, daysAhead));
    const drawUtc = zonedTimeToUtc(
      "America/New_York",
      targetEtDate.year,
      targetEtDate.month,
      targetEtDate.day,
      DRAW_HOUR,
      DRAW_MIN
    );

    return {
      utc: drawUtc,
      etLabel: new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(drawUtc),
      localLabel: new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(drawUtc),
    };
  };

  const [nextPowerballDraw, setNextPowerballDraw] = useState(() =>
    computeNextPowerballDraw(new Date())
  );
  const [nextDrawCountdownMs, setNextDrawCountdownMs] = useState(() =>
    Math.max(0, nextPowerballDraw.utc.getTime() - Date.now())
  );

  const formatCountdown = (ms) => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");

    return days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
  };

  const formatJackpot = (amount) => {
    if (!amount || typeof amount !== "number") return null;

    if (amount >= 1000000000) {
      // Billions
      const billions = (amount / 1000000000).toFixed(2);
      return `$${billions}B`;
    } else if (amount >= 1000000) {
      // Millions
      const millions = (amount / 1000000).toFixed(1);
      return `$${millions}M`;
    } else if (amount >= 1000) {
      // Thousands
      const thousands = (amount / 1000).toFixed(0);
      return `$${thousands}K`;
    }
    return `$${amount.toLocaleString()}`;
  };

  useEffect(() => {
    const tick = () => {
      const nowMs = Date.now();
      setNextPowerballDraw((prev) => {
        const prevMs = prev?.utc?.getTime?.() ?? 0;
        const next =
          nowMs >= prevMs ? computeNextPowerballDraw(new Date(nowMs)) : prev;
        setNextDrawCountdownMs(Math.max(0, next.utc.getTime() - nowMs));
        return next;
      });
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const formatPickLine = (pick) => {
    const main = pick.main.map((n) => String(n).padStart(2, "0")).join(" ");
    const pb = String(pick.powerball).padStart(2, "0");
    return `${main} ${pb}`;
  };

  const parseUserLine = (line) => {
    const trimmed = String(line ?? "").trim();
    if (!trimmed) return { ok: false, error: "Empty line" };

    // Accept any non-number separators (spaces, commas, hyphens, plus signs, etc).
    const parts = trimmed.match(/\d+/g) ?? [];
    if (parts.length !== 6) {
      return { ok: false, error: "Expected 6 numbers (5 + Powerball)." };
    }

    const nums = parts.map((p) => Number.parseInt(p, 10));
    if (nums.some((n) => !Number.isFinite(n))) {
      return { ok: false, error: "All entries must be numbers." };
    }

    const main = nums.slice(0, 5);
    const pb = nums[5];

    if (main.some((n) => n < 1 || n > 69)) {
      return { ok: false, error: "Main numbers must be 1–69." };
    }
    if (pb < 1 || pb > 26) {
      return { ok: false, error: "Powerball must be 1–26." };
    }

    const uniq = new Set(main);
    if (uniq.size !== main.length) {
      return { ok: false, error: "Main numbers must be unique." };
    }

    return {
      ok: true,
      main: main.slice().sort((a, b) => a - b),
      powerball: pb,
    };
  };

  const formatPrize = (value) => {
    if (value === "JACKPOT") return "Jackpot";
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return "$0";
    if (amount >= 1000000000) return `$${(amount / 1000000000).toFixed(2)}B`;
    if (amount >= 1000000) {
      const decimals = amount % 1000000 === 0 ? 0 : 1;
      return `$${(amount / 1000000).toFixed(decimals)}M`;
    }
    if (amount >= 1000) return `$${amount.toLocaleString()}`;
    return `$${amount}`;
  };

  const calculatePickPrize = (pick) => {
    if (!latestDraw || !pick || !Array.isArray(pick.main) || pick.main.length !== 5) {
      return null;
    }

    const winningSet = new Set(latestDraw.main);
    const whiteMatches = pick.main.reduce(
      (acc, n) => acc + (winningSet.has(n) ? 1 : 0),
      0
    );
    const pbMatch = pick.powerball === latestDraw.powerball;
    const prize = computePrize(whiteMatches, pbMatch, latestDraw.multiplier);

    if (!isWinningPrize(prize.base)) return null;

    return prize;
  };

  const isWinningPrize = (value) => {
    if (value === "JACKPOT") return true;
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0;
  };

  const computePrize = (whiteMatches, pbMatch, powerPlayMultiplier) => {
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
  };

  const handleOpenChecker = () => {
    setShowChecker(true);
    requestAnimationFrame(() => {
      checkerRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  const handleCheckNumbers = () => {
    const lines = String(checkerInput ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (!latestDraw) {
      setCheckerResults([
        {
          raw: "",
          ok: false,
          error: "No recent draw loaded yet — refresh after data loads.",
        },
      ]);
      return;
    }

    const winningSet = new Set(latestDraw.main);
    const pp = latestDraw.multiplier;

    const next = lines.map((raw) => {
      const parsed = parseUserLine(raw);
      if (!parsed.ok) return { raw, ok: false, error: parsed.error };

      const whiteMatches = parsed.main.reduce(
        (acc, n) => acc + (winningSet.has(n) ? 1 : 0),
        0
      );
      const pbMatch = parsed.powerball === latestDraw.powerball;
      const prize = computePrize(whiteMatches, pbMatch, pp);

      return {
        raw,
        ok: true,
        main: parsed.main,
        powerball: parsed.powerball,
        whiteMatches,
        pbMatch,
        prize,
      };
    });

    setCheckerResults(next);
  };

  const POWERBALL_JACKPOT_ODDS_ONE_IN = 292201338; // per powerball.com prize chart

  const getOdds = (whiteMatches, pbMatch) => {
    // Official Powerball odds from powerball.com
    const oddsTable = {
      "5-1": 292201338, // Jackpot
      "5-0": 11688053.52,
      "4-1": 913129.18,
      "4-0": 36525.17,
      "3-1": 14494.11,
      "3-0": 579.76,
      "2-1": 701.33,
      "1-1": 91.98,
      "0-1": 38.32,
    };

    const key = `${whiteMatches}-${pbMatch ? 1 : 0}`;
    return oddsTable[key] ?? null;
  };

  const formatOdds = (odds) => {
    if (!odds) return "—";
    if (odds >= 1000000) {
      return `1/${(odds / 1000000).toFixed(1)}M`;
    } else if (odds >= 1000) {
      return `1/${(odds / 1000).toFixed(1)}K`;
    } else {
      return `1/${odds.toFixed(1)}`;
    }
  };

  const absurdButMoreLikelyFacts = useMemo(
    () => [
      {
        label: "be struck by lightning in your lifetime",
        oneIn: 15300,
        sourceLabel: "Britannica",
        sourceUrl:
          "https://www.britannica.com/question/What-are-the-chances-of-being-struck-by-lightning",
      },
      {
        label: "be killed by an asteroid impact",
        oneIn: 74800000,
        sourceLabel: "TIME",
        sourceUrl:
          "https://time.com/4171474/powerball-lottery-more-likely-win/",
      },
      {
        label: "become a movie star",
        oneIn: 1500000,
        sourceLabel: "TIME",
        sourceUrl:
          "https://time.com/4171474/powerball-lottery-more-likely-win/",
      },
      {
        label: "bowl a perfect game (300)",
        oneIn: 11500,
        sourceLabel: "TIME",
        sourceUrl:
          "https://time.com/4171474/powerball-lottery-more-likely-win/",
      },
      {
        label: "be dealt a royal flush in poker",
        oneIn: 649740,
        sourceLabel: "Wikipedia",
        sourceUrl: "https://en.wikipedia.org/wiki/Royal_flush",
      },
      {
        label: "be attacked by a shark",
        oneIn: 11500000,
        sourceLabel: "UC Berkeley (Aldous)",
        sourceUrl:
          "https://www.stat.berkeley.edu/~aldous/157/Papers/powerball-2.pdf",
      },
      {
        label: "be killed by a vending machine",
        oneIn: 112000000,
        sourceLabel: "UC Berkeley (Aldous)",
        sourceUrl:
          "https://www.stat.berkeley.edu/~aldous/157/Papers/powerball-2.pdf",
      },
      {
        label: "be drafted by an NBA team",
        oneIn: 6800000,
        sourceLabel: "UC Berkeley (Aldous)",
        sourceUrl:
          "https://www.stat.berkeley.edu/~aldous/157/Papers/powerball-2.pdf",
      },
      {
        label: "have an IQ of 190 or greater",
        oneIn: 107000000,
        sourceLabel: "UC Berkeley (Aldous)",
        sourceUrl:
          "https://www.stat.berkeley.edu/~aldous/157/Papers/powerball-2.pdf",
      },
      {
        label: "be struck by lightning while drowning",
        oneIn: 183000000,
        sourceLabel: "UC Berkeley (Aldous)",
        sourceUrl:
          "https://www.stat.berkeley.edu/~aldous/157/Papers/powerball-2.pdf",
      },
      {
        label: "die from chronic constipation",
        oneIn: 2200000,
        sourceLabel: "TIME",
        sourceUrl:
          "https://time.com/4171474/powerball-lottery-more-likely-win/",
      },
    ],
    []
  );

  const absurdFactOfTheDay = useMemo(() => {
    const facts = absurdButMoreLikelyFacts;
    if (!facts.length) return null;
    return facts[Math.floor(Math.random() * facts.length)];
  }, [absurdButMoreLikelyFacts]);

  const copyToClipboard = async (text) => {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    // Fallback for older browsers.
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  };

  const handleCopyLine = async (lineIdx) => {
    const pick = picks[lineIdx];
    if (!pick) return;
    await copyToClipboard(formatPickLine(pick));
    setCopied(`line:${lineIdx}`);
    setTimeout(() => setCopied(null), 1200);
  };

  const handleCopyAll = async () => {
    const text = picks.map(formatPickLine).join("\n");
    await copyToClipboard(text);
    setCopied("all");
    setTimeout(() => setCopied(null), 1200);
  };

  const beginEdit = (lineIdx, kind, indexOrNull) => {
    setEditError(null);
    setEditing({ lineIdx, kind, index: indexOrNull });
    const current =
      kind === "pb"
        ? picks[lineIdx]?.powerball
        : picks[lineIdx]?.main?.[indexOrNull];
    setEditValue(current != null ? String(current) : "");
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditValue("");
    setEditError(null);
  };

  const commitEdit = () => {
    if (!editing) return;
    const { lineIdx, kind, index } = editing;

    const next = Number.parseInt(editValue, 10);
    if (!Number.isFinite(next)) {
      setEditError("Enter a number.");
      return;
    }

    if (kind === "pb") {
      if (next < 1 || next > 26) {
        setEditError("Powerball must be 1–26.");
        return;
      }
      if (powerballLocked.length > 0 && !powerballLocked.includes(next)) {
        setEditError("Powerball must be one of your Powerball locked numbers.");
        return;
      }
    } else {
      if (next < 1 || next > 69) {
        setEditError("Main numbers must be 1–69.");
        return;
      }

      const currentPick = picks[lineIdx];
      if (currentPick) {
        const otherNums = currentPick.main.filter((_, i) => i !== index);
        if (otherNums.includes(next)) {
          setEditError("That number is already in this line.");
          return;
        }

        const nextMain = [...otherNums, next].sort((a, b) => a - b);
        if (mainLocked.length > 0) {
          for (const locked of mainLocked) {
            if (!nextMain.includes(locked)) {
              setEditError(
                "This line must include all your Main locked numbers. Remove it from Main locked first if you want to change it."
              );
              return;
            }
          }
        }
      }
    }

    setPicks((prev) => {
      const copy = prev.map((p) => ({ ...p, main: [...p.main] }));
      const pick = copy[lineIdx];
      if (!pick) return prev;

      if (kind === "pb") {
        pick.powerball = next;
      } else {
        pick.main[index] = next;
        pick.main.sort((a, b) => a - b);
      }
      return copy;
    });

    // Also update displayPicks
    setDisplayPicks((prev) => {
      const copy = prev.map((p) => ({ ...p, main: [...p.main] }));
      const pick = copy[lineIdx];
      if (!pick) return prev;

      if (kind === "pb") {
        pick.powerball = next;
      } else {
        pick.main[index] = next;
        pick.main.sort((a, b) => a - b);
      }
      return copy;
    });

    setEditing(null);
    setEditValue("");
    setEditError(null);
  };

  const toggleMainLocked = (n) => {
    setMainLockedUiError(null);
    setMainLocked((prev) => {
      if (prev.includes(n)) return prev.filter((x) => x !== n);
      if (prev.length >= 5) {
        setMainLockedUiError("Main locked is limited to 5 numbers.");
        return prev;
      }
      return [...prev, n].sort((a, b) => a - b);
    });
  };

  const togglePowerballLocked = (n) => {
    setPowerballLocked((prev) => toggleInSet(prev, n).sort((a, b) => a - b));
  };

  const topMain = Object.entries(analysis.mainFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const topPB = Object.entries(analysis.pbFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="relative isolate">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-24 left-1/2 h-[520px] w-[920px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle_at_center,rgba(239,68,68,0.28),transparent_55%)] blur-2xl" />
          <div className="absolute -top-10 left-[-120px] h-[520px] w-[520px] rounded-full bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.22),transparent_60%)] blur-2xl" />
          <div className="absolute bottom-[-220px] right-[-180px] h-[640px] w-[640px] rounded-full bg-[radial-gradient(circle_at_center,rgba(168,85,247,0.20),transparent_60%)] blur-2xl" />
        </div>

        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
          <header className="mb-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div className="inline-flex items-center gap-2 rounded-full bg-white/5 px-3 py-1 text-xs text-white/80 ring-1 ring-white/10">
                    <span className="font-semibold tracking-wide">
                      POWERBALL STUDIO
                    </span>
                    <span className="h-1 w-1 rounded-full bg-white/40" />
                    <span>Weighted + editable</span>
                  </div>

                  <button
                    type="button"
                    onClick={handleOpenChecker}
                    className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white/90 ring-1 ring-white/10 transition hover:border-white/30 hover:bg-white/10 active:translate-y-px"
                    title="Jump to the Number Checker"
                  >
                    Check my numbers
                  </button>
                </div>

                <h1 className="mt-4 text-4xl font-extrabold tracking-tight">
                  Picks that feel handcrafted.
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/70">
                  Tune the generator, lock what you want, then click{" "}
                  <span className="font-semibold text-white">
                    Generate New Picks
                  </span>
                  . Tap any ball to edit. Copy a line or the entire set.
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-white/5 px-3 py-1 ring-1 ring-white/10 text-white/80">
                    Main: 5 of 69
                  </span>
                  <span className="rounded-full bg-white/5 px-3 py-1 ring-1 ring-white/10 text-white/80">
                    Powerball: 1 of 26
                  </span>
                  {drawsUpdatedAt && (
                    <span className="rounded-full bg-white/5 px-3 py-1 ring-1 ring-white/10 text-white/80">
                      Data updated{" "}
                      <span className="font-semibold text-white">
                        {drawsUpdatedAt}
                      </span>
                    </span>
                  )}
                  {latestDraw ? (
                    <span
                      className="rounded-full bg-white/5 px-3 py-1 ring-1 ring-white/10 text-white/80"
                      title={formatLatestResultInline(latestDraw) || undefined}
                    >
                      <span className="font-semibold text-white/80 mr-4">
                        Latest result
                      </span>
                      <span className="inline-flex items-center gap-1.5 align-middle">
                        {latestDraw.main.map((n, i) => (
                          <span
                            key={`${n}-${i}`}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white text-slate-900 font-extrabold text-[10px] ring-1 ring-white/20"
                          >
                            {String(n).padStart(2, "0")}
                          </span>
                        ))}
                        <span className="text-white/40 font-semibold">+</span>
                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-linear-to-b from-red-500 to-red-700 text-white font-extrabold text-[10px] ring-1 ring-red-300/30">
                          {String(latestDraw.powerball).padStart(2, "0")}
                        </span>
                        {Number.isFinite(latestDraw.multiplier) &&
                        latestDraw.multiplier > 0 ? (
                          <span className="ml-0.5 inline-flex items-center rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-white/75">
                            x{latestDraw.multiplier}
                          </span>
                        ) : null}
                        {formatDrawDateLabel(latestDraw) ? (
                          <span className="ml-1 text-[10px] text-white/55">
                            {formatDrawDateLabel(latestDraw)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="sm:w-[360px]">
                <div className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10 backdrop-blur">
                  <div className="text-sm font-semibold text-white/90">
                    Next drawing
                  </div>
                  <div className="mt-2 text-sm text-white/70">
                    <div className="mt-1">
                      <span className="font-semibold text-white">Local:</span>{" "}
                      {nextPowerballDraw.localLabel}
                    </div>
                    <div className="mt-2 text-xs text-white/60">
                      Draws: Mon / Wed / Sat at 10:59 PM ET.
                    </div>
                  </div>
                  {jackpot?.amount ? (
                    <div className="mt-3 rounded-xl border border-amber-400/30 bg-linear-to-br from-amber-500/20 to-orange-500/20 px-3 py-3 backdrop-blur">
                      <div className="text-[11px] font-semibold tracking-wide text-amber-200/80">
                        CURRENT JACKPOT
                      </div>
                      <div className="mt-1 font-mono text-2xl font-extrabold text-amber-100">
                        {formatJackpot(jackpot.amount)}
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-3 rounded-xl border border-white/10 bg-white/5 px-3 py-3">
                    <div className="text-[11px] font-semibold tracking-wide text-white/60">
                      COUNTDOWN
                    </div>
                    <div className="mt-1 font-mono text-2xl font-extrabold text-white">
                      {formatCountdown(nextDrawCountdownMs)}
                    </div>
                  </div>
                  <a
                    className="mt-3 inline-flex w-full items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white/90 transition hover:bg-white/10"
                    href="https://www.powerball.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Official Powerball site
                  </a>
                </div>
              </div>
            </div>
          </header>

          <div className="grid gap-6 lg:grid-cols-12">
            <section className="lg:col-span-4">
              <div className="rounded-2xl bg-white/5 p-5 ring-1 ring-white/10 backdrop-blur">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold tracking-tight">
                    Controls
                  </h2>
                </div>
                <p className="mt-1 text-sm text-white/70">
                  Settings won’t regenerate picks until you click the button.
                </p>

                <button
                  onClick={async () => {
                    if (lockedError) return;
                    setEditing(null);
                    setEditValue("");
                    setEditError(null);
                    setCopied(null);

                    const newPicks = generatePicks(
                      numLines,
                      randomness,
                      mainLocked,
                      powerballLocked
                    );

                    // Start animation: set all balls to white/blank first
                    setAnimatingBalls(new Set());
                    setDisplayPicks(
                      newPicks.map((pick) => ({
                        main: pick.main.map(() => null),
                        powerball: null,
                      }))
                    );

                    // Animate each ball in sequence
                    const animateBall = (pickIdx, ballIdx, isPowerball, finalValue) => {
                      const ballKey = `${pickIdx}-${ballIdx}-${isPowerball ? 'pb' : 'main'}`;
                      setAnimatingBalls((prev) => new Set(prev).add(ballKey));

                      // Spin through numbers
                      const spinDuration = 800 + Math.random() * 400; // 800-1200ms
                      const spinSteps = 15 + Math.floor(Math.random() * 10); // 15-25 steps
                      const stepDuration = spinDuration / spinSteps;
                      let currentStep = 0;

                      const spinInterval = setInterval(() => {
                        currentStep++;
                        const range = isPowerball ? 26 : 69;
                        const randomValue = Math.floor(Math.random() * range) + 1;

                        setDisplayPicks((prev) => {
                          const updated = prev.map((p, pIdx) => {
                            if (pIdx !== pickIdx) return p;
                            const newPick = { ...p };
                            if (isPowerball) {
                              newPick.powerball = randomValue;
                            } else {
                              newPick.main = [...p.main];
                              newPick.main[ballIdx] = randomValue;
                            }
                            return newPick;
                          });
                          return updated;
                        });

                        if (currentStep >= spinSteps) {
                          clearInterval(spinInterval);
                          // Set final value
                          setDisplayPicks((prev) => {
                            const updated = prev.map((p, pIdx) => {
                              if (pIdx !== pickIdx) return p;
                              const newPick = { ...p };
                              if (isPowerball) {
                                newPick.powerball = finalValue;
                              } else {
                                newPick.main = [...p.main];
                                newPick.main[ballIdx] = finalValue;
                              }
                              return newPick;
                            });
                            return updated;
                          });
                          setAnimatingBalls((prev) => {
                            const next = new Set(prev);
                            next.delete(ballKey);
                            return next;
                          });
                        }
                      }, stepDuration);
                    };

                    // Animate all balls in sequence within each row
                    newPicks.forEach((pick, pickIdx) => {
                      // Animate main balls
                      pick.main.forEach((finalValue, ballIdx) => {
                        setTimeout(() => {
                          animateBall(pickIdx, ballIdx, false, finalValue);
                        }, pickIdx * 100 + ballIdx * 150);
                      });

                      // Animate powerball after main balls
                      setTimeout(() => {
                        animateBall(pickIdx, 0, true, pick.powerball);
                      }, pickIdx * 100 + pick.main.length * 150 + 100);
                    });

                    // Set picks immediately so finalPick is available during rendering
                    setPicks(newPicks);

                    // Show success feedback
                    setJustGenerated(true);
                    setTimeout(() => setJustGenerated(false), 2500);

                    // Increment counter
                    try {
                      const res = await fetch("/api/powerball/counter/increment", {
                        method: "POST",
                        headers: {
                          Accept: "application/json",
                          "Content-Type": "application/json",
                        },
                        body: JSON.stringify({ count: numLines }),
                      });
                      if (res.ok) {
                        const payload = await res.json();
                        if (payload?.count != null) {
                          setCombinationsGenerated(payload.count);
                        }
                      }
                    } catch {
                      // Silently fail - counter is not critical
                    }
                  }}
                  className="mt-5 w-full rounded-xl bg-linear-to-r from-red-500 via-red-500 to-orange-400 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-red-500/20 ring-1 ring-white/10 transition hover:brightness-110 active:brightness-95 disabled:opacity-60 relative overflow-hidden"
                >
                  <span className={`inline-flex items-center gap-2 transition-opacity duration-200 ${justGenerated ? 'opacity-0' : 'opacity-100'}`}>
                    Generate New Picks
                  </span>
                  {justGenerated && (
                    <span className="absolute inset-0 flex items-center justify-center gap-2 animate-[fadeInScale_0.3s_ease-out]">
                      <svg
                        className="h-5 w-5 animate-[checkmark_0.4s_ease-out_0.1s_both]"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      <span>Generated!</span>
                    </span>
                  )}
                </button>

                <div className="mt-5 space-y-5">
                  <div>
                    <label
                      htmlFor="numLines"
                      className="block text-sm font-semibold text-white/90"
                    >
                      Number of lines
                    </label>
                    <div className="mt-2 flex items-center gap-3">
                      <input
                        id="numLines"
                        type="number"
                        min={1}
                        max={50}
                        step={1}
                        value={numLines}
                        onChange={(e) =>
                          setNumLines(clampInt(e.target.value, 1, 50))
                        }
                        className="w-28 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-red-400/30"
                      />
                      <span className="text-xs text-white/60">
                        How many lines to generate
                      </span>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-end justify-between gap-3">
                      <label
                        htmlFor="randomness"
                        className="block text-sm font-semibold text-white/90"
                      >
                        Randomness
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          aria-label="Randomness percent"
                          type="number"
                          min={0}
                          max={100}
                          value={randomness}
                          onChange={(e) =>
                            setRandomness(clampInt(e.target.value, 0, 100))
                          }
                          className="w-20 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-red-400/30"
                        />
                        <span className="text-xs text-white/60">%</span>
                      </div>
                    </div>
                    <input
                      id="randomness"
                      type="range"
                      min={0}
                      max={100}
                      value={randomness}
                      onChange={(e) =>
                        setRandomness(clampInt(e.target.value, 0, 100))
                      }
                      className="mt-3 w-full accent-red-400"
                    />
                    <p className="mt-2 text-xs text-white/60">
                      0% leans into historical weighting. 100% is uniform
                      random.
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => setShowMainLockedPicker((prev) => !prev)}
                        className="flex items-center gap-2 text-left"
                      >
                        <span className="text-sm font-semibold text-white/90">
                          Main locked
                        </span>
                        <span className="text-xs text-white/50">
                          ({mainLocked.length}/5)
                        </span>
                        <span className="text-xs text-white/50">
                          {showMainLockedPicker ? "▼" : "▶"}
                        </span>
                      </button>

                      {mainLocked.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setMainLocked([])}
                          className="text-xs font-semibold text-white/70 hover:text-white"
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>

                    {showMainLockedPicker ? (
                      <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3">
                        <div className="max-h-[340px] overflow-auto pr-1">
                          <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))]">
                            {mainBallNumbers.map((n) => {
                              const selected = mainLocked.includes(n);
                              return (
                                <button
                                  key={n}
                                  type="button"
                                  onClick={() => toggleMainLocked(n)}
                                  className={[
                                    "aspect-square w-full rounded-full font-extrabold text-[11px] sm:text-xs transition",
                                    selected
                                      ? "bg-white text-slate-900 ring-4 ring-inset ring-red-400/60"
                                      : "bg-white text-slate-900 ring-1 ring-white/25 hover:brightness-105",
                                  ].join(" ")}
                                  title={
                                    selected ? "Unlocked" : "Lock this number"
                                  }
                                >
                                  {String(n).padStart(2, "0")}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <p className="mt-3 text-xs text-white/60">
                          Click balls to lock/unlock. Main locked numbers must
                          appear in every line.
                        </p>
                      </div>
                    ) : null}

                    {mainLockedUiError ? (
                      <div className="mt-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                        {mainLockedUiError}
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          setShowPowerballLockedPicker((prev) => !prev)
                        }
                        className="flex items-center gap-2 text-left"
                      >
                        <span className="text-sm font-semibold text-white/90">
                          Powerball locked
                        </span>
                        <span className="text-xs text-white/50">
                          ({powerballLocked.length || 0})
                        </span>
                        <span className="text-xs text-white/50">
                          {showPowerballLockedPicker ? "▼" : "▶"}
                        </span>
                      </button>

                      {powerballLocked.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setPowerballLocked([])}
                          className="text-xs font-semibold text-white/70 hover:text-white"
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>

                    {showPowerballLockedPicker ? (
                      <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3">
                        <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))]">
                          {powerballNumbers.map((n) => {
                            const selected = powerballLocked.includes(n);
                            return (
                              <button
                                key={n}
                                type="button"
                                onClick={() => togglePowerballLocked(n)}
                                className={[
                                  "aspect-square w-full rounded-full font-extrabold text-[11px] sm:text-xs transition shadow-sm",
                                  selected
                                    ? "bg-linear-to-b from-red-500 to-red-700 text-white ring-4 ring-inset ring-red-200/80"
                                    : "bg-linear-to-b from-red-500/70 to-red-700/70 text-white ring-1 ring-red-300/30 hover:brightness-110",
                                ].join(" ")}
                                title={
                                  selected ? "Unlocked" : "Lock as candidate"
                                }
                              >
                                {String(n).padStart(2, "0")}
                              </button>
                            );
                          })}
                        </div>
                        <p className="mt-3 text-xs text-white/60">
                          If you select any Powerball locked numbers, the
                          Powerball will be chosen only from those.
                        </p>
                      </div>
                    ) : null}
                  </div>

                  {lockedError ? (
                    <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                      {lockedError}
                    </div>
                  ) : mainLocked.length > 0 || powerballLocked.length > 0 ? (
                    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70">
                      <div>
                        Main locked:{" "}
                        <span className="font-semibold text-white">
                          {mainLocked.length > 0 ? mainLocked.join(", ") : "—"}
                        </span>
                      </div>
                      <div className="mt-1">
                        Powerball locked:{" "}
                        <span className="font-semibold text-white">
                          {powerballLocked.length > 0
                            ? powerballLocked.join(", ")
                            : "—"}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="lg:col-span-8">
              <div className="rounded-2xl bg-white/5 p-5 ring-1 ring-white/10 backdrop-blur">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold tracking-tight">
                      Your picks
                    </h2>
                    <p className="mt-1 text-sm text-white/70">
                      Click any ball to edit. Copy a single line or the full
                      set.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyAll}
                    className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white/90 transition hover:bg-white/10"
                  >
                    Copy all
                    {copied === "all" ? " ✓" : ""}
                  </button>
                </div>

                <div className="mt-5 space-y-4">
                  {displayPicks.map((pick, idx) => {
                    const finalPick = picks[idx];
                    return (
                    <div
                      key={idx}
                      className="rounded-2xl border border-white/10 bg-white/5 p-4 transition hover:bg-white/7"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-2 text-sm font-semibold text-white/90">
                          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/10">
                            {idx + 1}
                          </span>
                          <span>Pick</span>
                          {(() => {
                            const prize = calculatePickPrize(finalPick);
                            if (!prize) return null;
                            const basePrize = formatPrize(prize.base);
                            const ppPrize = prize.withPowerPlay != null ? formatPrize(prize.withPowerPlay) : null;
                            const tooltipId = `prize-tooltip-${idx}`;
                            const tooltipText = ppPrize
                              ? `Had this line been played on the last drawing, you would have won at least ${basePrize} (${ppPrize} with Power Play)`
                              : `Had this line been played on the last drawing, you would have won at least ${basePrize}`;
                            return (
                              <>
                                <span
                                  data-tooltip-id={tooltipId}
                                  className="inline-flex items-center justify-center text-emerald-400 cursor-help"
                                >
                                  $
                                </span>
                                <Tooltip
                                  id={tooltipId}
                                  place="top"
                                  className="bg-slate-800! text-white! border! border-white/20! rounded-lg! px-3! py-2! text-sm! max-w-xs! z-50!"
                                  style={{ backgroundColor: 'rgb(30 41 55)', color: 'white' }}
                                >
                                  {tooltipText}
                                </Tooltip>
                              </>
                            );
                          })()}
                        </div>

                        <div className="flex items-center gap-3 flex-wrap">
                          <div className="flex gap-2">
                            {pick.main.map((num, i) => {
                              const ballKey = `${idx}-${i}-main`;
                              const isAnimating = animatingBalls.has(ballKey);
                              const displayNum = num ?? (finalPick?.main?.[i] ?? null);
                              const isEditing =
                                editing?.lineIdx === idx &&
                                editing?.kind === "main" &&
                                editing?.index === i;

                              if (isEditing) {
                                const editValue = finalPick?.main?.[i] ?? num;
                                return (
                                  <div
                                    key={i}
                                    className={[
                                      "h-12 w-12 rounded-full bg-white flex items-center justify-center shadow-sm",
                                      editValue && mainLocked.includes(editValue)
                                        ? "ring-4 ring-inset ring-amber-400/80"
                                        : "ring-2 ring-red-400/40",
                                    ].join(" ")}
                                  >
                                    <input
                                      autoFocus
                                      type="number"
                                      min={1}
                                      max={69}
                                      inputMode="numeric"
                                      value={editValue}
                                      onChange={(e) =>
                                        setEditValue(e.target.value)
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") commitEdit();
                                        if (e.key === "Escape") cancelEdit();
                                      }}
                                      onBlur={cancelEdit}
                                      className="w-10 bg-transparent text-center text-sm font-extrabold text-slate-900 focus:outline-none"
                                    />
                                  </div>
                                );
                              }

                              const finalValue = finalPick?.main?.[i];
                              const isLocked = finalValue && mainLocked.includes(finalValue);

                              return (
                                <button
                                  key={i}
                                  type="button"
                                  title="Click to edit"
                                  onClick={() => beginEdit(idx, "main", i)}
                                  disabled={isAnimating || displayNum === null}
                                  className={[
                                    "h-12 w-12 rounded-full font-extrabold shadow-sm transition",
                                    displayNum === null
                                      ? "bg-white/20 text-white/40 cursor-not-allowed"
                                      : isAnimating
                                      ? "bg-white text-slate-900 ring-2 ring-red-400/60 animate-pulse"
                                      : "bg-white text-slate-900 hover:brightness-105",
                                    isLocked
                                      ? "ring-4 ring-inset ring-amber-400/80"
                                      : displayNum !== null && "ring-1 ring-white/25",
                                  ].join(" ")}
                                >
                                  {displayNum ? displayNum.toString().padStart(2, "0") : "—"}
                                </button>
                              );
                            })}
                          </div>

                          <span className="text-white/50 font-semibold">+</span>

                          {(() => {
                            const isEditingPb =
                              editing?.lineIdx === idx &&
                              editing?.kind === "pb";
                            if (isEditingPb) {
                              return (
                                <div
                                  className={[
                                    "h-12 w-12 rounded-full bg-linear-to-b from-red-500 to-red-700 flex items-center justify-center shadow-lg shadow-red-500/15",
                                    powerballLocked.length > 0 &&
                                    powerballLocked.includes(pick.powerball)
                                      ? "ring-4 ring-inset ring-amber-200/90"
                                      : "ring-2 ring-red-300/40",
                                  ].join(" ")}
                                >
                                  <input
                                    autoFocus
                                    type="number"
                                    min={1}
                                    max={26}
                                    inputMode="numeric"
                                    value={editValue}
                                    onChange={(e) =>
                                      setEditValue(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") commitEdit();
                                      if (e.key === "Escape") cancelEdit();
                                    }}
                                    onBlur={cancelEdit}
                                    className="w-10 bg-transparent text-center text-sm font-bold text-white focus:outline-none"
                                  />
                                </div>
                              );
                            }

                            const pbBallKey = `${idx}-0-pb`;
                            const isPbAnimating = animatingBalls.has(pbBallKey);
                            const displayPb = pick.powerball ?? (finalPick?.powerball ?? null);
                            const finalPbValue = finalPick?.powerball;
                            const isPbLocked = finalPbValue && powerballLocked.length > 0 && powerballLocked.includes(finalPbValue);

                            return (
                              <button
                                type="button"
                                title="Click to edit"
                                onClick={() => beginEdit(idx, "pb", null)}
                                disabled={isPbAnimating || displayPb === null}
                                className={[
                                  "h-12 w-12 rounded-full font-extrabold shadow-lg transition",
                                  displayPb === null
                                    ? "bg-red-500/20 text-white/40 cursor-not-allowed ring-1 ring-red-300/20"
                                    : isPbAnimating
                                    ? "bg-linear-to-b from-red-500 to-red-700 text-white ring-2 ring-red-400/60 animate-pulse"
                                    : "bg-linear-to-b from-red-500 to-red-700 text-white hover:brightness-110",
                                  isPbLocked
                                    ? "ring-4 ring-inset ring-amber-200/90"
                                    : displayPb !== null && "ring-1 ring-red-300/30",
                                ].join(" ")}
                              >
                                {displayPb ? displayPb.toString().padStart(2, "0") : "—"}
                              </button>
                            );
                          })()}

                          <button
                            type="button"
                            onClick={() => handleCopyLine(idx)}
                            className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white/90 transition hover:bg-white/10"
                            title="Copy this line"
                          >
                            Copy
                            {copied === `line:${idx}` ? " ✓" : ""}
                          </button>
                        </div>
                      </div>

                      {editing?.lineIdx === idx && editError ? (
                        <div className="mt-2 text-sm text-red-200">
                          {editError}
                        </div>
                      ) : null}
                    </div>
                    );
                  })}
                </div>
              </div>
            </section>
          </div>

          <div className="mt-6 rounded-2xl bg-white/5 p-5 ring-1 ring-white/10 backdrop-blur">
            <button
              onClick={() => setShowStats(!showStats)}
              className="w-full text-left font-semibold text-lg text-white flex justify-between items-center"
            >
              <span>📊 Historical Data Statistics</span>
              <span className="text-white/70">{showStats ? "▼" : "▶"}</span>
            </button>

            {showStats && (
              <div className="mt-4 space-y-4">
                <div>
                  <h3 className="font-semibold text-white/90 mb-2">
                    Most Frequent Main Numbers (Top 10):
                  </h3>
                  {topMain.length === 0 ? (
                    <div className="text-sm text-white/70">
                      No draw data loaded yet.
                    </div>
                  ) : (
                    <div className="grid grid-cols-5 gap-2">
                      {topMain.map(([num, count]) => (
                        <div
                          key={num}
                          className="rounded-xl border border-white/10 bg-white/5 p-2 text-center"
                        >
                          <div className="font-extrabold text-white">{num}</div>
                          <div className="text-xs text-white/60">{count}x</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-white/90 mb-2">
                    Most Frequent Powerball Numbers (Top 5):
                  </h3>
                  {topPB.length === 0 ? (
                    <div className="text-sm text-white/70">
                      No draw data loaded yet.
                    </div>
                  ) : (
                    <div className="grid grid-cols-5 gap-2">
                      {topPB.map(([num, count]) => (
                        <div
                          key={num}
                          className="rounded-xl border border-white/10 bg-white/5 p-2 text-center"
                        >
                          <div className="font-extrabold text-white">{num}</div>
                          <div className="text-xs text-white/60">{count}x</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-sm text-white/70">
                    <strong className="text-white">Note:</strong> Powerball is
                    random. Historical frequency does not predict future
                    results. Play responsibly.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="mt-6 rounded-2xl bg-white/5 p-5 ring-1 ring-white/10 backdrop-blur">
            <button
              onClick={() => setShowPrizeTable(!showPrizeTable)}
              className="w-full text-left font-semibold text-lg text-white flex justify-between items-center"
            >
              <span>💰 Prize Table</span>
              <span className="text-white/70">{showPrizeTable ? "▼" : "▶"}</span>
            </button>

            {showPrizeTable && (
              <div className="mt-4 space-y-4">
                <div className="text-sm text-white/70">
                  Prize amounts based on matching white balls and Powerball. Power Play multipliers apply to all prizes except the jackpot. Match 5 (no Powerball) is always $2M with Power Play.
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="px-4 py-3 text-left text-sm font-semibold text-white/90">
                          Match
                        </th>
                        <th className="px-4 py-3 text-center text-sm font-semibold text-white/90">
                          Odds
                        </th>
                        <th className="px-4 py-3 text-center text-sm font-semibold text-white/90">
                          Base Prize
                        </th>
                        <th className="px-4 py-3 text-center text-sm font-semibold text-white/90">
                          Power Play 2x
                        </th>
                        <th className="px-4 py-3 text-center text-sm font-semibold text-white/90">
                          Power Play 3x
                        </th>
                        <th className="px-4 py-3 text-center text-sm font-semibold text-white/90">
                          Power Play 4x
                        </th>
                        <th className="px-4 py-3 text-center text-sm font-semibold text-white/90">
                          Power Play 5x
                        </th>
                        <th className="px-4 py-3 text-center text-sm font-semibold text-white/90">
                          Power Play 10x
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { white: 5, pb: 1 },
                        { white: 5, pb: 0 },
                        { white: 4, pb: 1 },
                        { white: 4, pb: 0 },
                        { white: 3, pb: 1 },
                        { white: 3, pb: 0 },
                        { white: 2, pb: 1 },
                        { white: 1, pb: 1 },
                        { white: 0, pb: 1 },
                      ].map(({ white, pb }) => {
                        const basePrize = computePrize(white, pb === 1, null);
                        const multipliers = [2, 3, 4, 5, 10];
                        const powerPlayPrizes = multipliers.map((mult) =>
                          computePrize(white, pb === 1, mult)
                        );
                        const odds = getOdds(white, pb === 1);

                        return (
                          <tr
                            key={`${white}-${pb}`}
                            className="border-b border-white/5 hover:bg-white/5"
                          >
                            <td className="px-4 py-3 whitespace-nowrap">
                              <div className="flex items-center gap-1">
                                {Array.from({ length: white }, (_, i) => (
                                  <div
                                    key={`white-${i}`}
                                    className="h-5 w-5 rounded-full bg-white text-slate-900 font-extrabold text-[8px] flex items-center justify-center ring-1 ring-white/20 shadow-sm"
                                  />
                                ))}
                                {pb === 1 && (
                                  <div className="h-5 w-5 rounded-full bg-linear-to-b from-red-500 to-red-700 text-white font-extrabold text-[8px] flex items-center justify-center ring-1 ring-red-300/30 shadow-sm" />
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-center text-sm text-white/70 font-mono">
                              {formatOdds(odds)}
                            </td>
                            <td className="px-4 py-3 text-center text-sm text-white/90">
                              {white === 5 && pb === 1 && basePrize.base === "JACKPOT" && jackpot?.amount
                                ? formatJackpot(jackpot.amount)
                                : formatPrize(basePrize.base)}
                            </td>
                            {powerPlayPrizes.map((ppPrize, idx) => (
                              <td
                                key={multipliers[idx]}
                                className="px-4 py-3 text-center text-sm text-white/90"
                              >
                                {white === 5 && pb === 1 && ppPrize.withPowerPlay === "JACKPOT" && jackpot?.amount
                                  ? formatJackpot(jackpot.amount)
                                  : ppPrize.withPowerPlay != null
                                  ? formatPrize(ppPrize.withPowerPlay)
                                  : "—"}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-sm text-white/70">
                    <strong className="text-white">Note:</strong> Prize amounts are approximate and may vary. The jackpot is not multiplied by Power Play. Match 5 (no Powerball) with Power Play is always $2 million regardless of the multiplier drawn. Visit{" "}
                    <a
                      href="https://www.powerball.com/powerball-prize-chart"
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-white underline decoration-white/20 underline-offset-2 hover:decoration-white/40"
                    >
                      powerball.com
                    </a>{" "}
                    for official prize information.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div
            ref={checkerRef}
            className="mt-6 rounded-2xl bg-white/5 p-5 ring-1 ring-white/10 backdrop-blur"
          >
            <button
              onClick={() => setShowChecker((v) => !v)}
              className="w-full text-left font-semibold text-lg text-white flex justify-between items-center"
            >
              <span>✅ Number Checker</span>
              <span className="text-white/70">{showChecker ? "▼" : "▶"}</span>
            </button>

            {showChecker && (
              <div className="mt-4 space-y-4">
                <div className="text-sm text-white/70">
                  Paste one line per play. Supports spaces, hyphens, or commas.
                </div>

                <textarea
                  value={checkerInput}
                  onChange={(e) => setCheckerInput(e.target.value)}
                  rows={5}
                  placeholder={
                    "4 15 67 23 18 10\n4-15-22-11-21-10\n4,15,22,11,21,10"
                  }
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 font-mono text-sm text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-red-400/30"
                />

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleCheckNumbers}
                    className="inline-flex items-center justify-center rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white/90 ring-1 ring-white/10 transition hover:bg-white/15"
                  >
                    Check
                  </button>
                  {latestDraw ? (
                    <div className="text-xs text-white/60">
                      Using latest draw Power Play:{" "}
                      <span className="font-semibold text-white/80">
                        {Number.isFinite(latestDraw.multiplier) &&
                        latestDraw.multiplier > 0
                          ? `x${latestDraw.multiplier}`
                          : "—"}
                      </span>
                    </div>
                  ) : null}
                </div>

                {checkerResults.length > 0 ? (
                  <div className="space-y-3">
                    {checkerResults.map((r, idx) => (
                      <div
                        key={`${idx}-${r.raw}`}
                        className="rounded-2xl border border-white/10 bg-white/5 p-4"
                      >
                        {!r.ok ? (
                          <div className="text-sm text-red-200">
                            {r.raw ? (
                              <div className="font-mono text-white/80">
                                {r.raw}
                              </div>
                            ) : null}
                            <div className="mt-1">{r.error}</div>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="flex items-center gap-1.5">
                                {r.main.map((n, i) => (
                                  <div
                                    key={`${n}-${i}`}
                                    className={[
                                      "h-10 w-10 rounded-full bg-white text-slate-900 font-extrabold text-xs flex items-center justify-center",
                                      latestDrawMainSet.has(n)
                                        ? "ring-4 ring-inset ring-emerald-400/90 shadow-inner"
                                        : "ring-1 ring-white/20",
                                    ].join(" ")}
                                    title="Main ball"
                                  >
                                    {String(n).padStart(2, "0")}
                                  </div>
                                ))}
                              </div>
                              <span className="text-white/40 font-semibold">
                                +
                              </span>
                              <div
                                className={[
                                  "h-10 w-10 rounded-full bg-linear-to-b from-red-500 to-red-700 text-white font-extrabold text-xs flex items-center justify-center",
                                  latestDraw?.powerball === r.powerball
                                    ? "ring-4 ring-inset ring-emerald-200 shadow-inner"
                                    : "ring-1 ring-red-300/30",
                                ].join(" ")}
                                title="Powerball"
                              >
                                {String(r.powerball).padStart(2, "0")}
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2 text-sm">
                              <span
                                className={[
                                  "rounded-full border px-3 py-1",
                                  isWinningPrize(r.prize.base)
                                    ? "border-emerald-400/30 bg-emerald-500/15 text-emerald-100"
                                    : "border-white/10 bg-white/5 text-white/80",
                                ].join(" ")}
                              >
                                No PP:{" "}
                                <span className="font-semibold text-white">
                                  {formatPrize(r.prize.base)}
                                </span>
                              </span>
                              {r.prize.withPowerPlay != null ? (
                                <span
                                  className={[
                                    "rounded-full border px-3 py-1",
                                    isWinningPrize(r.prize.withPowerPlay)
                                      ? "border-emerald-400/30 bg-emerald-500/15 text-emerald-100"
                                      : "border-white/10 bg-white/5 text-white/80",
                                  ].join(" ")}
                                >
                                  With PP{" "}
                                  {Number.isFinite(latestDraw?.multiplier) &&
                                  latestDraw.multiplier > 0
                                    ? `(x${latestDraw.multiplier})`
                                    : ""}
                                  :{" "}
                                  <span className="font-semibold text-white">
                                    {formatPrize(r.prize.withPowerPlay)}
                                  </span>
                                </span>
                              ) : (
                                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/60">
                                  With PP: —
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <footer className="mt-10">
            <div className="rounded-2xl bg-white/5 p-5 ring-1 ring-white/10 backdrop-blur">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-white/80">
                    Vibe coded by Brad Herman
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-white/60">
                    <a
                      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 font-semibold text-white/80 transition hover:bg-white/10"
                      href="https://bherms.com"
                      target="_blank"
                      rel="noreferrer"
                    >
                      bherms.com
                    </a>
                    <a
                      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 font-semibold text-white/80 transition hover:bg-white/10"
                      href="https://github.com/bradherman/powerballpicker"
                      target="_blank"
                      rel="noreferrer"
                      aria-label="GitHub repository"
                      title="GitHub repository"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="h-4 w-4 fill-white/80"
                      >
                        <path d="M12 .5C5.73.5.75 5.73.75 12.2c0 5.2 3.44 9.61 8.2 11.17.6.12.82-.27.82-.58v-2.05c-3.34.75-4.04-1.46-4.04-1.46-.54-1.43-1.32-1.81-1.32-1.81-1.08-.77.08-.76.08-.76 1.2.09 1.83 1.28 1.83 1.28 1.06 1.9 2.78 1.35 3.46 1.03.11-.8.41-1.35.75-1.66-2.67-.32-5.48-1.4-5.48-6.21 0-1.37.46-2.49 1.22-3.37-.12-.32-.53-1.6.12-3.34 0 0 1.01-.34 3.3 1.29a11.1 11.1 0 0 1 3-.42c1.02 0 2.05.15 3 .42 2.28-1.63 3.29-1.29 3.29-1.29.65 1.74.24 3.02.12 3.34.76.88 1.22 2 1.22 3.37 0 4.82-2.82 5.89-5.5 6.2.42.39.8 1.16.8 2.35v3.47c0 .32.22.7.83.58 4.75-1.56 8.18-5.97 8.18-11.17C23.25 5.73 18.27.5 12 .5z" />
                      </svg>
                      Repo
                    </a>
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:items-end">
                  <div className="text-xs font-semibold tracking-wide text-white/60">
                    TIP ME
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white/90 ring-1 ring-white/10 transition hover:border-white/30 hover:bg-white/10"
                      href="https://venmo.com/u/bherms"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Venmo @bherms
                    </a>
                    <a
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white/90 ring-1 ring-white/10 transition hover:border-white/30 hover:bg-white/10"
                      href="https://paypal.me/bherms86?locale.x=en_US&country.x=US"
                    >
                      PayPal
                    </a>
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-col gap-2 border-t border-white/10 pt-4 text-xs text-white/50 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-2">
                  <div>
                    <span className="font-semibold text-white/70">
                      Disclaimer:
                    </span>{" "}
                    This site is for entertainment/informational purposes only
                    and is not affiliated with or endorsed by Powerball or any
                    lottery. This is not financial advice, and we’re not
                    advising you to gamble. The odds are terrible—please play
                    responsibly.
                  </div>

                  {absurdFactOfTheDay ? (
                    <div className="text-white/55">
                      Fun fact: you’re more likely to{" "}
                      <a
                        className="font-semibold text-white/70 underline decoration-white/20 underline-offset-2 hover:decoration-white/40"
                        href={absurdFactOfTheDay.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={`${absurdFactOfTheDay.sourceLabel} source`}
                      >
                        {absurdFactOfTheDay.label}
                      </a>{" "}
                      (about 1 in{" "}
                      <span className="font-semibold text-white/70">
                        {absurdFactOfTheDay.oneIn.toLocaleString()}
                      </span>
                      ) than win the{" "}
                      <a
                        className="underline decoration-white/20 underline-offset-2 hover:decoration-white/40"
                        href="https://www.powerball.com/powerball-prize-chart"
                        target="_blank"
                        rel="noreferrer"
                        title="Powerball prize chart / odds"
                      >
                        Powerball jackpot
                      </a>{" "}
                      (1 in{" "}
                      <span className="font-semibold text-white/70">
                        {POWERBALL_JACKPOT_ODDS_ONE_IN.toLocaleString()}
                      </span>
                      ).
                    </div>
                  ) : null}
                </div>

                <div className="sm:text-right flex flex-col gap-2">
                  <div className="whitespace-nowrap">
                    © {new Date().getFullYear()} Brad Herman.
                  </div>
                  <div className="whitespace-nowrap">All rights reserved.</div>
                </div>
              </div>

              {combinationsGenerated > 0 && (
                <div className="mt-6 border-t border-white/10 pt-6">
                  <div className="mx-auto max-w-md rounded-2xl border border-red-400/30 bg-gradient-to-br from-red-500/20 to-orange-500/20 px-6 py-4 text-center backdrop-blur ring-1 ring-red-400/20">
                    <div className="text-[11px] font-semibold tracking-wide text-red-200/80 uppercase">
                      Total Generated
                    </div>
                    <div className="mt-2 font-mono text-3xl font-extrabold text-white">
                      {combinationsGenerated.toLocaleString()}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-white/80">
                      lotto picks generated
                    </div>
                  </div>
                </div>
              )}
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
};

export default PowerballGenerator;
