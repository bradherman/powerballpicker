#!/usr/bin/env node

/**
 * Simple test script to test the powerball.com parsing locally
 * Run with: node test-local.js
 */

async function testParse() {
  try {
    const res = await fetch("https://www.powerball.com/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PowerballSync/1.0)",
      },
    });

    if (!res.ok) {
      console.error(`Failed to fetch: ${res.status}`);
      return;
    }

    const html = await res.text();
    console.log("HTML length:", html.length);

    // Look for winning numbers section
    const winningIdx = html.toLowerCase().indexOf("winning");
    if (winningIdx >= 0) {
      console.log("\n=== HTML snippet around 'winning' ===");
      console.log(
        html.slice(Math.max(0, winningIdx - 200), winningIdx + 1000)
      );
    }

    // Look for script tags with JSON
    const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    console.log("\n=== Found script tags:", scriptMatches?.length || 0);

    // Look for JSON with winning numbers
    if (scriptMatches) {
      for (let i = 0; i < Math.min(10, scriptMatches.length); i++) {
        const script = scriptMatches[i];
        if (
          script.includes("winning") ||
          script.includes("numbers") ||
          script.includes("draw")
        ) {
          console.log(`\n=== Script ${i} (relevant) ===`);
          console.log(script.substring(0, 500));
        }
      }
    }

    // Test the actual parsing logic
    console.log("\n=== Testing parsing logic ===");
    const winningIndex = html.toLowerCase().indexOf("winning numbers");
    if (winningIndex >= 0) {
      const section = html.slice(winningIndex, winningIndex + 3000);
      console.log("Found 'Winning Numbers' section");

      // Extract date
      const dateMatch = section.match(/title-date[^>]*>([^<]+)</i);
      if (dateMatch) {
        console.log("Date found:", dateMatch[1].trim());
      } else {
        console.log("Date NOT found");
      }

      // Extract white balls
      const whiteBallMatches = [...section.matchAll(/white-balls[^>]*>(\d{1,2})</gi)];
      const whiteBalls = [];
      for (const match of whiteBallMatches) {
        const num = Number.parseInt(match[1], 10);
        if (Number.isFinite(num) && num >= 1 && num <= 69 && !whiteBalls.includes(num)) {
          whiteBalls.push(num);
        }
        if (whiteBalls.length >= 5) break;
      }
      console.log("White balls found:", whiteBalls);

      // Extract powerball
      const lastWhiteBallIndex = section.lastIndexOf("white-balls");
      if (lastWhiteBallIndex >= 0) {
        const afterWhiteBalls = section.substring(lastWhiteBallIndex);
        const powerballDivMatch = afterWhiteBalls.match(
          /<div[^>]*class="[^"]*\bpowerball\b[^"]*"[^>]*>(\d{1,2})</i
        );
        if (powerballDivMatch) {
          console.log("Powerball found:", powerballDivMatch[1]);
        } else {
          console.log("Powerball NOT found");
          console.log("After white-balls snippet:", afterWhiteBalls.substring(0, 300));
        }
      }

      // Extract multiplier
      const multiplierMatch = section.match(/multiplier[^>]*>(\d+)x?</i);
      if (multiplierMatch) {
        console.log("Multiplier found:", multiplierMatch[1]);
      } else {
        console.log("Multiplier NOT found");
      }
    } else {
      console.log("'Winning Numbers' section NOT found");
    }
  } catch (e) {
    console.error("Error:", e);
  }
}

testParse();

