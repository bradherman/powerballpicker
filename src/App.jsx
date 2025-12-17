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
  const [showStats, setShowStats] = useState(false);

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
    <div className="p-6 max-w-4xl mx-auto bg-linear-to-br from-red-50 to-white min-h-screen">
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        <h1 className="text-3xl font-bold text-red-600 mb-2">
          🎱 Powerball Number Generator
        </h1>
        <p className="text-gray-600 mb-4">
          Generates picks using a blend of historical frequency weighting and
          randomness (higher randomness = closer to uniform random). You can
          also lock numbers to be included in every pick. Data is nightly-synced
          (falls back to embedded data in local dev).
          {drawsUpdatedAt && (
            <span className="inline-block ml-2 text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
              Updated <span className="font-medium">{drawsUpdatedAt}</span>
            </span>
          )}
        </p>

        <p className="text-gray-600 mb-4">
          If you win, please give me %1 of the jackpot.
        </p>

        <div className="flex flex-col gap-3 mb-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex items-center gap-3">
              <label
                htmlFor="numLines"
                className="font-semibold text-gray-700 whitespace-nowrap"
              >
                Number of lines
              </label>
              <input
                id="numLines"
                type="number"
                min={1}
                max={50}
                step={1}
                value={numLines}
                onChange={(e) => setNumLines(clampInt(e.target.value, 1, 50))}
                className="w-24 rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400"
              />
            </div>

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
              className="bg-red-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-red-700 transition"
            >
              🎲 Generate New Picks
            </button>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label
              htmlFor="randomness"
              className="font-semibold text-gray-700 whitespace-nowrap"
            >
              Randomness
            </label>
            <input
              id="randomness"
              type="range"
              min={0}
              max={100}
              value={randomness}
              onChange={(e) => setRandomness(clampInt(e.target.value, 0, 100))}
              className="w-full"
            />
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
                className="w-20 rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400"
              />
              <span className="text-sm text-gray-600">%</span>
            </div>
          </div>

          <p className="text-xs text-gray-500">
            0% = mostly history-weighted • 100% = fully uniform random. Main
            numbers are always unique within a line; duplicate lines can still
            happen (especially at higher randomness).
          </p>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label
              htmlFor="mainLockedNumbers"
              className="font-semibold text-gray-700 whitespace-nowrap"
            >
              Main locked
            </label>
            <input
              id="mainLockedNumbers"
              type="text"
              value={mainLockedInput}
              onChange={(e) => setMainLockedInput(e.target.value)}
              placeholder="e.g. 13, 24"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400"
            />
          </div>

          {mainLockedValidation.errors.length > 0 ? (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {mainLockedValidation.errors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label
              htmlFor="powerballLockedNumbers"
              className="font-semibold text-gray-700 whitespace-nowrap"
            >
              Powerball locked
            </label>
            <input
              id="powerballLockedNumbers"
              type="text"
              value={powerballLockedInput}
              onChange={(e) => setPowerballLockedInput(e.target.value)}
              placeholder="e.g. 13, 24"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400"
            />
          </div>

          {powerballLockedValidation.errors.length > 0 ? (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {powerballLockedValidation.errors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
          ) : null}

          {lockedError ? (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {lockedError}
            </div>
          ) : mainLocked.length > 0 || powerballLocked.length > 0 ? (
            <div className="text-xs text-gray-600">
              Main locked:{" "}
              <span className="font-medium">
                {mainLocked.length > 0 ? mainLocked.join(", ") : "—"}
              </span>
              {" • "}
              Powerball locked:{" "}
              <span className="font-medium">
                {powerballLocked.length > 0 ? powerballLocked.join(", ") : "—"}
              </span>
            </div>
          ) : null}
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-bold text-gray-800">
              Your {picks.length} Powerball Picks:
            </h2>
            <button
              type="button"
              onClick={handleCopyAll}
              className="text-sm font-semibold px-3 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 transition"
            >
              Copy all
              {copied === "all" ? " ✓" : ""}
            </button>
          </div>
          {picks.map((pick, idx) => (
            <div
              key={idx}
              className="bg-linear-to-r from-gray-100 to-gray-50 p-4 rounded-lg border-2 border-gray-200"
            >
              <div className="flex items-center gap-3 flex-wrap justify-between">
                <span className="font-bold text-gray-700">
                  Pick #{idx + 1}:
                </span>
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
                            className="w-12 h-12 bg-white rounded-full flex items-center justify-center border-2 border-red-300 shadow"
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
                              className="w-10 text-center font-bold text-gray-800 focus:outline-none"
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
                          className="w-12 h-12 bg-white rounded-full flex items-center justify-center font-bold text-gray-800 border-2 border-gray-300 shadow hover:border-gray-400 transition"
                        >
                          {num.toString().padStart(2, "0")}
                        </button>
                      );
                    })}
                  </div>

                  <span className="text-gray-500 font-semibold">+</span>

                  {(() => {
                    const isEditingPb =
                      editing?.lineIdx === idx && editing?.kind === "pb";
                    if (isEditingPb) {
                      return (
                        <div className="w-12 h-12 bg-red-600 rounded-full flex items-center justify-center border-2 border-red-700 shadow-lg">
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
                            className="w-10 text-center font-bold text-white bg-transparent focus:outline-none"
                          />
                        </div>
                      );
                    }

                    return (
                      <button
                        type="button"
                        title="Click to edit"
                        onClick={() => beginEdit(idx, "pb", null)}
                        className="w-12 h-12 bg-red-600 rounded-full flex items-center justify-center font-bold text-white border-2 border-red-700 shadow-lg hover:bg-red-700 transition"
                      >
                        {pick.powerball.toString().padStart(2, "0")}
                      </button>
                    );
                  })()}

                  <button
                    type="button"
                    onClick={() => handleCopyLine(idx)}
                    className="text-sm font-semibold px-3 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 transition"
                    title="Copy this line"
                  >
                    Copy
                    {copied === `line:${idx}` ? " ✓" : ""}
                  </button>
                </div>
              </div>

              {editing?.lineIdx === idx && editError ? (
                <div className="mt-2 text-sm text-red-700">{editError}</div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="bg-linear-to-br from-white to-gray-50 rounded-lg shadow-lg p-6">
        <button
          onClick={() => setShowStats(!showStats)}
          className="w-full text-left font-semibold text-lg text-gray-800 flex justify-between items-center"
        >
          <span>📊 Historical Data Statistics</span>
          <span>{showStats ? "▼" : "▶"}</span>
        </button>

        {showStats && (
          <div className="mt-4 space-y-4">
            <div>
              <h3 className="font-semibold text-gray-700 mb-2">
                Most Frequent Main Numbers (Top 10):
              </h3>
              {topMain.length === 0 ? (
                <div className="text-sm text-gray-600">
                  No draw data loaded yet.
                </div>
              ) : (
                <div className="grid grid-cols-5 gap-2">
                  {topMain.map(([num, count]) => (
                    <div
                      key={num}
                      className="bg-blue-50 p-2 rounded text-center border border-blue-200"
                    >
                      <div className="font-bold text-blue-700">{num}</div>
                      <div className="text-xs text-gray-600">{count}x</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 className="font-semibold text-gray-700 mb-2">
                Most Frequent Powerball Numbers (Top 5):
              </h3>
              {topPB.length === 0 ? (
                <div className="text-sm text-gray-600">
                  No draw data loaded yet.
                </div>
              ) : (
                <div className="grid grid-cols-5 gap-2">
                  {topPB.map(([num, count]) => (
                    <div
                      key={num}
                      className="bg-red-50 p-2 rounded text-center border border-red-200"
                    >
                      <div className="font-bold text-red-700">{num}</div>
                      <div className="text-xs text-gray-600">{count}x</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-linear-to-br from-yellow-50 to-gray-50 p-4 rounded-lg border border-yellow-200 mt-4">
              <p className="text-sm text-gray-700">
                <strong>⚠️ Important Note:</strong> These picks are randomly
                generated. While based on historical data analysis, every
                Powerball drawing is independent and random. Past frequency does
                not predict future results. Play responsibly and only spend what
                you can afford!
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 text-center text-sm text-gray-500">
        <p>
          Good luck! 🍀 Remember: The odds of winning the Powerball jackpot are
          approximately 1 in 292 million.
        </p>
      </div>
    </div>
  );
};

export default PowerballGenerator;
