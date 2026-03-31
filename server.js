/**
 * Node telemetry emitter — interleaved binary snapshot @ ~60 Hz.
 * Layout must match src/telemetryConstants.ts (RECORD_BYTES=20).
 */
import http from 'node:http'
import { WebSocketServer } from 'ws'

// --- Mirror telemetryConstants.ts (plain JS server; no TS import) ---
const RECORD_BYTES = 20
const INSTANCE_COUNT = 10_000
const SAB_BYTES = RECORD_BYTES * INSTANCE_COUNT

const OFF_ID = 0
const OFF_X = 4
const OFF_Y = 8
const OFF_ALT = 12
const OFF_FLAGS = 16

const DRONE_FLAG_OFFLINE = 1

const WS_PORT = 8080
const ADMIN_PORT = 8081

// ARCHITECTURE NOTE: We send raw ArrayBuffer snapshots instead of JSON arrays because:
// (1) JSON would ~5–10× the bytes for numeric telemetry and add stringify/parse CPU on both ends.
// (2) A single flat buffer maps 1:1 to GPU attribute uploads and SharedArrayBuffer layout on the client.

const TICK_NS = 1_000_000_000n / 60n
const MAX_CATCHUP_STEPS = 5

const buffer = Buffer.alloc(SAB_BYTES)
const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

/** Server-side kinematics only (not on the wire). */
const vx = new Float32Array(INSTANCE_COUNT)
const vy = new Float32Array(INSTANCE_COUNT)
const vz = new Float32Array(INSTANCE_COUNT)

/** Per-slot mission target (xy world plane). missionActive[i] === 0 means wander. */
const missionActive = new Uint8Array(INSTANCE_COUNT)
const missionTx = new Float32Array(INSTANCE_COUNT)
const missionTy = new Float32Array(INSTANCE_COUNT)

const MISSION_ARRIVAL_DIST = 12
const MISSION_CRUISE_SPEED = 13
const MISSION_STEER = 0.22

let nextSpawnId = 0x1000_0000 + INSTANCE_COUNT

function clearMission(i) {
  missionActive[i] = 0
}

/** Random “pick one slot” offline simulation (~few per minute across 10k drones). */
const OFFLINE_PICK_TICK_PROB = 0.00035
/** Random “pick one empty slot” fill (~similar rate). */
const SPAWN_PICK_TICK_PROB = 0.0004

function randomPosition() {
  const x = (Math.random() - 0.5) * 1800
  const y = (Math.random() - 0.5) * 1800
  const alt = 80 + Math.random() * 120
  return { x, y, alt }
}

function randomVelocity() {
  return {
    vx: (Math.random() - 0.5) * 8,
    vy: (Math.random() - 0.5) * 8,
    vz: (Math.random() - 0.5) * 2,
  }
}

function writeDroneAtIndex(i, id) {
  const o = i * RECORD_BYTES
  const { x, y, alt } = randomPosition()
  const v = randomVelocity()
  dv.setUint32(o + OFF_ID, id, true)
  dv.setFloat32(o + OFF_X, x, true)
  dv.setFloat32(o + OFF_Y, y, true)
  dv.setFloat32(o + OFF_ALT, alt, true)
  dv.setUint32(o + OFF_FLAGS, 0, true)
  vx[i] = v.vx
  vy[i] = v.vy
  vz[i] = v.vz
  clearMission(i)
}

function initState() {
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const id = 0x1000_0000 + i
    writeDroneAtIndex(i, id)
  }
}

/** Random walk in the plane: per-step velocity jitter + damping. */
const VEL_JITTER_XY = 0.45
const VEL_JITTER_Z = 0.12
const VEL_DAMP = 0.994
const MAX_SPEED_XY = 14
const MAX_SPEED_Z = 3

function simulateRandomEvents() {
  if (Math.random() < OFFLINE_PICK_TICK_PROB) {
    const i = (Math.random() * INSTANCE_COUNT) | 0
    const o = i * RECORD_BYTES
    const id = dv.getUint32(o + OFF_ID, true)
    if (id === 0) return
    const flags = dv.getUint32(o + OFF_FLAGS, true)
    if (flags & DRONE_FLAG_OFFLINE) return
    dv.setUint32(o + OFF_FLAGS, flags | DRONE_FLAG_OFFLINE, true)
  }
  if (Math.random() < SPAWN_PICK_TICK_PROB) {
    const i = (Math.random() * INSTANCE_COUNT) | 0
    const o = i * RECORD_BYTES
    if (dv.getUint32(o + OFF_ID, true) !== 0) return
    writeDroneAtIndex(i, nextSpawnId++)
  }
}

function simulateStep() {
  simulateRandomEvents()
  const dt = 1 / 60
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const o = i * RECORD_BYTES
    const id = dv.getUint32(o + OFF_ID, true)
    if (id === 0) continue
    const flags = dv.getUint32(o + OFF_FLAGS, true)
    if (flags & DRONE_FLAG_OFFLINE) continue

    let x = dv.getFloat32(o + OFF_X, true)
    let y = dv.getFloat32(o + OFF_Y, true)

    if (missionActive[i]) {
      const tx = missionTx[i]
      const ty = missionTy[i]
      const dx = tx - x
      const dy = ty - y
      const dist = Math.hypot(dx, dy)
      if (dist < MISSION_ARRIVAL_DIST) {
        clearMission(i)
        vx[i] *= 0.65
        vy[i] *= 0.65
      } else {
        const ux = dx / dist
        const uy = dy / dist
        const dvx = ux * MISSION_CRUISE_SPEED - vx[i]
        const dvy = uy * MISSION_CRUISE_SPEED - vy[i]
        vx[i] += dvx * MISSION_STEER
        vy[i] += dvy * MISSION_STEER
      }
      vz[i] += (Math.random() - 0.5) * VEL_JITTER_Z * 0.35
      vz[i] *= VEL_DAMP
    } else {
      vx[i] += (Math.random() - 0.5) * VEL_JITTER_XY
      vy[i] += (Math.random() - 0.5) * VEL_JITTER_XY
      vz[i] += (Math.random() - 0.5) * VEL_JITTER_Z
      vx[i] *= VEL_DAMP
      vy[i] *= VEL_DAMP
      vz[i] *= VEL_DAMP
    }

    let sp = Math.hypot(vx[i], vy[i])
    if (sp > MAX_SPEED_XY) {
      vx[i] *= MAX_SPEED_XY / sp
      vy[i] *= MAX_SPEED_XY / sp
    }
    if (Math.abs(vz[i]) > MAX_SPEED_Z) vz[i] = Math.sign(vz[i]) * MAX_SPEED_Z

    x += vx[i] * dt
    y += vy[i] * dt
    let alt = dv.getFloat32(o + OFF_ALT, true) + vz[i] * dt
    if (x < -900 || x > 900) vx[i] *= -1
    if (y < -900 || y > 900) vy[i] *= -1
    if (alt < 40 || alt > 220) vz[i] *= -1
    x = Math.max(-950, Math.min(950, x))
    y = Math.max(-950, Math.min(950, y))
    alt = Math.max(30, Math.min(240, alt))
    dv.setFloat32(o + OFF_X, x, true)
    dv.setFloat32(o + OFF_Y, y, true)
    dv.setFloat32(o + OFF_ALT, alt, true)
  }
}

initState()

const wss = new WebSocketServer({ port: WS_PORT })

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(res, status, body) {
  res.writeHead(status, {
    ...corsHeaders,
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(body))
}

function sendJson(res, body) {
  json(res, 200, body)
}

function killSlot(i) {
  if (i < 0 || i >= INSTANCE_COUNT) return { ok: false, error: 'bad index' }
  const o = i * RECORD_BYTES
  if (dv.getUint32(o + OFF_ID, true) === 0) return { ok: true, skipped: true }
  dv.setUint32(o + OFF_ID, 0, true)
  dv.setUint32(o + OFF_FLAGS, 0, true)
  vx[i] = 0
  vy[i] = 0
  vz[i] = 0
  clearMission(i)
  return { ok: true }
}

function offlineSlot(i) {
  if (i < 0 || i >= INSTANCE_COUNT) return { ok: false, error: 'bad index' }
  const o = i * RECORD_BYTES
  const id = dv.getUint32(o + OFF_ID, true)
  if (id === 0) return { ok: true, skipped: true }
  const flags = dv.getUint32(o + OFF_FLAGS, true)
  dv.setUint32(o + OFF_FLAGS, flags | DRONE_FLAG_OFFLINE, true)
  clearMission(i)
  return { ok: true }
}

function relaunchSlot(i) {
  if (i < 0 || i >= INSTANCE_COUNT) return { ok: false, error: 'bad index' }
  const o = i * RECORD_BYTES
  const id = dv.getUint32(o + OFF_ID, true)
  if (id === 0) {
    writeDroneAtIndex(i, nextSpawnId++)
    return { ok: true, spawned: true }
  }
  const flags = dv.getUint32(o + OFF_FLAGS, true)
  dv.setUint32(o + OFF_FLAGS, flags & ~DRONE_FLAG_OFFLINE, true)
  return { ok: true, spawned: false }
}

function killAll() {
  let n = 0
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const o = i * RECORD_BYTES
    if (dv.getUint32(o + OFF_ID, true) !== 0) {
      killSlot(i)
      n++
    }
  }
  return { ok: true, cleared: n }
}

function offlineAll() {
  let n = 0
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const o = i * RECORD_BYTES
    if (dv.getUint32(o + OFF_ID, true) === 0) continue
    const flags = dv.getUint32(o + OFF_FLAGS, true)
    if (flags & DRONE_FLAG_OFFLINE) continue
    dv.setUint32(o + OFF_FLAGS, flags | DRONE_FLAG_OFFLINE, true)
    n++
  }
  return { ok: true, count: n }
}

function relaunchAll() {
  let cleared = 0
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const o = i * RECORD_BYTES
    const id = dv.getUint32(o + OFF_ID, true)
    if (id === 0) continue
    const flags = dv.getUint32(o + OFF_FLAGS, true)
    if (flags & DRONE_FLAG_OFFLINE) {
      dv.setUint32(o + OFF_FLAGS, flags & ~DRONE_FLAG_OFFLINE, true)
      cleared++
    }
  }
  return { ok: true, offlineCleared: cleared }
}

function clampWorldXY(x, y) {
  return [Math.max(-950, Math.min(950, x)), Math.max(-950, Math.min(950, y))]
}

function setMissionSlot(i, tx, ty) {
  if (i < 0 || i >= INSTANCE_COUNT) return { ok: false, error: 'bad index' }
  const o = i * RECORD_BYTES
  if (dv.getUint32(o + OFF_ID, true) === 0) return { ok: false, error: 'empty slot' }
  const [x, y] = clampWorldXY(tx, ty)
  missionTx[i] = x
  missionTy[i] = y
  missionActive[i] = 1
  return { ok: true, target: { x, y } }
}

function clearMissionSlot(i) {
  if (i < 0 || i >= INSTANCE_COUNT) return { ok: false, error: 'bad index' }
  clearMission(i)
  return { ok: true }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw) resolve(null)
        else resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

const adminServer = http.createServer((req, res) => {
  void (async () => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathname = url.pathname

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, { ok: true, ws: WS_PORT, admin: ADMIN_PORT })
      return
    }

    if (req.method !== 'POST') {
      json(res, 404, { ok: false, error: 'not found' })
      return
    }

    const mMissionClear = /^\/drone\/(\d+)\/mission\/clear$/.exec(pathname)
    if (mMissionClear) {
      sendJson(res, clearMissionSlot(Number(mMissionClear[1])))
      return
    }

    const mMission = /^\/drone\/(\d+)\/mission$/.exec(pathname)
    if (mMission) {
      try {
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object') {
          json(res, 400, { ok: false, error: 'expected JSON { x, y }' })
          return
        }
        const tx = Number((/** @type {Record<string, unknown>} */ (body)).x)
        const ty = Number((/** @type {Record<string, unknown>} */ (body)).y)
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
          json(res, 400, { ok: false, error: 'invalid x or y' })
          return
        }
        sendJson(res, setMissionSlot(Number(mMission[1]), tx, ty))
      } catch {
        json(res, 400, { ok: false, error: 'invalid JSON body' })
      }
      return
    }

    const m = /^\/drone\/(\d+)\/(offline|relaunch|kill)$/.exec(pathname)
    if (m) {
      const index = Number(m[1])
      const action = m[2]
      let out
      if (action === 'offline') out = offlineSlot(index)
      else if (action === 'kill') out = killSlot(index)
      else out = relaunchSlot(index)
      sendJson(res, out)
      return
    }

    if (pathname === '/drones/offline-all') {
      sendJson(res, offlineAll())
      return
    }
    if (pathname === '/drones/kill-all') {
      sendJson(res, killAll())
      return
    }
    if (pathname === '/drones/relaunch-all') {
      sendJson(res, relaunchAll())
      return
    }

    json(res, 404, { ok: false, error: 'not found' })
  })().catch((err) => {
    console.error('admin handler', err)
    json(res, 500, { ok: false, error: 'internal' })
  })
})

adminServer.listen(ADMIN_PORT, () => {
  console.log(`Drone admin HTTP on http://127.0.0.1:${ADMIN_PORT} (POST /drone/:id/:action, /drones/*-all)`)
})

adminServer.on('error', (err) => {
  console.error(`Admin HTTP failed to bind :${ADMIN_PORT}`, err.message)
})

// ARCHITECTURE NOTE: We use process.hrtime.bigint() instead of setInterval(…, 16) because:
// setInterval is not tied to a monotonic clock and drifts under load; the event loop can batch timeouts.
// A fixed-step loop with hrtime keeps nominal 60 Hz simulation steps and caps catch-up (spiral of death).

let nextTickNs = process.hrtime.bigint()

function gameLoop() {
  const now = process.hrtime.bigint()
  let steps = 0
  while (now >= nextTickNs && steps < MAX_CATCHUP_STEPS) {
    simulateStep()
    const snapshot = Buffer.from(buffer)
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(snapshot, { binary: true })
    }
    nextTickNs += TICK_NS
    steps++
  }
  if (steps === MAX_CATCHUP_STEPS && now >= nextTickNs) {
    nextTickNs = now + TICK_NS
  }
  setImmediate(gameLoop)
}

nextTickNs = process.hrtime.bigint() + TICK_NS
setImmediate(gameLoop)

function shutdown(signal) {
  console.log(`\nTelemetry server ${signal ?? 'shutdown'} — closing WebSocket…`)
  adminServer.close()
  wss.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

console.log(
  `Telemetry WS on ws://localhost:${WS_PORT} — ${INSTANCE_COUNT} records × ${RECORD_BYTES} B = ${SAB_BYTES} B/frame`,
)
