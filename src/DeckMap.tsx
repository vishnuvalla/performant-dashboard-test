import { useMemo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import type { DeckGLRef } from '@deck.gl/react'
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers'
import { COORDINATE_SYSTEM, OrthographicView } from '@deck.gl/core'
import type { Color, OrthographicViewState, PickingInfo, Position } from '@deck.gl/core'
import { DRONE_FLAG_OFFLINE, INSTANCE_COUNT, RECORD_BYTES } from './telemetryConstants'

/** Floats per interleaved record (`RECORD_BYTES / 4`). */
const STRIDE_FLOATS = RECORD_BYTES / 4

export type DeckMapProps = {
  sharedBuffer: SharedArrayBuffer
  /** Bumps when the worker copies a new telemetry frame into the SAB (coalesced to one React update per animation frame). */
  telemetryRevision: number
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
 * `FastScatterplotLayer` disables fp64 for positions (v9 removed the `fp64` prop). We intentionally avoid binary
 * `data.attributes.getPosition` here: that path regressed to **no visible dots** despite valid buffer + projection
 * (deck/luma attribute upload). Accessors use shared `Float32Array` / `Uint32Array` views over the SAB (no per-index
 * `DataView`) and Deck’s `target` scratch arrays where supported to cut allocations. Colors/radius still need JS
 * (flags are not RGBA; selection is React state).
 */
class FastScatterplotLayer extends ScatterplotLayer {
  static override layerName = 'FastScatterplotLayer'

  override use64bitPositions(): boolean {
    return false
  }
}

export default function DeckMap({
  sharedBuffer,
  telemetryRevision,
  onSelectDrone,
  selectedRecordIndex,
  missionTargetMode = false,
  onMissionTarget,
}: DeckMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const deckRef = useRef<DeckGLRef>(null)
  const [viewState, setViewState] = useState<OrthographicViewState>({
    target: [0, 0, 0],
    zoom: fitOrthographicZoom(600),
    minZoom: -10,
    maxZoom: 12,
  })
  const [deckPx, setDeckPx] = useState({ w: 0, h: 0 })
  const didFitZoomRef = useRef(false)

  const sabViews = useMemo(
    () => ({
      f32: new Float32Array(sharedBuffer),
      u32: new Uint32Array(sharedBuffer),
    }),
    [sharedBuffer],
  )

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
      new FastScatterplotLayer({
        id: 'drone-layer',
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        data: { length: INSTANCE_COUNT },
        getPosition: (_d, { index, target }) => {
          const b = index * STRIDE_FLOATS
          const { f32 } = sabViews
          target[0] = f32[b + 1]
          target[1] = f32[b + 2]
          target[2] = 0
          return target as unknown as Position
        },
        parameters: {
          depthWriteEnabled: false,
          depthCompare: 'always',
        },
        radiusUnits: 'pixels',
        radiusMinPixels: 0,
        radiusMaxPixels: 5,
        getRadius: (_d, { index }) => {
          const id = sabViews.u32[index * STRIDE_FLOATS + 0]
          if (id === 0) return 0
          const selected = selectedRecordIndex !== null && index === selectedRecordIndex
          return selected ? 5 : 3
        },
        getFillColor: (_d, { index, target }) => {
          const id = sabViews.u32[index * STRIDE_FLOATS + 0]
          if (id === 0) {
            target[0] = 0
            target[1] = 0
            target[2] = 0
            target[3] = 0
            return target as unknown as Color
          }
          const flags = sabViews.u32[index * STRIDE_FLOATS + 4]
          const offline = (flags & DRONE_FLAG_OFFLINE) !== 0
          const selected = selectedRecordIndex !== null && index === selectedRecordIndex
          if (selected) {
            if (offline) {
              target[0] = 255
              target[1] = 180
              target[2] = 100
              target[3] = 191
            } else {
              target[0] = 255
              target[1] = 200
              target[2] = 80
              target[3] = 242
            }
          } else if (offline) {
            target[0] = 140
            target[1] = 150
            target[2] = 160
            target[3] = 115
          } else {
            target[0] = 80
            target[1] = 200
            target[2] = 255
            target[3] = 191
          }
          return target as unknown as Color
        },
        stroked: false,
        pickable: true,
        updateTriggers: {
          getPosition: [telemetryRevision],
          getRadius: [telemetryRevision, selectedRecordIndex],
          getFillColor: [telemetryRevision, selectedRecordIndex],
        },
      }),
    ],
    [gridPaths, sabViews, selectedRecordIndex, telemetryRevision],
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
        const id = sabViews.u32[info.index * STRIDE_FLOATS + 0]
        if (id !== 0) {
          onSelectDrone(id, info.index)
        }
      }
    },
    [sabViews.u32, onSelectDrone, missionTargetMode, onMissionTarget],
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
