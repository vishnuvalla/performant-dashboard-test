import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  DRONE_FLAG_OFFLINE,
  OFF_FLAGS,
  OFF_ID,
  RECORD_BYTES,
} from './telemetryConstants'

const adminBase = () => import.meta.env.VITE_ADMIN_URL ?? 'http://127.0.0.1:8081'

export type SidebarProps = {
  sharedBuffer: SharedArrayBuffer
  selectedDroneId: number | null
  /** O(1) row index from deck.gl picking — must stay in sync with buffer row order. */
  selectedRecordIndex: number | null
  selectingMissionTarget?: boolean
  onToggleMissionTarget?: () => void
}

const btnStyle: CSSProperties = {
  fontSize: 11,
  fontFamily: 'ui-monospace, monospace',
  padding: '4px 8px',
  marginRight: 6,
  marginBottom: 6,
  cursor: 'pointer',
  background: '#1a2838',
  color: '#ddd',
  border: '1px solid #345',
  borderRadius: 2,
}

export default function Sidebar({
  sharedBuffer,
  selectedDroneId,
  selectedRecordIndex,
  selectingMissionTarget = false,
  onToggleMissionTarget,
}: SidebarProps) {
  const liveRef = useRef<HTMLDivElement>(null)
  const [actionNote, setActionNote] = useState<string>('')

  const postAdmin = useCallback(async (path: string) => {
    setActionNote('…')
    try {
      const res = await fetch(`${adminBase()}${path}`, { method: 'POST' })
      const text = await res.text()
      let j: unknown
      try {
        j = JSON.parse(text) as Record<string, unknown>
      } catch {
        setActionNote(`HTTP ${res.status}`)
        return
      }
      setActionNote(JSON.stringify(j))
    } catch (e) {
      setActionNote(e instanceof Error ? e.message : 'request failed')
    }
  }, [])

  useEffect(() => {
    let raf = 0
    const dv = new DataView(sharedBuffer)

    const loop = () => {
      const el = liveRef.current
      if (!el) {
        raf = requestAnimationFrame(loop)
        return
      }
      const row =
        selectedRecordIndex != null && selectedRecordIndex >= 0 ? selectedRecordIndex : 0
      const o = row * RECORD_BYTES
      const id = dv.getUint32(o + OFF_ID, true)
      const flags = dv.getUint32(o + OFF_FLAGS, true)
      const offline = id !== 0 && (flags & DRONE_FLAG_OFFLINE) !== 0
      const x = dv.getFloat32(o + 4, true)
      const y = dv.getFloat32(o + 8, true)
      const alt = dv.getFloat32(o + 12, true)

      let status: string
      if (id === 0) status = 'empty slot (no drone id — backend may assign)'
      else if (offline) status = 'offline (telemetry frozen in SAB — relaunch to resume)'
      else status = 'online'

      const tag = selectedRecordIndex != null && selectedRecordIndex >= 0 ? '' : ' (sample: record 0)'
      el.textContent = `SAB status: ${status}${tag}\nID ${id}  flags 0x${flags.toString(16)}\nx=${x.toFixed(1)} y=${y.toFixed(1)} alt=${alt.toFixed(1)}`
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [sharedBuffer, selectedRecordIndex])

  const hasSlot = selectedRecordIndex != null && selectedRecordIndex >= 0
  const hasDrone = hasSlot && selectedDroneId != null && selectedDroneId !== 0

  return (
    <aside
      style={{
        width: 300,
        flexShrink: 0,
        padding: 12,
        background: '#111820',
        color: '#ddd',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 12,
        borderLeft: '1px solid #223',
        overflow: 'auto',
      }}
    >
      <div style={{ marginBottom: 8 }}>Selected drone ID</div>
      <div style={{ color: '#8cf', marginBottom: 12 }}>{selectedDroneId ?? '—'}</div>

      <div style={{ marginBottom: 8 }}>Live telemetry + SAB (rAF + ref)</div>
      <div ref={liveRef} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginBottom: 14 }} />

      <div style={{ marginBottom: 6, color: '#9ab' }}>Mission</div>
      <div style={{ marginBottom: 8 }}>
        <button
          type="button"
          style={{
            ...btnStyle,
            opacity: hasDrone ? 1 : 0.45,
            borderColor: selectingMissionTarget ? '#6af' : '#345',
            background: selectingMissionTarget ? '#1a3a58' : '#1a2838',
          }}
          disabled={!hasDrone}
          onClick={() => hasDrone && onToggleMissionTarget?.()}
        >
          {selectingMissionTarget ? 'Cancel select target' : 'Select target'}
        </button>
      </div>
      {selectingMissionTarget ? (
        <div style={{ fontSize: 11, color: '#8cf', marginBottom: 12 }}>
          Click the map to set where this drone should fly (xy).
        </div>
      ) : null}

      <div style={{ marginBottom: 6, color: '#9ab' }}>Selected slot (POST /drone/:index/…)</div>
      <div style={{ marginBottom: 8 }}>
        <button
          type="button"
          style={{ ...btnStyle, opacity: hasSlot ? 1 : 0.45 }}
          disabled={!hasSlot}
          onClick={() => hasSlot && void postAdmin(`/drone/${selectedRecordIndex}/offline`)}
        >
          Offline
        </button>
        <button
          type="button"
          style={{ ...btnStyle, opacity: hasSlot ? 1 : 0.45 }}
          disabled={!hasSlot}
          onClick={() => hasSlot && void postAdmin(`/drone/${selectedRecordIndex}/relaunch`)}
        >
          Relaunch
        </button>
        <button
          type="button"
          style={{ ...btnStyle, opacity: hasSlot ? 1 : 0.45 }}
          disabled={!hasSlot}
          onClick={() => hasSlot && void postAdmin(`/drone/${selectedRecordIndex}/kill`)}
        >
          Kill
        </button>
      </div>

      <div style={{ marginBottom: 6, color: '#9ab' }}>All slots</div>
      <div style={{ marginBottom: 8 }}>
        <button type="button" style={btnStyle} onClick={() => void postAdmin('/drones/offline-all')}>
          Offline all
        </button>
        <button type="button" style={btnStyle} onClick={() => void postAdmin('/drones/relaunch-all')}>
          Relaunch all
        </button>
        <button type="button" style={btnStyle} onClick={() => void postAdmin('/drones/kill-all')}>
          Kill all
        </button>
      </div>

      {actionNote ? (
        <div style={{ fontSize: 11, color: '#8a8', wordBreak: 'break-all' }}>Admin: {actionNote}</div>
      ) : null}

      <div style={{ marginTop: 14, fontSize: 10, color: '#678', lineHeight: 1.4 }}>
        Backend sets DRONE_FLAG_OFFLINE at random; empty slots use id=0 until the sim spawns a new drone.
        Relaunch clears offline or fills an empty slot immediately. Kill clears id=0 for reassignment.
      </div>
    </aside>
  )
}
