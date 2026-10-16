import { describe, it, expect, beforeEach } from 'vitest'
import { ECSWorld, applyDeltaSnapshot } from '../ecs/world'
import type { System } from '../ecs/world'

describe('ECSWorld', () => {
  let world: ECSWorld

  beforeEach(() => {
    world = new ECSWorld()
  })

  describe('createEntity', () => {
    it('returns incrementing IDs starting at 0', () => {
      const id0 = world.createEntity()
      const id1 = world.createEntity()
      const id2 = world.createEntity()
      expect(id0).toBe(0)
      expect(id1).toBe(1)
      expect(id2).toBe(2)
    })
  })

  describe('hasEntity', () => {
    it('returns true for a created entity', () => {
      const id = world.createEntity()
      expect(world.hasEntity(id)).toBe(true)
    })

    it('returns false for an ID that was never created', () => {
      expect(world.hasEntity(999)).toBe(false)
    })

    it('returns false after entity is destroyed', () => {
      const id = world.createEntity()
      world.destroyEntity(id)
      expect(world.hasEntity(id)).toBe(false)
    })
  })

  describe('destroyEntity', () => {
    it('removes entity and its components', () => {
      const id = world.createEntity()
      world.addComponent(id, { type: 'Foo' })
      world.destroyEntity(id)
      expect(world.hasEntity(id)).toBe(false)
      expect(world.getComponent(id, 'Foo')).toBeUndefined()
    })

    it('decrements entityCount', () => {
      const id = world.createEntity()
      expect(world.entityCount).toBe(1)
      world.destroyEntity(id)
      expect(world.entityCount).toBe(0)
    })
  })

  describe('addComponent / getComponent', () => {
    it('stores and retrieves a component', () => {
      const id = world.createEntity()
      const comp = { type: 'Health', value: 100 }
      world.addComponent(id, comp)
      expect(world.getComponent(id, 'Health')).toBe(comp)
    })

    it('returns undefined for a component that was never added', () => {
      const id = world.createEntity()
      expect(world.getComponent(id, 'Missing')).toBeUndefined()
    })

    it('returns undefined when entity does not exist', () => {
      expect(world.getComponent(999, 'Health')).toBeUndefined()
    })

    it('overwrites an existing component of the same type', () => {
      const id = world.createEntity()
      world.addComponent(id, { type: 'Pos', x: 1 })
      world.addComponent(id, { type: 'Pos', x: 2 })
      const comp = world.getComponent<{ type: 'Pos'; x: number }>(id, 'Pos')
      expect(comp?.x).toBe(2)
    })
  })

  describe('removeComponent', () => {
    it('removes a specific component', () => {
      const id = world.createEntity()
      world.addComponent(id, { type: 'Vel' })
      world.removeComponent(id, 'Vel')
      expect(world.getComponent(id, 'Vel')).toBeUndefined()
    })

    it('does not remove other components', () => {
      const id = world.createEntity()
      world.addComponent(id, { type: 'A' })
      world.addComponent(id, { type: 'B' })
      world.removeComponent(id, 'A')
      expect(world.getComponent(id, 'B')).toBeDefined()
    })
  })

  describe('hasComponent', () => {
    it('returns true when component exists', () => {
      const id = world.createEntity()
      world.addComponent(id, { type: 'X' })
      expect(world.hasComponent(id, 'X')).toBe(true)
    })

    it('returns false when component does not exist', () => {
      const id = world.createEntity()
      expect(world.hasComponent(id, 'X')).toBe(false)
    })

    it('returns false after component is removed', () => {
      const id = world.createEntity()
      world.addComponent(id, { type: 'X' })
      world.removeComponent(id, 'X')
      expect(world.hasComponent(id, 'X')).toBe(false)
    })

    it('returns false for non-existent entity', () => {
      expect(world.hasComponent(999, 'X')).toBe(false)
    })
  })

  describe('query', () => {
    it('returns only entities with ALL specified component types', () => {
      const a = world.createEntity()
      const b = world.createEntity()
      const c = world.createEntity()
      world.addComponent(a, { type: 'Pos' })
      world.addComponent(a, { type: 'Vel' })
      world.addComponent(b, { type: 'Pos' })
      // c has neither
      const result = world.query('Pos', 'Vel')
      expect(result).toContain(a)
      expect(result).not.toContain(b)
      expect(result).not.toContain(c)
    })

    it('returns empty array when no entities match', () => {
      world.createEntity()
      const result = world.query('NonExistent')
      expect(result).toEqual([])
    })

    it('returns all entities when querying with no types', () => {
      const a = world.createEntity()
      const b = world.createEntity()
      const result = world.query()
      expect(result).toContain(a)
      expect(result).toContain(b)
    })

    it('is cached: same query returns same array reference before update', () => {
      const id = world.createEntity()
      world.addComponent(id, { type: 'Tag' })
      const first = world.query('Tag')
      const second = world.query('Tag')
      expect(first).toBe(second)
    })

    it('cache is cleared on update() so new components appear in next query', () => {
      const id = world.createEntity()
      world.addComponent(id, { type: 'Tag' })
      // First query caches result
      expect(world.query('Tag')).toContain(id)
      // Add second entity after cache is set
      const id2 = world.createEntity()
      world.addComponent(id2, { type: 'Tag' })
      // Call update to clear cache (no systems, so harmless)
      world.update(0)
      const result = world.query('Tag')
      expect(result).toContain(id)
      expect(result).toContain(id2)
    })
  })

  describe('queryOne', () => {
    it('returns the first matching entity', () => {
      const id = world.createEntity()
      world.addComponent(id, { type: 'Unique' })
      expect(world.queryOne('Unique')).toBe(id)
    })

    it('returns undefined when no entity matches', () => {
      world.createEntity()
      expect(world.queryOne('Ghost')).toBeUndefined()
    })
  })

  describe('entityCount', () => {
    it('tracks entity count correctly', () => {
      expect(world.entityCount).toBe(0)
      world.createEntity()
      expect(world.entityCount).toBe(1)
      world.createEntity()
      expect(world.entityCount).toBe(2)
      const id = world.createEntity()
      world.destroyEntity(id)
      expect(world.entityCount).toBe(2)
    })
  })

  describe('clear', () => {
    it('resets entities, components, and ID counter', () => {
      world.createEntity()
      world.createEntity()
      world.clear()
      expect(world.entityCount).toBe(0)
      // After clear, nextId resets so createEntity returns 0 again
      const newId = world.createEntity()
      expect(newId).toBe(0)
    })

    it('keeps type IDs stable, so a cached typeId still reads its column', () => {
      const old = world.createEntity()
      world.addComponent(old, { type: 'Tag', tags: ['stale'] })
      const health = world.typeId('Health')
      world.clear()
      // Health is interned before the reset; it must keep that ID, and the old entity's Tag must be gone.
      const e = world.createEntity()
      world.addComponent(e, { type: 'Health', hp: 5 })
      expect(world.typeId('Health')).toBe(health)
      expect(world.getComponent<{ hp: number }>(e, health)?.hp).toBe(5)
      expect(world.getComponent(e, 'Tag')).toBeUndefined()
      expect(world.query('Tag')).toEqual([])
    })

    it('reports every live entity as destroyed', () => {
      const a = world.createEntity()
      const b = world.createEntity()
      const destroyed: number[] = []
      world.onDestroyEntity((id) => destroyed.push(id))
      world.clear()
      expect(destroyed.sort()).toEqual([a, b].sort())
    })
  })

  describe('destroy listeners', () => {
    it('fires for entities a restore drops, but not for the ones it keeps', () => {
      const keep = world.createEntity()
      world.addComponent(keep, { type: 'Tag', tags: ['keep'] })
      const snap = world.getSnapshot()
      const later = world.createEntity()
      const destroyed: number[] = []
      world.onDestroyEntity((id) => destroyed.push(id))
      world.restoreSnapshot(snap)
      expect(world.hasEntity(later)).toBe(false)
      expect(destroyed).toContain(later)
      // `keep` is in the snapshot: same id, so it is restored, not destroyed.
      expect(world.hasEntity(keep)).toBe(true)
      expect(destroyed).not.toContain(keep)
    })

    it('fires for the entities a binary restore drops too', () => {
      const snap = world.getSnapshotBinary()
      world.createEntity()
      const dropped = world.createEntity()
      const destroyed: number[] = []
      world.onDestroyEntity((id) => destroyed.push(id))
      world.restoreSnapshotBinary(snap)
      expect(world.entityCount).toBe(0)
      expect(destroyed).toContain(dropped)
    })

    it('reports the destroyed ids as gone', () => {
      const id = world.createEntity()
      let liveAtNotify: boolean | null = null
      world.onDestroyEntity((destroyedId) => {
        if (destroyedId === id) liveAtNotify = world.hasEntity(id)
      })
      world.clear()
      // Matches destroyEntity(), which also notifies once the entity is gone.
      expect(liveAtNotify).toBe(false)
    })

    it('does not reuse dropped ids while restore listeners are running', () => {
      const snap = world.getSnapshot()
      const dropped = [world.createEntity(), world.createEntity(), world.createEntity()]
      const liveAtNotify: boolean[] = []
      let spawned: number | undefined
      world.onDestroyEntity((id) => {
        liveAtNotify.push(world.hasEntity(id))
        if (spawned === undefined) spawned = world.createEntity()
      })

      world.restoreSnapshot(snap)

      expect(liveAtNotify).toEqual([false, false, false])
      expect(spawned).toBeDefined()
      expect(dropped).not.toContain(spawned)
      expect(world.hasEntity(spawned!)).toBe(true)
    })
  })

  describe('deterministic RNG', () => {
    it('keeps deterministic RNG across restoreSnapshot', () => {
      const snap = new ECSWorld().getSnapshot()
      const a = new ECSWorld()
      a.setDeterministicSeed(7)
      a.restoreSnapshot(snap)
      const b = new ECSWorld()
      b.setDeterministicSeed(7)
      b.restoreSnapshot(snap)
      expect([a.rng(), a.rng(), a.rng()]).toEqual([b.rng(), b.rng(), b.rng()])
    })

    it('keeps deterministic RNG across clear()', () => {
      const a = new ECSWorld()
      a.setDeterministicSeed(7)
      a.clear()
      const b = new ECSWorld()
      b.setDeterministicSeed(7)
      b.clear()
      expect([a.rng(), a.rng()]).toEqual([b.rng(), b.rng()])
    })
  })

  describe('deterministic RNG', () => {
    it('keeps deterministic RNG across restoreSnapshot', () => {
      const snap = new ECSWorld().getSnapshot()
      const a = new ECSWorld()
      a.setDeterministicSeed(7)
      a.restoreSnapshot(snap)
      const b = new ECSWorld()
      b.setDeterministicSeed(7)
      b.restoreSnapshot(snap)
      expect([a.rng(), a.rng(), a.rng()]).toEqual([b.rng(), b.rng(), b.rng()])
    })

    it('keeps deterministic RNG across clear()', () => {
      const a = new ECSWorld()
      a.setDeterministicSeed(7)
      a.clear()
      const b = new ECSWorld()
      b.setDeterministicSeed(7)
      b.clear()
      expect([a.rng(), a.rng()]).toEqual([b.rng(), b.rng()])
    })
  })

  describe('update / systems', () => {
    it('calls all systems in order each update', () => {
      const callOrder: string[] = []

      const sysA: System = {
        update(_w, _dt) {
          callOrder.push('A')
        },
      }
      const sysB: System = {
        update(_w, _dt) {
          callOrder.push('B')
        },
      }
      const sysC: System = {
        update(_w, _dt) {
          callOrder.push('C')
        },
      }

      world.addSystem(sysA)
      world.addSystem(sysB)
      world.addSystem(sysC)
      world.update(1 / 60)

      expect(callOrder).toEqual(['A', 'B', 'C'])
    })

    it('passes the correct dt to each system', () => {
      const received: number[] = []
      const sys: System = {
        update(_w, dt) {
          received.push(dt)
        },
      }
      world.addSystem(sys)
      world.update(0.016)
      expect(received[0]).toBeCloseTo(0.016, 5)
    })

    it('does not call removed system', () => {
      let called = false
      const sys: System = {
        update() {
          called = true
        },
      }
      world.addSystem(sys)
      world.removeSystem(sys)
      world.update(0)
      expect(called).toBe(false)
    })
  })
})

describe('Binary snapshot', () => {
  it('restores legacy binary snapshots without reinterpreting ordinary strings', () => {
    const enc = new TextEncoder()
    const type = enc.encode('Values')
    const body = enc.encode('{"text":"i","nested":["m","n"]}')
    const data = new Uint8Array(12 + 6 + 2 + type.length + 4 + body.length)
    const view = new DataView(data.buffer)
    const u8 = data
    let offset = 0
    view.setUint32(offset, 1, true)
    offset += 4
    view.setUint32(offset, 0, true)
    offset += 4
    view.setUint32(offset, 1, true)
    offset += 4
    view.setUint32(offset, 0, true)
    offset += 4
    view.setUint16(offset, 1, true)
    offset += 2
    view.setUint16(offset, type.length, true)
    offset += 2
    u8.set(type, offset)
    offset += type.length
    view.setUint32(offset, body.length, true)
    offset += 4
    u8.set(body, offset)

    const world = new ECSWorld()
    world.restoreSnapshotBinary(data)
    expect(world.getComponent(0, 'Values')).toEqual({ type: 'Values', text: 'i', nested: ['m', 'n'] })
  })

  it('preserves non-finite numbers and ordinary sentinel-shaped component data', () => {
    const world = new ECSWorld()
    const id = world.createEntity()
    world.addComponent(id, {
      type: 'Settings',
      max: Infinity,
      min: -Infinity,
      invalid: NaN,
      metadata: { $num: 'Infinity' },
      nested: [{ $num: 'NaN' }, -Infinity],
      markerLike: ['~i', '~~m', '~~~n'],
    })
    const expected = {
      type: 'Settings',
      max: Infinity,
      min: -Infinity,
      invalid: NaN,
      metadata: { $num: 'Infinity' },
      nested: [{ $num: 'NaN' }, -Infinity],
      markerLike: ['~i', '~~m', '~~~n'],
    }

    const snapshot = world.getSnapshot()
    const fromSnapshot = new ECSWorld()
    fromSnapshot.restoreSnapshot(snapshot)
    expect(fromSnapshot.getComponent(id, 'Settings')).toEqual(expected)

    const fromBinary = new ECSWorld()
    fromBinary.restoreSnapshotBinary(world.getSnapshotBinary())
    expect(fromBinary.getComponent(id, 'Settings')).toEqual(expected)
  })

  it('round-trips a world through binary format', () => {
    const world = new ECSWorld()
    const a = world.createEntity()
    world.addComponent(a, { type: 'Transform', x: 42, y: 7 })
    const b = world.createEntity()
    world.addComponent(b, { type: 'Tag', tags: ['player'] })

    const bin = world.getSnapshotBinary()
    expect(bin).toBeInstanceOf(Uint8Array)

    const world2 = new ECSWorld()
    world2.restoreSnapshotBinary(bin)

    expect(world2.hasEntity(a)).toBe(true)
    expect(world2.hasEntity(b)).toBe(true)
    const t = world2.getComponent<{ x: number; y: number }>(a, 'Transform')
    expect(t?.x).toBe(42)
    expect(t?.y).toBe(7)
    const tag = world2.getComponent<{ tags: string[] }>(b, 'Tag')
    expect(tag?.tags).toEqual(['player'])
  })

  it('binary snapshot is smaller than JSON for many entities', () => {
    const world = new ECSWorld()
    for (let i = 0; i < 50; i++) {
      const e = world.createEntity()
      world.addComponent(e, { type: 'Transform', x: i * 10, y: i * 5, rotation: 0, scaleX: 1, scaleY: 1 })
      world.addComponent(e, { type: 'RigidBody', vx: 0, vy: 0, isStatic: false })
    }
    const bin = world.getSnapshotBinary()
    const json = JSON.stringify(world.getSnapshot())
    // Binary should be meaningfully smaller than raw JSON
    expect(bin.byteLength).toBeLessThan(json.length)
  })

  it('restores empty world from binary', () => {
    const world = new ECSWorld()
    const bin = world.getSnapshotBinary()
    const world2 = new ECSWorld()
    world2.createEntity() // pre-existing entity
    world2.restoreSnapshotBinary(bin)
    expect(world2.entityCount).toBe(0)
  })
})

describe('Delta snapshot', () => {
  it('delta against identical baseline has no changes or removals', () => {
    const world = new ECSWorld()
    const e = world.createEntity()
    world.addComponent(e, { type: 'Transform', x: 0, y: 0 })

    const baseline = world.getSnapshot()
    const delta = world.getDeltaSnapshot(baseline)

    expect(delta.changed).toHaveLength(0)
    expect(delta.removed).toHaveLength(0)
  })

  it('delta includes modified entities', () => {
    const world = new ECSWorld()
    const e = world.createEntity()
    world.addComponent(e, { type: 'Transform', x: 0, y: 0 })

    const baseline = world.getSnapshot()
    const t = world.getComponent<{ x: number; y: number }>(e, 'Transform')!
    t.x = 99

    const delta = world.getDeltaSnapshot(baseline)
    expect(delta.changed).toHaveLength(1)
    expect(delta.changed[0].id).toBe(e)
  })

  it('does not include unchanged nested arrays or objects', () => {
    const world = new ECSWorld()
    const e = world.createEntity()
    world.addComponent(e, {
      type: 'Path',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 5 },
      ],
      tags: ['patrol', 'enemy'],
    })

    const baseline = world.getSnapshot()
    const delta = world.getDeltaSnapshot(baseline)

    expect(delta.changed).toHaveLength(0)
  })

  it('delta includes newly added entities', () => {
    const world = new ECSWorld()
    const baseline = world.getSnapshot()
    const newE = world.createEntity()
    world.addComponent(newE, { type: 'Tag', tags: ['enemy'] })

    const delta = world.getDeltaSnapshot(baseline)
    expect(delta.changed.some((en) => en.id === newE)).toBe(true)
  })

  it('delta records removed entities', () => {
    const world = new ECSWorld()
    const e = world.createEntity()
    world.addComponent(e, { type: 'Transform', x: 0, y: 0 })
    const baseline = world.getSnapshot()

    world.destroyEntity(e)
    const delta = world.getDeltaSnapshot(baseline)

    expect(delta.removed).toContain(e)
  })

  it('applyDeltaSnapshot reconstructs full snapshot', () => {
    const world = new ECSWorld()
    const e = world.createEntity()
    world.addComponent(e, { type: 'Transform', x: 10, y: 20 })
    const baseline = world.getSnapshot()

    const t = world.getComponent<{ x: number; y: number }>(e, 'Transform')!
    t.x = 50
    const delta = world.getDeltaSnapshot(baseline)

    const reconstructed = applyDeltaSnapshot(baseline, delta)
    const tx = reconstructed.entities.find((en) => en.id === e)?.components.find((c) => c.type === 'Transform') as
      | { x: number }
      | undefined
    expect(tx?.x).toBe(50)
  })

  it('applyDeltaSnapshot removes deleted entities', () => {
    const world = new ECSWorld()
    const e = world.createEntity()
    world.addComponent(e, { type: 'Tag', tags: ['bullet'] })
    const baseline = world.getSnapshot()

    world.destroyEntity(e)
    const delta = world.getDeltaSnapshot(baseline)
    const reconstructed = applyDeltaSnapshot(baseline, delta)

    expect(reconstructed.entities.find((en) => en.id === e)).toBeUndefined()
  })
})
