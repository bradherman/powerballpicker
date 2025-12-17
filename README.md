# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Nightly Powerball data sync (Cloudflare Worker + KV)

This app can load Powerball winning numbers from a nightly-synced API instead of shipping a giant hardcoded dataset.

- **Upstream dataset**: `https://data.ny.gov/api/views/d6yy-54nr/rows.json?accessType=DOWNLOAD` (linked from the Data.gov resource page: `https://catalog.data.gov/dataset/lottery-powerball-winning-numbers-beginning-2010/resource/074f73f1-5722-46a5-8646-c0c6822d6602`)
- **Worker**: `workers/powerball-sync/` (scheduled via cron trigger)
- **Storage**: Workers KV (binding name: `POWERBALL_KV`)
- **Frontend endpoint**: `GET /api/powerball/draws`

### Setup steps

1. Install Wrangler (Cloudflare’s CLI):

```bash
npm i -D wrangler
```

2. Login:

```bash
npx wrangler login
```

3. Create a KV namespace (you’ll get an `id` back):

```bash
npx wrangler kv namespace create POWERBALL_KV
```

4. Put the returned `id` into `workers/powerball-sync/wrangler.toml` under `[[kv_namespaces]]`.

5. Deploy the Worker:

```bash
cd workers/powerball-sync
npx wrangler deploy
```

6. (Recommended) Set a secret so you can manually trigger the first sync:

```bash
cd workers/powerball-sync
npx wrangler secret put POWERBALL_SYNC_TOKEN
```

Then trigger a one-time sync (replace the host with your Pages custom domain):

```bash
curl -X POST "https://yourdomain.com/api/powerball/sync" \
  -H "Authorization: Bearer YOUR_TOKEN_VALUE"
```

6. Route `/api/*` to the Worker so your Cloudflare Pages site can call it on the same host:
   - In the Cloudflare dashboard: **Workers & Pages → your Worker → Triggers → Routes**
   - Add a route for your Pages domain like `your-site.pages.dev/api/*` (or your custom domain).

7. Confirm the cron trigger is enabled in the Worker (configured in `workers/powerball-sync/wrangler.toml`).

### Notes

- In production builds, `src/App.jsx` does **not** include the embedded historical dataset (it’s kept only for local dev), so the bundle stays small.
- Cloudflare docs that are relevant:
  - Workers “fetch JSON” example: `https://developers.cloudflare.com/workers/examples/fetch-json/`
  - Pages/Workers bindings (KV): `https://developers.cloudflare.com/pages/functions/bindings/`
  - Workers API reference (includes scheduled events): `https://developers.cloudflare.com/workers/api/`
