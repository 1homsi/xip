import type { NetTransport } from './transport'

export interface NetMessage {
  type: string
  payload: unknown
  /** Originating peer identifier (set by the server/relay). */
  peerId?: string
  /** Optional simulation tick the message is associated with. */
  tick?: number
  /** Auto-stamped outbound sequence number for ordering detection. */
  seq?: number
}

export interface RoomConfig {
  transport: NetTransport
  /** Called for every message that arrives from a remote peer. */
  onPeerMessage?: (peerId: string, msg: NetMessage) => void
  /** Called when a peer joins (extracted from `peer:join` server messages). */
  onPeerJoin?: (peerId: string) => void
  /** Called when a peer leaves (extracted from `peer:leave` server messages). */
  onPeerLeave?: (peerId: string) => void
}

const PING_MSG_TYPE = 'room:ping'
const PONG_MSG_TYPE = 'room:pong'
export const PEER_JOIN_TYPE = 'peer:join'
export const PEER_LEAVE_TYPE = 'peer:leave'

/** Pending pings older than this are dropped as lost — bounds memory when a pong never arrives. */
const PING_TIMEOUT_MS = 10_000

/**
 * Room — multiplayer session layer.
 *
 * Wraps a NetTransport to provide:
 * - Structured NetMessage send/receive (JSON on the wire)
 * - Auto-incrementing sequence numbers on every outbound message
 * - Ping / RTT measurement via `ping()` and `latencyMs`
 * - Peer presence tracking via `peers`, `onPeerJoin`, and `onPeerLeave`
 */
export class Room {
  private readonly _transport: NetTransport
  private readonly _onPeerMessage?: (peerId: string, msg: NetMessage) => void
  private readonly _onPeerJoin?: (peerId: string) => void
  private readonly _onPeerLeave?: (peerId: string) => void
  private _connected = false
  private _messageHandlers: Array<(msg: NetMessage) => void> = []
  private _seq = 0
  private _latencyMs = 0
  private _pendingPings = new Map<string, number>()

  /** Set of currently connected peer IDs populated from `peer:join` / `peer:leave` messages. */
  readonly peers = new Set<string>()

  constructor(config: RoomConfig) {
    this._transport = config.transport
    this._onPeerMessage = config.onPeerMessage
    this._onPeerJoin = config.onPeerJoin
    this._onPeerLeave = config.onPeerLeave

    this._transport.onConnect(() => {
      this._connected = true
    })

    this._transport.onDisconnect(() => {
      this._connected = false
      this._pendingPings.clear()

      // Peer presence is only known via `peer:join`/`peer:leave` from the
      // server; once disconnected, stale entries would otherwise linger
      // until the server re-announces peers after reconnect.
      if (this.peers.size > 0) {
        const stalePeers = [...this.peers]
        this.peers.clear()
        for (const peerId of stalePeers) this._onPeerLeave?.(peerId)
      }
    })

    this._transport.onMessage((raw: string) => {
      let msg: NetMessage
      try {
        msg = JSON.parse(raw) as NetMessage
      } catch {
        return // Ignore malformed frames.
      }

      // Handle internal pong — RTT measurement, not forwarded to handlers.
      if (msg.type === PONG_MSG_TYPE) {
        const id = msg.payload as string
        const sent = this._pendingPings.get(id)
        if (sent !== undefined) {
          this._latencyMs = performance.now() - sent
          this._pendingPings.delete(id)
        }
        return
      }

      // Handle peer presence events.
      if (msg.type === PEER_JOIN_TYPE && msg.peerId) {
        this.peers.add(msg.peerId)
        this._onPeerJoin?.(msg.peerId)
      } else if (msg.type === PEER_LEAVE_TYPE && msg.peerId) {
        this.peers.delete(msg.peerId)
        this._onPeerLeave?.(msg.peerId)
      }

      if (msg.peerId !== undefined && this._onPeerMessage) {
        this._onPeerMessage(msg.peerId, msg)
      }

      for (const h of this._messageHandlers) h(msg)
    })
  }

  /** Open the underlying transport connection. */
  connect(): void {
    // Transport connections are typically opened at construction time (e.g.
    // WebSocket). This method exists as a hook for transports that are lazy.
  }

  /** Close the underlying transport connection. */
  disconnect(): void {
    this._transport.close()
  }

  /** Send a structured message. Stamps an auto-incrementing `seq` number. */
  send(msg: NetMessage): void {
    this._transport.send(JSON.stringify({ ...msg, seq: this._seq++ }))
  }

  /**
   * Broadcast a message to all peers via the server/relay.
   * Equivalent to `send` in a client-server topology.
   */
  broadcast(msg: NetMessage): void {
    this.send(msg)
  }

  /**
   * Send a ping and measure round-trip time.
   * After the server responds with a pong, `latencyMs` is updated.
   */
  ping(): void {
    if (!this._connected) return

    // Prune pings whose pong never arrived (e.g. dropped over an unreliable
    // transport) so `_pendingPings` doesn't grow unbounded.
    const now = performance.now()
    for (const [id, sentAt] of this._pendingPings) {
      if (now - sentAt > PING_TIMEOUT_MS) this._pendingPings.delete(id)
    }

    const id = `${Date.now()}-${Math.random()}`
    this._pendingPings.set(id, now)
    this.send({ type: PING_MSG_TYPE, payload: id })
  }

  /**
   * Register a handler that receives every inbound NetMessage.
   * Returns an unsubscribe function — call it to remove the handler.
   */
  onMessage(handler: (msg: NetMessage) => void): () => void {
    this._messageHandlers.push(handler)
    return () => {
      const i = this._messageHandlers.indexOf(handler)
      if (i !== -1) this._messageHandlers.splice(i, 1)
    }
  }

  /** Latest measured round-trip time in milliseconds. 0 until the first ping completes. */
  get latencyMs(): number {
    return this._latencyMs
  }

  get isConnected(): boolean {
    return this._connected
  }
}
