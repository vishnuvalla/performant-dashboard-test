import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DeckMap from './DeckMap'
import Sidebar from './Sidebar'
import { SAB_BYTES } from './telemetryConstants'
import type { WorkerToMainMsg, WsStatusMsg } from './telemetryWorker'

const adminBase = () => import.meta.env.VITE_ADMIN_URL ?? 'http://127.0.0.1:8081'

export default function App() {
  const [selectedDroneId, setSelectedDroneId] = useState<number | null>(null)
  const [selectedRecordIndex, setSelectedRecordIndex] = useState<number | null>(null)
  const [selectingMissionTarget, setSelectingMissionTarget] = useState(false)
  const [wsStatus, setWsStatus] = useState<WsStatusMsg['status']>('connecting')
  const [telemetryRevision, setTelemetryRevision] = useState(0)

  const sharedBuffer = useMemo(() => new SharedArrayBuffer(SAB_BYTES), [])

  const telemetryRevRef = useRef(0)
  const telemetryRafScheduledRef = useRef(false)

  const onSelectDrone = useCallback((id: number, index: number) => {
    setSelectedDroneId(id)
    setSelectedRecordIndex(index)
  }, [])

  const onMissionTargetWorld = useCallback(async (wx: number, wy: number) => {
    if (selectedRecordIndex == null) return
    setSelectingMissionTarget(false)
    try {
      const res = await fetch(`${adminBase()}/drone/${selectedRecordIndex}/mission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: wx, y: wy }),
      })
      if (!res.ok) console.warn('mission POST', res.status, await res.text())
    } catch (e) {
      console.error('mission POST', e)
    }
  }, [selectedRecordIndex])

  useEffect(() => {
    if (selectedRecordIndex == null) setSelectingMissionTarget(false)
  }, [selectedRecordIndex])

  useEffect(() => {
    // 127.0.0.1 avoids localhost → ::1 / IPv4 mismatches and works more reliably in embedded preview tabs.
    const url = import.meta.env.VITE_WS_URL ?? 'ws://127.0.0.1:8080'

    const worker = new Worker(new URL('./telemetryWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<WorkerToMainMsg>) => {
      const d = e.data
      if (d.type === 'ws-status') {
        setWsStatus(d.status)
        return
      }
      if (d.type === 'telemetry-frame') {
        telemetryRevRef.current = (telemetryRevRef.current + 1) & 0xfffffff
        if (!telemetryRafScheduledRef.current) {
          telemetryRafScheduledRef.current = true
          requestAnimationFrame(() => {
            telemetryRafScheduledRef.current = false
            setTelemetryRevision(telemetryRevRef.current)
          })
        }
      }
    }
    worker.postMessage({ type: 'init', url, buffer: sharedBuffer })

    return () => worker.terminate()
  }, [sharedBuffer])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      <div
        style={{
          flexShrink: 0,
          padding: '6px 12px',
          fontSize: 12,
          fontFamily: 'ui-monospace, monospace',
          background: wsStatus === 'open' ? '#0d2818' : '#301010',
          color: '#ddd',
          borderBottom: '1px solid #223',
        }}
      >
        Telemetry WS: {wsStatus}
        {wsStatus !== 'open'
          ? ' — npm run dev starts the server on 8080, or run npm run dev:server separately'
          : ''}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <DeckMap
          sharedBuffer={sharedBuffer}
          telemetryRevision={telemetryRevision}
          onSelectDrone={onSelectDrone}
          selectedRecordIndex={selectedRecordIndex}
          missionTargetMode={selectingMissionTarget}
          onMissionTarget={onMissionTargetWorld}
        />
        <Sidebar
          sharedBuffer={sharedBuffer}
          selectedDroneId={selectedDroneId}
          selectedRecordIndex={selectedRecordIndex}
          selectingMissionTarget={selectingMissionTarget}
          onToggleMissionTarget={() => setSelectingMissionTarget((v) => !v)}
        />
      </div>
    </div>
  )
}
