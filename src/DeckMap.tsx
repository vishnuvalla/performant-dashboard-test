import { useMemo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import type { DeckGLRef } from '@deck.gl/react'
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers'
import { COORDINATE_SYSTEM, OrthographicView } from '@deck.gl/core'
import type { OrthographicViewState, PickingInfo } from '@deck.gl/core'
import {
  DRONE_FLAG_OFFLINE,
  INSTANCE_COUNT,
  OFF_FLAGS,
  OFF_ID,
  OFF_X,
  OFF_Y,
  RECORD_BYTES,
} from './telemetryConstants'

export type DeckMapProps = {
  sharedBuffer: SharedArrayBuffer
  onSelectDrone: (droneId: number, recordIndex: number) => void
  selectedRecordIndex: number | null
  /** When true, the next map click sets a mission target (world xy) instead of selecting a drone. */
  missionTargetMode?: boolean
  onMissionTarget?: (worldX: number, worldY: number) => void
}

/** Half-width/height of sim space (server clamps positions ~±950). */
const WORLD_HALF_EXTENT = 1000

const GRID_STEP = 200

const orthoView = new OrthographicView({
  id: 'ortho',
  flipY: false,
})

function fitOrthographicZoom(minViewportPx: number): number {
  if (minViewportPx < 32) return -2
  return Math.log2(minViewportPx / (2 * WORLD_HALF_EXTENT))
}

/**
 * PathLayer grid + ScatterplotLayer: positions use `getPosition` (not binary attributes on the interleaved SAB).
 * Deck’s fp64 path lays out `instancePositions64Low` 12 bytes after xyz — same offset as our `OFF_FLAGS` (byte 16).
 * Binary `getPosition` on that buffer therefore fed flags/next-id bytes as “low” components; accessors read x,y and
 * force z=0 so depth matches the grid plane. `telemetryFrame` still invalidates positions when the worker mutates SAB.
 */
export default function DeckMap({
  sharedBuffer,
  onSelectDrone,
  selectedRecordIndex,
  missionTargetMode = false,
  onMissionTarget,
}: DeckMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const deckRef = useRef<DeckGLRef>(null)
  const [telemetryFrame, setTelemetryFrame] = useState(0)
  const [viewState, setViewState] = useState<OrthographicViewState>({
    target: [0, 0, 0],
    zoom: fitOrthographicZoom(600),
    minZoom: -10,
    maxZoom: 12,
  })
  const [deckPx, setDeckPx] = useState({ w: 0, h: 0 })
  const didFitZoomRef = useRef(false)

  const gridPaths = useMemo(() => {
    const out: { path: [number, number, number][] }[] = []
    for (let x = -WORLD_HALF_EXTENT; x <= WORLD_HALF_EXTENT; x += GRID_STEP) {
      out.push({
        path: [
          [x, -WORLD_HALF_EXTENT, 0],
          [x, WORLD_HALF_EXTENT, 0],
        ],
      })
    }
    for (let y = -WORLD_HALF_EXTENT; y <= WORLD_HALF_EXTENT; y += GRID_STEP) {
      out.push({
        path: [
          [-WORLD_HALF_EXTENT, y, 0],
          [WORLD_HALF_EXTENT, y, 0],
        ],
      })
    }
    return out
  }, [])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      const w = Math.round(r.width)
      const h = Math.round(r.height)
      if (w <= 0 || h <= 0) return
      setDeckPx({ w, h })
      if (!didFitZoomRef.current && w >= 32 && h >= 32) {
        didFitZoomRef.current = true
        const z = fitOrthographicZoom(Math.min(w, h))
        setViewState((prev) => ({ ...prev, zoom: z }))
      }
    }
    measure()
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let raf = 0
    const loop = () => {
      setTelemetryFrame((n) => (n + 1) & 0xfffffff)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const layers = useMemo(
    () => [
      new PathLayer({
        id: 'world-grid',
        data: gridPaths,
        getPath: (d: { path: [number, number, number][] }) => d.path,
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        getColor: [55, 75, 100, 200],
        getWidth: 1,
        widthUnits: 'pixels',
        capRounded: true,
        pickable: false,
      }),
      new ScatterplotLayer({
        id: 'drone-layer',
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        data: { length: INSTANCE_COUNT },
        getPosition: (_d, { index }) => {
          const o = index * RECORD_BYTES
          const dv = new DataView(sharedBuffer, o, RECORD_BYTES)
          return [
            dv.getFloat32(OFF_X, true),
            dv.getFloat32(OFF_Y, true),
            0,
          ]
        },
        parameters: {
          depthWriteEnabled: false,
          depthCompare: 'always',
        },
        radiusUnits: 'pixels',
        radiusMinPixels: 0,
        radiusMaxPixels: 5,
        getRadius: (_d, { index }) => {
          const id = new DataView(sharedBuffer, index * RECORD_BYTES + OFF_ID, 4).getUint32(0, true)
          if (id === 0) return 0
          const selected = selectedRecordIndex !== null && index === selectedRecordIndex
          return selected ? 5 : 3
        },
        getFillColor: (_d, { index }) => {
          const base = index * RECORD_BYTES
          const dv = new DataView(sharedBuffer, base, RECORD_BYTES)
          const id = dv.getUint32(OFF_ID, true)
          if (id === 0) return [0, 0, 0, 0]
          const flags = dv.getUint32(OFF_FLAGS, true)
          const offline = (flags & DRONE_FLAG_OFFLINE) !== 0
          const selected = selectedRecordIndex !== null && index === selectedRecordIndex
          if (selected) {
            return offline ? [255, 180, 100, 191] : [255, 200, 80, 242]
          }
          return offline ? [140, 150, 160, 115] : [80, 200, 255, 191]
        },
        stroked: false,
        pickable: true,
        updateTriggers: {
          getPosition: [telemetryFrame],
          getRadius: [telemetryFrame, selectedRecordIndex],
          getFillColor: [telemetryFrame, selectedRecordIndex],
        },
      }),
    ],
    [gridPaths, sharedBuffer, selectedRecordIndex, telemetryFrame],
  )

  const handleDeckClick = useCallback(
    (info: PickingInfo) => {
      const deck = deckRef.current?.deck
      if (!deck?.isInitialized) return
      const vp = deck.getViewports()[0]
      if (!vp) return
      const x = info.x
      const y = info.y

      if (missionTargetMode && onMissionTarget) {
        const world = vp.unproject([x, y, 0])
        if (world) {
          onMissionTarget(world[0], world[1])
        }
        return
      }

      if (info.layer?.id === 'drone-layer' && typeof info.index === 'number' && info.index >= 0) {
        const id = new DataView(sharedBuffer, info.index * RECORD_BYTES + OFF_ID, 4).getUint32(0, true)
        if (id !== 0) {
          onSelectDrone(id, info.index)
        }
      }
    },
    [sharedBuffer, onSelectDrone, missionTargetMode, onMissionTarget],
  )

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        background: '#0a0f14',
        cursor: missionTargetMode ? 'crosshair' : 'default',
      }}
    >
      {missionTargetMode ? (
        <div
          style={{
            position: 'absolute',
            left: 8,
            top: 8,
            zIndex: 2,
            padding: '6px 10px',
            fontSize: 12,
            fontFamily: 'ui-monospace, monospace',
            background: 'rgba(40,80,120,0.92)',
            color: '#e8f4ff',
            border: '1px solid #6af',
            borderRadius: 4,
            pointerEvents: 'none',
          }}
        >
          Click map to set mission target (xy)
        </div>
      ) : null}
      <DeckGL
        ref={deckRef}
        layers={layers}
        views={orthoView}
        viewState={viewState}
        onViewStateChange={({ viewState: vs }) => setViewState(vs as OrthographicViewState)}
        width={deckPx.w > 0 ? deckPx.w : '100%'}
        height={deckPx.h > 0 ? deckPx.h : '100%'}
        controller
        style={{ width: '100%', height: '100%' }}
        onClick={handleDeckClick}
      />
    </div>
  )
}
