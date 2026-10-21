# taste-quest

A Pokémon Go-style taste explorer for the [Qloo Agentic Hackathon](https://qloo.devpost.com/) (submit by Oct 30, 2026).

You pick tastes, say how long you have, and get a walkable route on a live map. Stops are ranked by Qloo place affinity. Each one says why it fits, using explainability shares that sum to 1 across your picks. The route can be rebuilt as you skip stops.

Guest mode only. Nothing about you is stored on the server. Your taste profile and the active walk live in the browser (`localStorage`, with an IndexedDB mirror).

## Stack

- Next.js 15 App Router, TypeScript, Tailwind CSS v4 (tokens matched to qloo.com)
- MapLibre GL with [OpenFreeMap](https://openfreemap.org) Positron, recoloured to the Qloo map palette
- Qloo Hackathon API (`https://hackathon.api.qloo.com`, `X-Api-Key`)
- Self-hosted OSRM `foot` profile, reached through `OSRM_BASE_URL` (the base already includes its path token)
- Vercel Runtime Cache (`getCache` from `@vercel/functions`) for search, tags, candidate pools, routes, weather, and the quota meter
- Vercel AI SDK through AI Gateway with OIDC: an agent (`google/gemini-2.5-flash`, fallback `google/gemini-2.5-flash-lite`; the AI Gateway free tier serves Google models only) plans custom walks through Qloo tools (`lib/agent/planner.ts`)

Straight-line segments labeled **approx.** are used when OSRM is unset, errors, or takes longer than two seconds.

## Mock mode

If `QLOO_API_KEY` is missing, search, tags, and place insights use the synthetic catalog in `lib/qloo/sample.ts`. Those places are sample data, not Qloo responses. If `OSRM_BASE_URL` is missing, routes that are not the Austin demo use the straight-line fallback. The Austin demo (no key and no OSRM) draws the four-stop scene from the design screens, including that screen’s recorded foot path, so the map matches the mockup without calling either service.

## Setup

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Open http://localhost:3000 and tap **Try the Austin demo**.

| Variable | Required | Purpose |
|---|---|---|
| `QLOO_API_KEY` | For live taste data | Sent as `X-Api-Key`. Unset → synthetic sample data. |
| `QLOO_API_URL` | No | Defaults to `https://hackathon.api.qloo.com`. |
| `OSRM_BASE_URL` | For street-following routes | Base URL **including** the auth path token. Unset → approx. lines. |
| `AI_MODEL` | No | Default `google/gemini-2.5-flash`. Used by the agent and stop blurbs. Must have a price in `lib/agent/budget.ts`. |
| `AI_FALLBACK_MODEL` | No | Default `google/gemini-2.5-flash-lite`. Gateway `models` fallback. |
| `AI_GATEWAY_API_KEY` | Local only | Optional. On Vercel the gateway uses the request's OIDC token. |
| `AI_DAILY_BUDGET_USD` | No | App-side AI spend cap per UTC day, default `0.3`. Best-effort (Runtime Cache counter); the AI Gateway budget is the hard limit. |
| `ADMIN_TOKEN` | For `/api/health` | `Authorization: Bearer …` |
| `CRON_SECRET` | For the demo warmer | Not implemented in this slice (`#14`). |

Do not commit `.env.local`, API keys, or Qloo response bodies. `vercel env pull` is how local OIDC tokens are meant to arrive.

Live contract check (about three calls, not CI):

```bash
QLOO_API_KEY=… node --experimental-strip-types scripts/probe-qloo.ts
```

## Scripts

```bash
pnpm test       # engine, normalizer, quota bands, blurb guard
pnpm typecheck
pnpm lint
pnpm build
```

## What this slice covers

Real, and covered by tests or the mock-mode walk:

- App shell, design tokens, and the welcome, onboarding, time, map, and stop screens
- Qloo client: 4 req/s token bucket, concurrency cap of 3, 429 backoff, quota meter, normalizer
- Runtime Cache keys for search, tags, pools, routes, weather, blurbs, and `qloo:quota`
- Quota guard: under 1,500 remaining, search stays on curated chips; under 500, new live plans are demo or cache only
- Taste onboarding (curated chips, debounced search, tag fallback, vibe seeds)
- Time budget, GPS / pin / Austin demo start, Open-Meteo context
- Route engine: filters, affinity normalization, dwell, orienteering insertion, 2-opt, swap, re-route diff
- OSRM foot client and straight-line fallback
- `POST /api/plan` as an AI SDK UI message stream (`data-step`, `data-stop`, `data-route`, `data-walk`)
- Skip → `POST /api/reroute`, with an 8s undo of the previous walk version

Stubbed, with TODOs in the code:

- `#7` Agent tool loop: done (`lib/agent/planner.ts`). Tools: read_context, add_vibe, find_places, plan_walk, explain_stops. Stops only from Qloo's results; the engine owns time and route; any failure falls back to the plain planner. The preset Austin demo replays recorded agent steps (`DEMO_AGENT_STEPS`). Spend is capped in `lib/agent/budget.ts`.
- `#8` Automatic re-route (off-route, late, closed, weather). The trigger predicate is tested. The map watches GPS for the user dot only. Skip is manual.
- `#14` Warmed `demo:v1` cache, cron, and the simulated-walk scrubber. **Try the Austin demo** still plans from the preset profile.

## Attributions

Map data © OpenStreetMap contributors. Tiles © OpenFreeMap / OpenMapTiles. Routing by OSRM when configured. Weather by Open-Meteo. Taste intelligence by Qloo.

## License

MIT
