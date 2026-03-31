import { execSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const TELEMETRY_PORT = 8080

/** True if nothing is listening on `port` (we can spawn server.js). */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, () => {
      s.close(() => resolve(true))
    })
  })
}

/**
 * Spawns `node server.js` when you run `vite` alone so WS telemetry is available without a second terminal.
 * If port 8080 is already in use, assumes a server is running and skips spawn.
 * Set SKIP_TELEMETRY_SERVER=1 to disable (e.g. custom server on another host).
 */
function telemetryServerPlugin() {
  let child: ChildProcess | null = null

  const killSpawnedServer = () => {
    if (!child || child.killed) return
    const pid = child.pid
    try {
      if (process.platform === 'win32' && pid != null) {
        // Ctrl+C often leaves the spawned node.exe alive on Windows; SIGTERM alone is unreliable.
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      /* already dead */
    }
    child = null
  }

  return {
    name: 'telemetry-server',
    apply: 'serve' as const,
    configureServer() {
      const skip =
        process.env.SKIP_TELEMETRY_SERVER === '1' || process.env.SKIP_TELEMETRY_SERVER === 'true'
      if (skip) {
        console.info('[telemetry-server] SKIP_TELEMETRY_SERVER set; not spawning server.js')
        return () => {}
      }
      void isPortFree(TELEMETRY_PORT).then((free) => {
        if (!free) {
          console.info(
            `[telemetry-server] port ${TELEMETRY_PORT} in use; not spawning server.js (already running?)`,
          )
          console.info(
            '[telemetry-server] If Ctrl+C left a stray node on 8080, stop it (Task Manager → end "Node.js") or: npx --yes kill-port 8080',
          )
          return
        }
        child = spawn(process.execPath, ['server.js'], {
          cwd: process.cwd(),
          stdio: 'inherit',
          shell: false,
        })
        console.info(
          `[telemetry-server] Drone admin API http://127.0.0.1:8081 (POST /drone/:index/offline|relaunch|kill, /drones/*-all)`,
        )
        child.on('exit', (code, signal) => {
          if (code !== 0 && code !== null && signal !== 'SIGTERM') {
            console.warn(`[telemetry-server] server.js exited with code ${code}`)
          }
          child = null
        })
      })

      const onProcSignal = () => killSpawnedServer()
      process.once('SIGINT', onProcSignal)
      process.once('SIGTERM', onProcSignal)

      return () => {
        process.off('SIGINT', onProcSignal)
        process.off('SIGTERM', onProcSignal)
        killSpawnedServer()
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), telemetryServerPlugin()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // Do not pre-bundle @luma.gl/core: Vite’s esbuild cache (node_modules/.vite/deps) can serve an old
  // copy and ignore patch-package fixes to CanvasContext (ResizeObserver vs device.limits race).
  optimizeDeps: {
    exclude: ['@luma.gl/core'],
  },
})
