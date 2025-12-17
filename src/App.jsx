import React, { useEffect, useMemo, useState } from "react";

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

  const validateNumberList = (input, min, max) => {
    const raw = String(input ?? "").trim();
    if (!raw) return { numbers: [], errors: [] };

    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    const seen = new Set();
    const duplicates = new Set();
    const invalidTokens = [];
    const outOfRange = [];
    const numbers = [];

    for (const part of parts) {
      const n = Number.parseInt(part, 10);
      if (!Number.isFinite(n)) {
        invalidTokens.push(part);
        continue;
      }
      if (n < min || n > max) {
        outOfRange.push(n);
        continue;
      }
      if (seen.has(n)) {
        duplicates.add(n);
        continue;
      }
      seen.add(n);
      numbers.push(n);
    }

    const errors = [];
    if (invalidTokens.length > 0) {
      errors.push(`Invalid entries: ${invalidTokens.join(", ")}`);
    }
    if (outOfRange.length > 0) {
      errors.push(
        `Out of range (${min}–${max}): ${Array.from(new Set(outOfRange)).join(
          ", "
        )}`
      );
    }
    if (duplicates.size > 0) {
      errors.push(`Duplicate numbers: ${Array.from(duplicates).join(", ")}`);
    }

    return { numbers, errors };
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
  const [mainLockedInput, setMainLockedInput] = useState("");
  const [powerballLockedInput, setPowerballLockedInput] = useState("");

  const mainLockedValidation = useMemo(() => {
    return validateNumberList(mainLockedInput, 1, 69);
  }, [mainLockedInput]);
  const powerballLockedValidation = useMemo(() => {
    return validateNumberList(powerballLockedInput, 1, 26);
  }, [powerballLockedInput]);

  const mainLocked = mainLockedValidation.numbers;
  const powerballLocked = powerballLockedValidation.numbers;

  const lockedError = useMemo(() => {
    if (mainLockedValidation.errors.length > 0)
      return "Fix Main locked errors.";
    if (powerballLockedValidation.errors.length > 0)
      return "Fix Powerball locked errors.";
    if (mainLocked.length > 5)
      return "Main locked can include at most 5 numbers (since there are only 5 main balls).";
    return null;
  }, [
    mainLocked,
    mainLockedValidation.errors,
    powerballLockedValidation.errors,
  ]);

  const [picks, setPicks] = useState(() => generatePicks(5, 70, [], []));
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState(null);
  const [copied, setCopied] = useState(null);
  const [showStats, setShowStats] = useState(true);

  const formatPickLine = (pick) => {
    const main = pick.main.map((n) => String(n).padStart(2, "0")).join(" ");
    const pb = String(pick.powerball).padStart(2, "0");
    return `${main} ${pb}`;
  };

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
        return copy;
      }

      pick.main[index] = next;
      pick.main.sort((a, b) => a - b);
      return copy;
    });

    setEditing(null);
    setEditValue("");
    setEditError(null);
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
                <div className="inline-flex items-center gap-2 rounded-full bg-white/5 px-3 py-1 text-xs text-white/80 ring-1 ring-white/10">
                  <span className="font-semibold tracking-wide">
                    POWERBALL STUDIO
                  </span>
                  <span className="h-1 w-1 rounded-full bg-white/40" />
                  <span>Weighted + editable</span>
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
                  <span className="rounded-full bg-white/5 px-3 py-1 ring-1 ring-white/10 text-white/80">
                    No auto-refresh while tweaking settings
                  </span>
                  {drawsUpdatedAt && (
                    <span className="rounded-full bg-white/5 px-3 py-1 ring-1 ring-white/10 text-white/80">
                      Data updated{" "}
                      <span className="font-semibold text-white">
                        {drawsUpdatedAt}
                      </span>
                    </span>
                  )}
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
                      0% leans into historical weighting. 100% is uniform random.
                    </p>
                  </div>

                  <div>
                    <label
                      htmlFor="mainLockedNumbers"
                      className="block text-sm font-semibold text-white/90"
                    >
                      Main locked (1–69)
                    </label>
                    <input
                      id="mainLockedNumbers"
                      type="text"
                      value={mainLockedInput}
                      onChange={(e) => setMainLockedInput(e.target.value)}
                      placeholder="e.g. 13, 24"
                      className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white shadow-sm placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-red-400/30"
                    />
                    {mainLockedValidation.errors.length > 0 ? (
                      <div className="mt-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                        {mainLockedValidation.errors.map((e) => (
                          <div key={e}>{e}</div>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <label
                      htmlFor="powerballLockedNumbers"
                      className="block text-sm font-semibold text-white/90"
                    >
                      Powerball locked (1–26)
                    </label>
                    <input
                      id="powerballLockedNumbers"
                      type="text"
                      value={powerballLockedInput}
                      onChange={(e) => setPowerballLockedInput(e.target.value)}
                      placeholder="e.g. 13, 24"
                      className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white shadow-sm placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-red-400/30"
                    />
                    {powerballLockedValidation.errors.length > 0 ? (
                      <div className="mt-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                        {powerballLockedValidation.errors.map((e) => (
                          <div key={e}>{e}</div>
                        ))}
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

                  <button
                    onClick={() => {
                      if (lockedError) return;
                      setEditing(null);
                      setEditValue("");
                      setEditError(null);
                      setCopied(null);
                      setPicks(
                        generatePicks(
                          numLines,
                          randomness,
                          mainLocked,
                          powerballLocked
                        )
                      );
                    }}
                    className="w-full rounded-xl bg-gradient-to-r from-red-500 via-red-500 to-orange-400 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-red-500/20 ring-1 ring-white/10 transition hover:brightness-110 active:brightness-95 disabled:opacity-60"
                  >
                    Generate New Picks
                  </button>
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
                      Click any ball to edit. Copy a single line or the full set.
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
                  {picks.map((pick, idx) => (
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
                        </div>

                        <div className="flex items-center gap-3 flex-wrap">
                          <div className="flex gap-2">
                            {pick.main.map((num, i) => {
                              const isEditing =
                                editing?.lineIdx === idx &&
                                editing?.kind === "main" &&
                                editing?.index === i;

                              if (isEditing) {
                                return (
                                  <div
                                    key={i}
                                    className="h-12 w-12 rounded-full bg-white/10 ring-2 ring-red-400/40 flex items-center justify-center"
                                  >
                                    <input
                                      autoFocus
                                      type="number"
                                      min={1}
                                      max={69}
                                      inputMode="numeric"
                                      value={editValue}
                                      onChange={(e) => setEditValue(e.target.value)}
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

                              return (
                                <button
                                  key={i}
                                  type="button"
                                  title="Click to edit"
                                  onClick={() => beginEdit(idx, "main", i)}
                                  className="h-12 w-12 rounded-full bg-white/10 text-white font-bold ring-1 ring-white/10 transition hover:bg-white/15"
                                >
                                  {num.toString().padStart(2, "0")}
                                </button>
                              );
                            })}
                          </div>

                          <span className="text-white/50 font-semibold">+</span>

                          {(() => {
                            const isEditingPb =
                              editing?.lineIdx === idx && editing?.kind === "pb";
                            if (isEditingPb) {
                              return (
                                <div className="h-12 w-12 rounded-full bg-gradient-to-b from-red-500 to-red-700 ring-2 ring-red-300/40 flex items-center justify-center shadow-lg shadow-red-500/15">
                                  <input
                                    autoFocus
                                    type="number"
                                    min={1}
                                    max={26}
                                    inputMode="numeric"
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
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

                            return (
                              <button
                                type="button"
                                title="Click to edit"
                                onClick={() => beginEdit(idx, "pb", null)}
                                className="h-12 w-12 rounded-full bg-gradient-to-b from-red-500 to-red-700 text-white font-extrabold ring-1 ring-red-300/30 shadow-lg shadow-red-500/15 transition hover:brightness-110"
                              >
                                {pick.powerball.toString().padStart(2, "0")}
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
                  ))}
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
                          <div className="font-extrabold text-white">
                            {num}
                          </div>
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
                          <div className="font-extrabold text-white">
                            {num}
                          </div>
                          <div className="text-xs text-white/60">{count}x</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-sm text-white/70">
                    <strong className="text-white">Note:</strong> Powerball is
                    random. Historical frequency does not predict future results.
                    Play responsibly.
                  </p>
                </div>
              </div>
            )}
          </div>

          <footer className="mt-10 text-center text-xs text-white/50">
            Remember: jackpot odds are approximately 1 in 292 million.
          </footer>
        </div>
      </div>
    </div>
  );
};

export default PowerballGenerator;
