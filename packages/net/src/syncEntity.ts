import type { ECSWorld } from '@xip/core'
import { PEER_JOIN_TYPE, PEER_LEAVE_TYPE, type Room, type NetMessage } from './room'

export interface SyncConfig {
  /** Numeric ECS entity id to synchronise. */
  entityId: number
  /** Component `type` strings whose data should be included in each state message. */
  components: string[]
  room: Room
  /**
   * `true`  — this peer owns the entity and sends authoritative state.
   * `false` — this peer is a receiver and applies remote state locally.
   */
  owner: boolean
  /** Sends per second when `owner` is true (default 20). */
  tickRate?: number
  /** Reference to the ECS world. Typed as `any` for peer-dep compatibility. */
  world: ECSWorld
}

const SYNC_MSG_TYPE = 'entity:state'
// A sender's seq that falls this far below the last applied one restarted its counter (a new Room).
// Smaller drops are reordered packets on an unordered channel and are still dropped.
const SEQ_RESTART_GAP = 100

/**
 * syncEntity — keeps a single ECS entity in sync across peers.
 *
 * Owner peers read component data from the world and broadcast only fields
 * that have changed since the last send (delta sync). Non-owner peers listen
 * for incoming state and apply it via shallow merge.
 */
export function syncEntity(config: SyncConfig): {
  start(): void
  stop(): void
  applyRemoteState(msg: NetMessage): void
} {
  const { entityId, components, room, owner, world } = config
  const tickRate = config.tickRate ?? 20
  const intervalMs = 1000 / tickRate

  let intervalId: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null

  // Per-component JSON cache for delta detection — only changed fields are sent.
  const lastSent = new Map<string, string>()

  // Highest applied `seq` per sender — guards against an out-of-order or
  // duplicate packet (common over unreliable/unordered WebRTC channels)
  // overwriting newer state with stale data.
  const lastAppliedSeq = new Map<string, number>()

  // Peers seen at the last owner tick. A peer that is new since then has none of the unchanged state.
  let knownPeers = new Set<string>()

  function buildDeltaPayload(): Record<string, unknown> | null {
    const delta: Record<string, unknown> = { entityId }
    let hasChanges = false

    for (const compType of components) {
      const comp = world.getComponent(entityId, compType)
      if (comp === undefined) continue
      const json = JSON.stringify(comp)
      if (json !== lastSent.get(compType)) {
        delta[compType] = comp
        lastSent.set(compType, json)
        hasChanges = true
      }
    }

    return hasChanges ? delta : null
  }

  function applyRemoteState(msg: NetMessage): void {
    // A sender that left or rejoined may have restarted its seq counter.
    if ((msg.type === PEER_JOIN_TYPE || msg.type === PEER_LEAVE_TYPE) && msg.peerId !== undefined) {
      lastAppliedSeq.delete(msg.peerId)
      return
    }
    if (msg.type !== SYNC_MSG_TYPE) return
    const payload = msg.payload as Record<string, unknown>
    if (payload.entityId !== entityId) return

    if (msg.seq !== undefined) {
      const sender = msg.peerId ?? ''
      const last = lastAppliedSeq.get(sender)
      const restarted = last !== undefined && last - msg.seq > SEQ_RESTART_GAP
      if (last !== undefined && !restarted && msg.seq <= last) return // stale or duplicate — drop
      lastAppliedSeq.set(sender, msg.seq)
    }

    for (const compType of components) {
      const incoming = payload[compType]
      if (incoming === undefined) continue
      const existing = world.getComponent(entityId, compType)
      if (existing !== undefined) {
        // Shallow-merge incoming fields onto the existing component object so
        // that the ECS index remains valid (same object reference).
        Object.assign(existing, incoming)
      }
    }
  }

  return {
    start(): void {
      if (owner) {
        intervalId = setInterval(() => {
          if (!room.isConnected) {
            lastSent.clear() // after a reconnect the receiver may have missed everything
            return
          }
          const peers = room.peers ?? []
          for (const peerId of peers) {
            if (!knownPeers.has(peerId)) lastSent.clear()
          }
          knownPeers = new Set(peers)
          const payload = buildDeltaPayload()
          if (payload === null) return // nothing changed this tick
          room.broadcast({ type: SYNC_MSG_TYPE, payload })
        }, intervalMs)
      } else {
        const handler = (msg: NetMessage) => applyRemoteState(msg)
        unsubscribe = room.onMessage(handler)
      }
    },

    stop(): void {
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      lastSent.clear()
      lastAppliedSeq.clear()
    },

    applyRemoteState,
  }
}
