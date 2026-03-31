/** Shared wire + SAB layout — must match server.js interleaved record layout. */
export const RECORD_BYTES = 20
export const INSTANCE_COUNT = 10_000
export const SAB_BYTES = RECORD_BYTES * INSTANCE_COUNT

/** Byte offsets within each record (little-endian). */
export const OFF_ID = 0
export const OFF_X = 4
export const OFF_Y = 8
export const OFF_ALT = 12
export const OFF_FLAGS = 16

/** `flags` field: bit 0 = telemetry frozen / “offline” (id must be non-zero). */
export const DRONE_FLAG_OFFLINE = 1

/** uint32 id === 0 means empty slot (killed / not yet assigned). */
