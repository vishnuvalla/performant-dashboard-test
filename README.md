# Performant dashboard (telemetry test)

A small **React + Vite** dashboard that visualizes **10,000** simulated drones at high frame rates. Telemetry arrives as **binary WebSocket** frames, is copied into a **`SharedArrayBuffer`** by a **Web Worker** (no per-field parsing on the hot path), and is rendered with **Deck.gl** (orthographic grid + scatter plot).

## Architecture (short)

| Piece | Role |
|--------|------|
| **`server.js`** | Node **WebSocket** server (~60 Hz) + **HTTP admin** API. Emits raw snapshots that match `src/telemetryConstants.ts`. |
| **`telemetryWorker.ts`** | `Uint8Array#set` from each WS frame into the SAB—bulk copy, endianness matches the wire format. |
| **`App.tsx`** | Owns the `SharedArrayBuffer`; wires worker + UI. |
| **`DeckMap.tsx`** | **Deck.gl** map: `PathLayer` grid + `ScatterplotLayer` subclass that disables fp64 for Cartesian positions; reads telemetry via accessors + `updateTriggers` when the SAB updates. |
| **`Sidebar.tsx`** | Reads selected slot from the SAB for debugging / actions. |

**Wire format:** fixed **20 bytes** per drone × 10k instances (`RECORD_BYTES`, `INSTANCE_COUNT` in `telemetryConstants.ts`). Layout is shared by `server.js` and the client.

## Ports

| Port | Service |
|------|---------|
| **8080** | WebSocket telemetry (`ws://127.0.0.1:8080`) |
| **8081** | Drone **admin HTTP** (mission, offline/relaunch/kill, etc.) |
| **Vite** | Dev server (default **5173** unless configured) |

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` runs **Vite** and, if port **8080** is free, **spawns `server.js`** so you usually do **not** need a second terminal. If something is already bound to 8080, start the server yourself: `npm run dev:server`.

- Open the URL Vite prints (e.g. `http://localhost:5173`).
- The header should show **`Telemetry WS: open`** when the client connects.

**Two-terminal workflow** (optional):

```bash
# Terminal 1
npm run dev:server

# Terminal 2
npm run dev:client
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `VITE_WS_URL` | WebSocket URL (default `ws://127.0.0.1:8080`). |
| `VITE_ADMIN_URL` | Admin API base (default `http://127.0.0.1:8081`). |
| `SKIP_TELEMETRY_SERVER` | Set to `1` or `true` to stop Vite from auto-spawning `server.js` (see `vite.config.ts`). |

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Vite dev server (+ auto telemetry server when port 8080 is free). |
| `npm run dev:server` | Node telemetry + admin API only. |
| `npm run dev:client` | Vite only. |
| `npm run build` | `tsc -b` then production Vite build. |
| `npm run preview` | Serve the production build locally. |
| `npm run lint` | ESLint. |

`postinstall` runs **`patch-package`** (see `patches/`).

## Tech stack

- **React 19**, **TypeScript**, **Vite 8**
- **Deck.gl 9** / **luma.gl** (WebGL; WebGPU-oriented stack in v9)
- **`ws`** (Node WebSocket server)

## Troubleshooting

- **`Telemetry WS` stuck on connecting / closed** — Ensure `server.js` is running and **8080** matches `VITE_WS_URL`. Prefer **`127.0.0.1`** over `localhost` if IPv4/IPv6 mismatches appear.
- **Port 8080 in use** — Another process may hold it (including a stray Node after Ctrl+C on Windows). Free the port or set `SKIP_TELEMETRY_SERVER=1` and run `npm run dev:server` manually.
- **No dots on the map** — Requires an open WS and non-empty SAB; the map uses accessor-based positions and a small **`telemetryFrame`** tick so Deck.gl refreshes after in-place SAB writes.

## License

Private project (`"private": true` in `package.json`).
