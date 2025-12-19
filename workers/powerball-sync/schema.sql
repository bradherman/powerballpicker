-- Create picks table to store all generated picks
CREATE TABLE IF NOT EXISTS picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  main_numbers TEXT NOT NULL, -- JSON array of 5 numbers
  powerball INTEGER NOT NULL,
  generated_at TEXT NOT NULL, -- ISO 8601 timestamp
  draw_date TEXT, -- ISO 8601 date of the draw this pick was for (null if not yet drawn)
  checked BOOLEAN DEFAULT 0, -- Whether this pick has been checked against a draw
  white_matches INTEGER, -- Number of white ball matches (0-5)
  powerball_match BOOLEAN, -- Whether powerball matched
  prize_base INTEGER, -- Base prize in cents (0 if no win, or amount)
  prize_with_pp INTEGER, -- Prize with Power Play in cents (null if no Power Play)
  power_play_multiplier INTEGER, -- The multiplier that was active
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_picks_generated_at ON picks(generated_at);
CREATE INDEX IF NOT EXISTS idx_picks_checked ON picks(checked);
CREATE INDEX IF NOT EXISTS idx_picks_draw_date ON picks(draw_date);

-- Create winnings summary table
CREATE TABLE IF NOT EXISTS winnings_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draw_date TEXT NOT NULL UNIQUE, -- ISO 8601 date of the draw
  total_picks_checked INTEGER NOT NULL,
  winning_picks INTEGER NOT NULL,
  total_winnings_cents INTEGER NOT NULL, -- Total winnings in cents
  max_single_win_cents INTEGER NOT NULL, -- Maximum single pick win in cents
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_winnings_draw_date ON winnings_summary(draw_date);

