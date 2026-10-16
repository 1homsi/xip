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
      world.typeId('Tag')
      const health = world.typeId('Health')
      world.clear()
      // Health is the second type interned before the reset; it must keep that ID.
      const e = world.createEntity()
      world.addComponent(e, { type: 'Health', hp: 5 })
      expect(world.typeId('Health')).toBe(health)
      expect(world.getComponent<{ hp: number }>(e, health)?.hp).toBe(5)
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
