# Testing the Worker Locally

## Quick Test

1. **Start the worker in dev mode:**
   ```bash
   cd workers/powerball-sync
   npx wrangler dev
   ```

2. **In another terminal, test the parsing:**
   ```bash
   curl http://localhost:8787/api/powerball/test-parse
   ```

   This will show you:
   - Whether it found the latest draw
   - The parsed draw data
   - A snippet of the HTML for debugging

3. **Test the full sync (requires token):**
   ```bash
   curl -X POST "http://localhost:8787/api/powerball/sync?token=YOUR_TOKEN"
   ```

## Debugging

The test endpoint (`/api/powerball/test-parse`) will show:
- `found`: boolean indicating if a draw was found
- `draw`: the parsed draw object with main numbers, powerball, date, and multiplier
- `htmlSnippet`: a snippet of the HTML around the "winning" section for debugging

If parsing fails, check the `htmlSnippet` to see the actual HTML structure and adjust the parsing logic accordingly.

