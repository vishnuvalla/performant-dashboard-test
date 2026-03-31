import { useMemo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import type { DeckGLRef } from '@deck.gl/react'
import { PathLayer } from '@deck.gl/layers'
import { COORDINATE_SYSTEM, OrthographicView } from '@deck.gl/core'
import type { OrthographicViewState, PickingInfo } from '@deck.gl/core'
import {
  DRONE_FLAG_OFFLINE,
  INSTANCE_COUNT,
  RECORD_BYTES,
  SAB_BYTES,
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
 * PathLayer grid (WebGL) + Canvas 2D dots projected with the same viewport as Deck.
 * ScatterplotLayer binary/fp64 paths failed to draw reliably; overlay uses viewport.project() for parity with the grid.
 */
const DOT_COLOR = 'rgba(80,200,255,0.75)'
const OFFLINE_DOT_COLOR = 'rgba(140,150,160,0.45)'
const SELECTED_DOT_COLOR = 'rgba(255,200,80,0.95)'
const SELECTED_OFFLINE_DOT_COLOR = 'rgba(255,180,100,0.75)'

const STRIDE_U32 = RECORD_BYTES / 4

export default function DeckMap({
  sharedBuffer,
  onSelectDrone,
  selectedRecordIndex,
  missionTargetMode = false,
  onMissionTarget,
}: DeckMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const deckRef = useRef<DeckGLRef>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [viewState, setViewState] = useState<OrthographicViewState>({
    target: [0, 0, 0],
    zoom: fitOrthographicZoom(600),
    minZoom: -10,
    maxZoom: 12,
  })
  const [deckPx, setDeckPx] = useState({ w: 0, h: 0 })
  const didFitZoomRef = useRef(false)

  const positionStrideView = useMemo(
    () => new Float32Array(sharedBuffer, 0, SAB_BYTES / 4),
    [sharedBuffer],
  )

  const u32StrideView = useMemo(
    () => new Uint32Array(sharedBuffer, 0, SAB_BYTES / 4),
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

  useEffect(() => {
    let raf = 0
    const loop = () => {
      const deck = deckRef.current?.deck
      const canvas = overlayRef.current
      // Deck.getViewports() asserts viewManager — null until first Deck render completes.
      if (deck?.isInitialized && canvas && deckPx.w > 0 && deckPx.h > 0) {
        canvas.width = deckPx.w
        canvas.height = deckPx.h
        const vps = deck.getViewports()
        const vp = vps[0]
        if (vp) {
            const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            const f32 = positionStrideView
            const u32 = u32StrideView
            for (let i = 0; i < INSTANCE_COUNT; i++) {
              const base = i * STRIDE_U32
              const id = u32[base + 0]
              if (id === 0) continue
              const flags = u32[base + 4]
              const offline = (flags & DRONE_FLAG_OFFLINE) !== 0
              const wx = f32[base + 1]
              const wy = f32[base + 2]
              const p = vp.project([wx, wy, 0])
              const px = p[0]
              const py = p[1]
              if (px >= -4 && px <= canvas.width + 4 && py >= -4 && py <= canvas.height + 4) {
                const selected = selectedRecordIndex !== null && i === selectedRecordIndex
                if (selected) {
                  ctx.fillStyle = offline ? SELECTED_OFFLINE_DOT_COLOR : SELECTED_DOT_COLOR
                } else {
                  ctx.fillStyle = offline ? OFFLINE_DOT_COLOR : DOT_COLOR
                }
                const half = selected ? 2.5 : 1.5
                ctx.fillRect(px - half, py - half, half * 2, half * 2)
              }
            }
          }
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [positionStrideView, u32StrideView, deckPx.w, deckPx.h, selectedRecordIndex])

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
    ],
    [gridPaths],
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

      let best = -1
      let bestD = 144
      const f32 = positionStrideView
      const u32 = u32StrideView
      for (let i = 0; i < INSTANCE_COUNT; i++) {
        const base = i * STRIDE_U32
        if (u32[base + 0] === 0) continue
        const wx = f32[base + 1]
        const wy = f32[base + 2]
        const p = vp.project([wx, wy, 0])
        const dx = p[0] - x
        const dy = p[1] - y
        const d = dx * dx + dy * dy
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (best >= 0) {
        const dv = new DataView(sharedBuffer)
        const id = dv.getUint32(best * RECORD_BYTES, true)
        onSelectDrone(id, best)
      }
    },
    [
      positionStrideView,
      u32StrideView,
      sharedBuffer,
      onSelectDrone,
      missionTargetMode,
      onMissionTarget,
    ],
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
      <canvas
        ref={overlayRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          zIndex: 1,
          width: deckPx.w > 0 ? deckPx.w : '100%',
          height: deckPx.h > 0 ? deckPx.h : '100%',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
