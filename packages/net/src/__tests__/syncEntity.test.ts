import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { syncEntity } from '../syncEntity'
import type { NetMessage, Room } from '../room'

describe('syncEntity', () => {
  let room: Pick<Room, 'isConnected' | 'broadcast' | 'onMessage'>
  let handlers: Array<(msg: NetMessage) => void>
  let world: {
    getComponent: ReturnType<typeof vi.fn>
  }
  let connected: boolean

  beforeEach(() => {
    vi.useFakeTimers()
    handlers = []
    connected = true
    room = {
      get isConnected() {
        return connected
      },
      broadcast: vi.fn(),
      onMessage: vi.fn((handler: (msg: NetMessage) => void) => {
        handlers.push(handler)
        return () => {
          const i = handlers.indexOf(handler)
          if (i !== -1) handlers.splice(i, 1)
        }
      }),
    }
    world = {
      getComponent: vi.fn(),
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('broadcasts owner state at the configured tick rate', () => {
    world.getComponent.mockImplementation((_entityId: number, type: string) => {
      if (type === 'Transform') return { x: 10, y: 20 }
      if (type === 'Health') return { hp: 5 }
      return undefined
    })

    const sync = syncEntity({
      entityId: 7,
      components: ['Transform', 'Health', 'Missing'],
      room: room as Room,
      owner: true,
      tickRate: 2,
      world: world as never,
    })

    sync.start()
    vi.advanceTimersByTime(500)

    expect(room.broadcast).toHaveBeenCalledWith({
      type: 'entity:state',
      payload: {
        entityId: 7,
        Transform: { x: 10, y: 20 },
        Health: { hp: 5 },
      },
    })
  })

  it('does not broadcast when the room is disconnected', () => {
    connected = false
    const sync = syncEntity({
      entityId: 1,
      components: ['Transform'],
      room: room as Room,
      owner: true,
      tickRate: 20,
      world: world as never,
    })

    sync.start()
    vi.advanceTimersByTime(100)

    expect(room.broadcast).not.toHaveBeenCalled()
  })

  it('stops owner broadcasting after stop is called', () => {
    const sync = syncEntity({
      entityId: 1,
      components: ['Transform'],
      room: room as Room,
      owner: true,
      tickRate: 10,
      world: world as never,
    })

    sync.start()
    sync.stop()
    vi.advanceTimersByTime(500)

    expect(room.broadcast).not.toHaveBeenCalled()
  })

  it('registers an onMessage handler for non-owner peers', () => {
    const sync = syncEntity({
      entityId: 9,
      components: ['Transform'],
      room: room as Room,
      owner: false,
      world: world as never,
    })

    sync.start()

    expect(room.onMessage).toHaveBeenCalledTimes(1)
    expect(handlers).toHaveLength(1)
    expect(typeof handlers[0]).toBe('function')
  })

  it('shallow merges remote state onto existing components', () => {
    const transform = { x: 1, y: 2, z: 3 }
    world.getComponent.mockImplementation((_entityId: number, type: string) => {
      if (type === 'Transform') return transform
      return undefined
    })

    const sync = syncEntity({
      entityId: 5,
      components: ['Transform'],
      room: room as Room,
      owner: false,
      world: world as never,
    })

    sync.applyRemoteState({
      type: 'entity:state',
      payload: { entityId: 5, Transform: { x: 10 } },
    })

    expect(transform).toEqual({ x: 10, y: 2, z: 3 })
  })

  it('ignores remote state with the wrong message type', () => {
    const existing = { hp: 10 }
    world.getComponent.mockReturnValue(existing)
    const sync = syncEntity({
      entityId: 5,
      components: ['Health'],
      room: room as Room,
      owner: false,
      world: world as never,
    })

    sync.applyRemoteState({ type: 'other', payload: { entityId: 5, Health: { hp: 0 } } })

    expect(existing.hp).toBe(10)
  })

  it('ignores remote state for a different entity', () => {
    const existing = { hp: 10 }
    world.getComponent.mockReturnValue(existing)
    const sync = syncEntity({
      entityId: 5,
      components: ['Health'],
      room: room as Room,
      owner: false,
      world: world as never,
    })

    sync.applyRemoteState({
      type: 'entity:state',
      payload: { entityId: 6, Health: { hp: 0 } },
    })

    expect(existing.hp).toBe(10)
  })

  it('ignores incoming components that do not exist locally', () => {
    world.getComponent.mockReturnValue(undefined)
    const sync = syncEntity({
      entityId: 5,
      components: ['Health'],
      room: room as Room,
      owner: false,
      world: world as never,
    })

    expect(() =>
      sync.applyRemoteState({
        type: 'entity:state',
        payload: { entityId: 5, Health: { hp: 0 } },
      }),
    ).not.toThrow()
  })

  it('routes room messages through applyRemoteState for non-owners', () => {
    const existing = { hp: 10 }
    world.getComponent.mockReturnValue(existing)
    const sync = syncEntity({
      entityId: 5,
      components: ['Health'],
      room: room as Room,
      owner: false,
      world: world as never,
    })

    sync.start()
    handlers[0]({
      type: 'entity:state',
      payload: { entityId: 5, Health: { hp: 3 } },
    })

    expect(existing.hp).toBe(3)
  })

  it('delta sync: skips broadcast when nothing has changed', () => {
    const transform = { x: 10, y: 20 }
    world.getComponent.mockImplementation((_entityId: number, type: string) => {
      if (type === 'Transform') return transform
      return undefined
    })

    const sync = syncEntity({
      entityId: 1,
      components: ['Transform'],
      room: room as Room,
      owner: true,
      tickRate: 10,
      world: world as never,
    })

    sync.start()
    vi.advanceTimersByTime(100) // first tick — sends initial state
    expect(room.broadcast).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(100) // second tick — nothing changed, no broadcast
    expect(room.broadcast).toHaveBeenCalledTimes(1)

    transform.x = 99 // mutate in place
    vi.advanceTimersByTime(100) // third tick — changed, broadcasts
    expect(room.broadcast).toHaveBeenCalledTimes(2)
    const lastCall = (room.broadcast as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(lastCall.payload.Transform.x).toBe(99)
  })

  it('drops an out-of-order remote packet with a lower seq than the last applied one', () => {
    const health = { hp: 10 }
    world.getComponent.mockReturnValue(health)
    const sync = syncEntity({
      entityId: 5,
      components: ['Health'],
      room: room as Room,
      owner: false,
      world: world as never,
    })

    sync.applyRemoteState({ type: 'entity:state', seq: 3, payload: { entityId: 5, Health: { hp: 30 } } })
    expect(health.hp).toBe(30)

    sync.applyRemoteState({ type: 'entity:state', seq: 2, payload: { entityId: 5, Health: { hp: 20 } } })
    expect(health.hp).toBe(30) // stale packet — dropped

    sync.applyRemoteState({ type: 'entity:state', seq: 3, payload: { entityId: 5, Health: { hp: 99 } } })
    expect(health.hp).toBe(30) // duplicate seq — dropped

    sync.applyRemoteState({ type: 'entity:state', seq: 4, payload: { entityId: 5, Health: { hp: 40 } } })
    expect(health.hp).toBe(40) // newer packet — applied
  })

  it('sends a full snapshot again after the room reconnects', () => {
    const transform = { x: 1, y: 1 }
    world.getComponent.mockImplementation((_entityId: number, type: string) =>
      type === 'Transform' ? transform : undefined,
    )
    const sync = syncEntity({
      entityId: 3,
      components: ['Transform'],
      room: room as Room,
      owner: true,
      tickRate: 10,
      world: world as never,
    })

    sync.start()
    vi.advanceTimersByTime(100) // initial state
    vi.advanceTimersByTime(100) // unchanged, nothing sent
    expect(room.broadcast).toHaveBeenCalledTimes(1)

    connected = false
    vi.advanceTimersByTime(100)
    connected = true
    vi.advanceTimersByTime(100) // the receiver may have missed everything: send it all again
    expect(room.broadcast).toHaveBeenCalledTimes(2)
    expect((room.broadcast as ReturnType<typeof vi.fn>).mock.calls[1][0].payload.Transform).toEqual({ x: 1, y: 1 })
  })

  it('sends a full snapshot when a peer joins mid-session', () => {
    const transform = { x: 2, y: 2 }
    world.getComponent.mockImplementation((_entityId: number, type: string) =>
      type === 'Transform' ? transform : undefined,
    )
    const peers = new Set<string>(['p1'])
    ;(room as { peers?: Set<string> }).peers = peers
    const sync = syncEntity({
      entityId: 4,
      components: ['Transform'],
      room: room as Room,
      owner: true,
      tickRate: 10,
      world: world as never,
    })

    sync.start()
    vi.advanceTimersByTime(100)
    vi.advanceTimersByTime(100)
    expect(room.broadcast).toHaveBeenCalledTimes(1)

    peers.add('p2') // a late joiner has none of the unchanged state
    vi.advanceTimersByTime(100)
    expect(room.broadcast).toHaveBeenCalledTimes(2)
    expect((room.broadcast as ReturnType<typeof vi.fn>).mock.calls[1][0].payload.Transform).toEqual({ x: 2, y: 2 })
  })

  it('accepts a restarted sender after its peer:leave and peer:join', () => {
    const health = { hp: 10 }
    world.getComponent.mockReturnValue(health)
    const sync = syncEntity({
      entityId: 5,
      components: ['Health'],
      room: room as Room,
      owner: false,
      world: world as never,
    })

    sync.applyRemoteState({
      type: 'entity:state',
      seq: 500,
      peerId: 'owner',
      payload: { entityId: 5, Health: { hp: 50 } },
    })
    sync.applyRemoteState({ type: 'peer:leave', peerId: 'owner', payload: null })
    sync.applyRemoteState({ type: 'peer:join', peerId: 'owner', payload: null })
    sync.applyRemoteState({
      type: 'entity:state',
      seq: 1,
      peerId: 'owner',
      payload: { entityId: 5, Health: { hp: 15 } },
    })

    expect(health.hp).toBe(15)
  })

  it('accepts a seq that falls far below the last applied one, but still drops small reorders', () => {
    const health = { hp: 10 }
    world.getComponent.mockReturnValue(health)
    const sync = syncEntity({
      entityId: 5,
      components: ['Health'],
      room: room as Room,
      owner: false,
      world: world as never,
    })

    sync.applyRemoteState({ type: 'entity:state', seq: 500, payload: { entityId: 5, Health: { hp: 50 } } })
    sync.applyRemoteState({ type: 'entity:state', seq: 498, payload: { entityId: 5, Health: { hp: 20 } } })
    expect(health.hp).toBe(50) // a small reorder, dropped
    sync.applyRemoteState({ type: 'entity:state', seq: 2, payload: { entityId: 5, Health: { hp: 15 } } })
    expect(health.hp).toBe(15) // the sender restarted its counter
  })

  it('resets the seq ordering guard on stop', () => {
    const health = { hp: 10 }
    world.getComponent.mockReturnValue(health)
    const sync = syncEntity({
      entityId: 5,
      components: ['Health'],
      room: room as Room,
      owner: false,
      world: world as never,
    })

    sync.applyRemoteState({ type: 'entity:state', seq: 5, payload: { entityId: 5, Health: { hp: 50 } } })
    sync.stop()
    sync.applyRemoteState({ type: 'entity:state', seq: 1, payload: { entityId: 5, Health: { hp: 15 } } })

    expect(health.hp).toBe(15) // guard cleared — accepted even though seq is lower than before stop
  })

  it('delta sync: clears cache on stop so next start sends full state', () => {
    const transform = { x: 5, y: 5 }
    world.getComponent.mockImplementation((_entityId: number, type: string) => {
      if (type === 'Transform') return transform
      return undefined
    })

    const sync = syncEntity({
      entityId: 2,
      components: ['Transform'],
      room: room as Room,
      owner: true,
      tickRate: 10,
      world: world as never,
    })

    sync.start()
    vi.advanceTimersByTime(100) // first tick — sends initial state
    expect(room.broadcast).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(100) // nothing changed — no send
    expect(room.broadcast).toHaveBeenCalledTimes(1)

    sync.stop()
    sync.start() // cache cleared — next tick sends full state again
    vi.advanceTimersByTime(100)
    expect(room.broadcast).toHaveBeenCalledTimes(2)
  })
})
