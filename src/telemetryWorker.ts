import { SAB_BYTES } from './telemetryConstants'

type InitMsg = { type: 'init'; url: string; buffer: SharedArrayBuffer }

export type WsStatusMsg = {
  type: 'ws-status'
  status: 'connecting' | 'open' | 'closed' | 'error'
}

self.onmessage = (ev: MessageEvent<InitMsg>) => {
  const msg = ev.data
  if (msg.type !== 'init') return

  const sab = msg.buffer
  if (sab.byteLength !== SAB_BYTES) {
    console.error(`telemetryWorker: expected SAB ${SAB_BYTES} B, got ${sab.byteLength}`)
    return
  }

  const u8 = new Uint8Array(sab)

  const postStatus = (status: WsStatusMsg['status']) => {
    const payload: WsStatusMsg = { type: 'ws-status', status }
    self.postMessage(payload)
  }

  const connect = () => {
    postStatus('connecting')
    const ws = new WebSocket(msg.url)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => postStatus('open')

    ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const data = event.data
      if (data.byteLength !== SAB_BYTES) {
        console.warn(`telemetryWorker: bad frame ${data.byteLength} B`)
        return
      }
      // ARCHITECTURE NOTE: We copy the frame with Uint8Array#set instead of per-field DataView reads because:
      // (1) One bulk memcpy avoids allocating JS objects per drone and starving the GC at 60 Hz × 10k fields.
      // (2) The main thread + GPU read the same interleaved layout; the worker only moves bytes.
      // Endianness matches the server (little-endian) byte-for-byte.
      u8.set(new Uint8Array(data))
    }

    ws.onerror = () => {
      console.error('telemetryWorker: WebSocket error')
      postStatus('error')
    }

    ws.onclose = () => {
      postStatus('closed')
      setTimeout(connect, 1200)
    }
  }

  connect()
}
