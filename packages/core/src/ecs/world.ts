export type EntityId = number

export type EntityTypeId = number

export interface Component {
  readonly type: string
}

export interface System {
  update(world: ECSWorld, dt: number): void
}

export interface WorldSnapshot {
  nextId: number
  rngState: number
  entities: Array<{ id: EntityId; components: Component[] }>
}

/**
 * A compact incremental update relative to a known baseline `WorldSnapshot`.
 * Produced by `ECSWorld.getDeltaSnapshot`, consumed by `applyDeltaSnapshot`.
 */
export interface DeltaSnapshot {
  nextId: number
  rngState: number
  /** Entities that were added or whose components changed since baseline. */
  changed: WorldSnapshot['entities']
  /** IDs of entities that were destroyed since baseline. */
  removed: number[]
}

/**
 * Merge a `DeltaSnapshot` onto a `baseline` WorldSnapshot, returning a new
 * full snapshot that reflects the current world state.
 *
 * This is a pure function — neither the baseline nor the delta is mutated.
 *
 * @example
 * const delta = world.getDeltaSnapshot(prevSnap)
 * sendOverNetwork(delta)   // much smaller than a full snapshot
 * // On the receiving end:
 * const newSnap = applyDeltaSnapshot(prevSnap, delta)
 * remoteWorld.restoreSnapshot(newSnap)
 */
export function applyDeltaSnapshot(baseline: WorldSnapshot, delta: DeltaSnapshot): WorldSnapshot {
  const removedSet = new Set(delta.removed)
  const changedMap = new Map(delta.changed.map((e) => [e.id, e]))

  const entities: WorldSnapshot['entities'] = []
  for (const entity of baseline.entities) {
    if (removedSet.has(entity.id)) continue
    entities.push(changedMap.get(entity.id) ?? entity)
    changedMap.delete(entity.id)
  }
  // Entities in `changed` that weren't in baseline are new — append them
  for (const entity of changedMap.values()) {
    entities.push(entity)
  }

  return { nextId: delta.nextId, rngState: delta.rngState, entities }
}

// ── Column ────────────────────────────────────────────────────────────────────
// One component type's storage: a packed array of component objects plus the
// sparse/owner indirections that keep every operation O(1).
//
//   dense[i]       — the i-th live component of this type
//   ownerSlot[i]   — entity slot owning dense[i]
//   sparse[slot]   — index of that entity's component in dense, or -1
//
interface Column {
  dense: Component[]
  ownerSlot: number[]
  sparse: Int32Array
  /** Interned type name — avoids reverse lookups when marking dirty. */
  name: string
}

// ── Archetype ─────────────────────────────────────────────────────────────────
// An archetype is a unique set of component types. All entities with exactly
// the same set of component types live in the same archetype.

interface Archetype {
  // Sorted, \x00-joined component type string — also serves as the map key
  readonly key: string
  // The component types in this archetype (sorted)
  readonly types: ReadonlySet<string>
  // Entities in this archetype (insertion order)
  entities: EntityId[]
  // Cached structural transitions: type → target archetype after adding that
  // type (addEdges) or removing it (removeEdges). Turns repeated
  // add/removeComponent calls into O(1) map lookups with zero allocation.
  addEdges: Map<string, Archetype>
  removeEdges: Map<string, Archetype>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Per-component structural comparison with early exit — avoids stringifying
 *  the whole entity and is not sensitive to JSON key-ordering. */
function _valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => _valuesEqual(value, b[index]))
  }

  const recordA = a as Record<string, unknown>
  const recordB = b as Record<string, unknown>
  const keysA = Object.keys(recordA)
  if (keysA.length !== Object.keys(recordB).length) return false
  return keysA.every(
    (key) => Object.prototype.hasOwnProperty.call(recordB, key) && _valuesEqual(recordA[key], recordB[key]),
  )
}

/**
 * Deep-clone a plain-data component.
 *
 * Benchmarked: the JSON round-trip beats `structuredClone` for small plain
 * objects in V8 (structuredClone's generality costs several µs extra per call),
 * so JSON stays despite looking naive.
 */
function _cloneComponent<T>(comp: T): T {
  return structuredClone(comp)
}

function _componentsChanged(a: Component[], b: Component[]): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) {
    const ca = a[i] as unknown as Record<string, unknown>
    const cb = b[i] as unknown as Record<string, unknown>
    if (ca['type'] !== cb['type']) return true
    const keysA = Object.keys(ca)
    if (keysA.length !== Object.keys(cb).length) return true
    for (const k of keysA) {
      if (!_valuesEqual(ca[k], cb[k])) return true
    }
  }
  return false
}

// ── ECSWorld ──────────────────────────────────────────────────────────────────

export class ECSWorld {
  private nextId = 0

  // ── Dense columnar component storage ────────────────────────────────────────
  //
  // Components live in per-type dense arrays ("columns") instead of a
  // Map<EntityId, Map<string, Component>>. Type strings are interned to small
  // integer IDs; entities are packed into slots (swap-remove on destroy keeps
  // slots dense). A lookup is one string-keyed map probe for the type ID plus
  // O(1) integer array reads — no nested hashing, no boxed map entries.
  private typeIds = new Map<string, number>()
  private columns: Column[] = []

  // EntityId ↔ packed slot mapping. Slots are always [0, liveCount).
  private slotOfId = new Int32Array(1024).fill(-1)
  private idOfSlot = new Int32Array(1024).fill(-1)
  private liveCount = 0

  // Seeded RNG (LCG) for deterministic mode
  private _rngState = 0
  private _deterministic = false

  /** Asset manager reference — set by Game, available in Script callbacks via world.assets */
  assets!: {
    getImage(src: string): HTMLImageElement | undefined
    loadImage(src: string): Promise<HTMLImageElement>
  }

  // Primary index: archetypes keyed by sorted type string
  private archetypes = new Map<string, Archetype>()

  // Reverse index: component type → archetypes containing it. Lets query()
  // start from the smallest candidate set instead of scanning all archetypes.
  private typeIndex = new Map<string, Set<Archetype>>()

  // Which archetype each entity lives in (direct object ref — no key lookup)
  private entityArchetype = new Map<EntityId, Archetype>()

  // Each entity's index within its archetype's entity array. Together with
  // swap-remove this makes structural moves O(1) instead of O(n) indexOf.
  private entityPos = new Map<EntityId, number>()

  private systems: System[] = []

  // Query cache: query key → matching EntityId[]
  // Invalidated selectively when archetypes are added or entities move.
  private queryCache = new Map<string, EntityId[]>()

  // Reverse index of the query cache: component type → cached query keys that
  // include it. Makes dirty-flush invalidation O(dirty types) instead of
  // O(cache size × key parse).
  private cacheKeysByType = new Map<string, Set<string>>()

  // Component types touched since last update() — used for selective cache invalidation
  private dirtyTypes = new Set<string>()
  private dirtyAll = false

  // Reused TextEncoder for binary snapshots (construction is expensive).
  private _encoder: TextEncoder | undefined

  // Direct-mapped memo for string → column lookups. System loops fetch the
  // same few type names millions of times; a pointer-compare hit avoids the
  // Map hash entirely. Indexed by (length, first char) — collisions fall
  // through to the real map after an identity check. 32 slots because the
  // physics step cycles ~a dozen distinct type names per frame.
  private _memoKey: (string | undefined)[] = new Array(32)
  private _memoCol: (Column | undefined)[] = new Array(32)

  /** Resolve a type name to its column without hashing when warm. */
  private colByName(type: string): Column | undefined {
    const idx = ((type.length * 31 + type.charCodeAt(0)) & 31) as number
    if (this._memoKey[idx] === type) return this._memoCol[idx]
    const tid = this.typeIds.get(type)
    if (tid === undefined) return undefined
    const col = this.columns[tid]
    this._memoKey[idx] = type
    this._memoCol[idx] = col
    return col
  }

  // ── Columnar storage internals ──────────────────────────────────────────────

  /** Intern a component type string to its column, creating it on first use. */
  private internType(type: string): number {
    let tid = this.typeIds.get(type)
    if (tid === undefined) {
      tid = this.columns.length
      this.typeIds.set(type, tid)
      const sparse = new Int32Array(this.slotOfId.length).fill(-1)
      this.columns.push({ dense: [], ownerSlot: [], sparse, name: type })
    }
    return tid
  }

  /** Grow the id↔slot tables (and every column's sparse view) to fit `id`. */
  private ensureCapacity(id: number): void {
    if (id < this.slotOfId.length) return
    let cap = this.slotOfId.length
    while (cap <= id) cap *= 2
    const slots = new Int32Array(cap).fill(-1)
    slots.set(this.slotOfId)
    this.slotOfId = slots
    const ids = new Int32Array(cap).fill(-1)
    ids.set(this.idOfSlot)
    this.idOfSlot = ids
    for (const col of this.columns) {
      const sparse = new Int32Array(cap).fill(-1)
      sparse.set(col.sparse)
      col.sparse = sparse
    }
  }

  /** Slot of a live entity, or -1 / undefined-safe access for out-of-range ids. */
  private slotOf(id: EntityId): number {
    return id >= 0 && id < this.slotOfId.length ? this.slotOfId[id] : -1
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private getOrCreateArchetype(types: Iterable<string>): Archetype {
    const arr = [...types].sort()
    return this.getOrCreateArchetypeByKey(arr)
  }

  /** Create or fetch an archetype from an already-sorted type list. */
  private getOrCreateArchetypeByKey(arr: string[]): Archetype {
    const key = arr.join('\x00')
    let arch = this.archetypes.get(key)
    if (!arch) {
      arch = { key, types: new Set(arr), entities: [], addEdges: new Map(), removeEdges: new Map() }
      this.archetypes.set(key, arch)
      for (const t of arr) {
        let set = this.typeIndex.get(t)
        if (!set) {
          set = new Set()
          this.typeIndex.set(t, set)
        }
        set.add(arch)
      }
    }
    return arch
  }

  /**
   * Resolve the archetype reached by adding `type` to `from` — via cached
   * edge when available, computing and caching it on first traversal.
   */
  private getAddEdge(from: Archetype, type: string): Archetype {
    let target = from.addEdges.get(type)
    if (!target) {
      // Insert into the sorted type list without re-spreading the whole set.
      const merged: string[] = []
      let inserted = false
      for (const t of from.types) {
        if (!inserted && t > type) {
          merged.push(type)
          inserted = true
        }
        merged.push(t)
      }
      if (!inserted) merged.push(type)
      target = this.getOrCreateArchetypeByKey(merged)
      from.addEdges.set(type, target)
      target.removeEdges.set(type, from)
    }
    return target
  }

  /**
   * Resolve the archetype reached by removing `type` from `from`.
   */
  private getRemoveEdge(from: Archetype, type: string): Archetype {
    let target = from.removeEdges.get(type)
    if (!target) {
      // Rebuild the sorted list without `type`.
      const reduced: string[] = []
      for (const t of from.types) {
        if (t !== type) reduced.push(t)
      }
      target = this.getOrCreateArchetypeByKey(reduced)
      from.removeEdges.set(type, target)
      target.addEdges.set(type, from)
    }
    return target
  }

  private moveToArchetype(id: EntityId, newArch: Archetype): void {
    // Remove from current archetype — O(1) via the stored position +
    // swap-remove. Query results make no ordering guarantees, so relative
    // order loss is acceptable.
    const oldArch = this.entityArchetype.get(id)
    if (oldArch) {
      const entities = oldArch.entities
      const idx = this.entityPos.get(id)!
      const last = entities.pop()!
      if (idx < entities.length) {
        entities[idx] = last
        this.entityPos.set(last, idx)
      }
    }
    this.entityPos.set(id, newArch.entities.length)
    newArch.entities.push(id)
    this.entityArchetype.set(id, newArch)
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  createEntity(): EntityId {
    const id = this.nextId++
    this.ensureCapacity(id)
    // Slots stay packed [0, liveCount) because destroy swap-removes them,
    // so a new entity always takes the next slot — no free list needed.
    const slot = this.liveCount++
    this.slotOfId[id] = slot
    this.idOfSlot[slot] = id
    // New entities have no components, so only the zero-arg query ('' key)
    // is affected. Invalidate just that instead of nuking the whole cache.
    const emptyArch = this.getOrCreateArchetypeByKey([])
    this.entityPos.set(id, emptyArch.entities.length)
    emptyArch.entities.push(id)
    this.entityArchetype.set(id, emptyArch)
    this.queryCache.delete('')
    return id
  }

  destroyEntity(id: EntityId): void {
    const slot = this.slotOf(id)
    if (slot < 0) return

    // Remove components from every column that holds one for this slot.
    // Column order = type interning order, which is tiny (tens).
    for (let tid = 0; tid < this.columns.length; tid++) {
      const col = this.columns[tid]
      const denseIdx = col.sparse[slot]
      if (denseIdx === -1) continue
      col.sparse[slot] = -1
      const lastIdx = col.dense.length - 1
      if (denseIdx !== lastIdx) {
        // Swap-remove: move the last component into the freed slot.
        col.dense[denseIdx] = col.dense[lastIdx]
        const movedSlot = col.ownerSlot[lastIdx]
        col.ownerSlot[denseIdx] = movedSlot
        col.sparse[movedSlot] = denseIdx
      }
      col.dense.pop()
      col.ownerSlot.pop()
      this.dirtyTypes.add(col.name)
    }

    // Pack the entity slot array.
    const lastSlot = --this.liveCount
    if (slot !== lastSlot) {
      const movedId = this.idOfSlot[lastSlot]
      this.idOfSlot[slot] = movedId
      this.slotOfId[movedId] = slot
      // The moved entity's component pointers are indexed by its OLD slot in
      // every column. Re-home them under the new slot, otherwise the moved
      // entity silently loses all of its components (getComponent returns
      // undefined and queries still list it).
      for (let tid = 0; tid < this.columns.length; tid++) {
        const col = this.columns[tid]
        const movedDense = col.sparse[lastSlot]
        if (movedDense === -1) continue
        col.sparse[slot] = movedDense
        col.ownerSlot[movedDense] = slot
        col.sparse[lastSlot] = -1
      }
    }
    this.slotOfId[id] = -1

    // Remove from archetype — O(1) via stored position + swap-remove.
    const arch = this.entityArchetype.get(id)
    if (arch) {
      const entities = arch.entities
      const idx = this.entityPos.get(id)!
      const last = entities.pop()!
      if (idx < entities.length) {
        entities[idx] = last
        this.entityPos.set(last, idx)
      }
    }
    this.entityArchetype.delete(id)
    this.entityPos.delete(id)
    // Zero-arg query() returns ALL live entities, so any destruction
    // invalidates it — component-typed queries are covered by dirtyTypes.
    this.queryCache.delete('')
    // Fire subscribers — copy to avoid mutation-during-iteration if one unsubscribes.
    if (this.destroyListeners.size > 0) {
      for (const cb of Array.from(this.destroyListeners)) cb(id)
    }
  }

  hasEntity(id: EntityId): boolean {
    return this.slotOf(id) >= 0
  }

  /**
   * Subscribe to entity-destroyed events. The callback fires after the entity
   * has been removed from all archetypes and component storage. Returns an
   * unsubscribe function.
   *
   * @example
   * ```ts
   * const off = ecs.onDestroyEntity((id) => console.log('gone', id))
   * // ...
   * off()
   * ```
   */
  onDestroyEntity(cb: (id: EntityId) => void): () => void {
    this.destroyListeners.add(cb)
    return () => {
      this.destroyListeners.delete(cb)
    }
  }

  private destroyListeners: Set<(id: EntityId) => void> = new Set()

  /**
   * Intern a component type name into a stable numeric ID.
   *
   * `getComponent`/`hasComponent`/`removeComponent` accept the returned ID
   * wherever a type string is accepted — passing numbers skips the string
   * hash entirely, which matters in per-entity loops. IDs stay valid for the
   * life of the world, including across `clear()` and `restoreSnapshot()`.
   */
  typeId(type: string): EntityTypeId {
    return this.internType(type)
  }

  addComponent<T extends Component>(id: EntityId, component: T): void {
    const slot = this.slotOf(id)
    if (slot < 0) return
    const tid = this.internType(component.type)
    const col = this.columns[tid]
    const existing = col.sparse[slot]
    if (existing !== -1) {
      // Overwrite in place: same type set, so no archetype or cache changes.
      col.dense[existing] = component
      return
    }
    col.dense.push(component)
    col.ownerSlot.push(slot)
    col.sparse[slot] = col.dense.length - 1
    this.dirtyTypes.add(component.type)

    // Move along the cached +type archetype edge.
    const newArch = this.getAddEdge(this.entityArchetype.get(id)!, component.type)
    this.moveToArchetype(id, newArch)
  }

  removeComponent(id: EntityId, type: string | EntityTypeId): void {
    const slot = this.slotOf(id)
    if (slot < 0) return
    const col = typeof type === 'number' ? this.columns[type] : this.colByName(type)
    if (!col) return
    const denseIdx = col.sparse[slot]
    if (denseIdx === -1) return
    col.sparse[slot] = -1
    const lastIdx = col.dense.length - 1
    if (denseIdx !== lastIdx) {
      col.dense[denseIdx] = col.dense[lastIdx]
      const movedSlot = col.ownerSlot[lastIdx]
      col.ownerSlot[denseIdx] = movedSlot
      col.sparse[movedSlot] = denseIdx
    }
    col.dense.pop()
    col.ownerSlot.pop()
    this.dirtyTypes.add(col.name)

    // Move along the cached −type archetype edge.
    const newArch = this.getRemoveEdge(this.entityArchetype.get(id)!, col.name)
    this.moveToArchetype(id, newArch)
  }

  getComponent<T extends Component>(id: EntityId, type: string | EntityTypeId): T | undefined {
    const slot = this.slotOf(id)
    if (slot < 0) return undefined
    const col = typeof type === 'number' ? this.columns[type] : this.colByName(type)
    if (!col) return undefined
    const idx = col.sparse[slot]
    return idx === -1 ? undefined : (col.dense[idx] as T)
  }

  hasComponent(id: EntityId, type: string | EntityTypeId): boolean {
    const slot = this.slotOf(id)
    if (slot < 0) return false
    const col = typeof type === 'number' ? this.columns[type] : this.colByName(type)
    return col !== undefined && col.sparse[slot] !== -1
  }

  /**
   * Returns live references to all components on an entity.
   * Useful for editor / inspector tooling. Returns an empty array if the
   * entity does not exist.
   *
   * **Do not mutate structural fields** (e.g. `type`) — doing so will
   * desync the archetype index. Mutating value fields (x, y, color …) is safe.
   */
  getEntityComponents(id: EntityId): readonly Component[] {
    const slot = this.slotOf(id)
    if (slot < 0) return []
    const out: Component[] = []
    for (let tid = 0; tid < this.columns.length; tid++) {
      const col = this.columns[tid]
      const idx = col.sparse[slot]
      if (idx !== -1) out.push(col.dense[idx])
    }
    return out
  }

  /** Returns all live entity IDs currently in the world. */
  getAllEntityIds(): EntityId[] {
    return Array.from(this.idOfSlot.subarray(0, this.liveCount))
  }

  // Flush pending dirty flags into the query cache immediately.
  // Called inline at the top of query() so any mid-frame mutation
  // (destroyEntity, addComponent, removeComponent) is reflected before
  // the next query returns its results — prevents stale entity IDs from
  // appearing in results for systems that run later in the same frame.
  //
  // The clean/no-work case is kept to two branch-and-return instructions so
  // this method stays within V8's inlining budget on the query() hot path.
  private flushDirty(): void {
    if (!this.dirtyAll && this.dirtyTypes.size === 0) return
    this.flushDirtySlow()
  }

  private flushDirtySlow(): void {
    if (this.dirtyAll) {
      this.queryCache.clear()
      this.cacheKeysByType.clear()
      this.dirtyAll = false
      this.dirtyTypes.clear()
    } else {
      // Invalidate only cached queries whose key includes a dirty type.
      // The reverse index makes this O(dirty) instead of O(cache size).
      for (const type of this.dirtyTypes) {
        const keys = this.cacheKeysByType.get(type)
        if (keys) {
          for (const key of keys) this.queryCache.delete(key)
          keys.clear()
        }
      }
      this.dirtyTypes.clear()
    }
  }

  // Returns all entities that have ALL of the requested component types.
  // Uses archetype superset matching via the per-type reverse index — the
  // scan starts from the smallest candidate set, not from every archetype.
  //
  // The hot path (cache hit) is kept in this small function; cache-miss work
  // lives in `queryUncached` so V8 optimizes the tiny frame aggressively.
  query(...types: string[]): EntityId[] {
    this.flushDirty()
    const key = types.length === 0 ? '' : types.length === 1 ? types[0] : this.queryKey(types)
    const cached = this.queryCache.get(key)
    return cached ?? this.queryUncached(types, key)
  }

  // Sorted, joined key for a multi-type query, memoized by argument order so
  // the hot path does no sort/join allocation.
  private readonly _queryKeys2 = new Map<string, Map<string, string>>()
  private readonly _queryKeys3 = new Map<string, Map<string, Map<string, string>>>()
  private queryKey(types: string[]): string {
    if (types.length === 2) {
      let byA = this._queryKeys2.get(types[0])
      if (byA === undefined) this._queryKeys2.set(types[0], (byA = new Map()))
      let key = byA.get(types[1])
      if (key === undefined) byA.set(types[1], (key = types.slice().sort().join('\x00')))
      return key
    }
    if (types.length === 3) {
      let byA = this._queryKeys3.get(types[0])
      if (byA === undefined) this._queryKeys3.set(types[0], (byA = new Map()))
      let byB = byA.get(types[1])
      if (byB === undefined) byA.set(types[1], (byB = new Map()))
      let key = byB.get(types[2])
      if (key === undefined) byB.set(types[2], (key = types.slice().sort().join('\x00')))
      return key
    }
    return types.slice().sort().join('\x00')
  }

  private queryUncached(types: string[], key: string): EntityId[] {
    const result: EntityId[] = []
    if (types.length === 1) {
      const candidates = this.typeIndex.get(types[0])
      if (candidates) {
        for (const arch of candidates) {
          const entities = arch.entities
          for (let i = 0; i < entities.length; i++) result.push(entities[i])
        }
      }
    } else if (types.length > 1) {
      // Start from the smallest per-type archetype set, then filter.
      let smallest: Set<Archetype> | undefined
      for (const t of types) {
        const set = this.typeIndex.get(t)
        if (!set || set.size === 0) {
          smallest = undefined
          break
        }
        if (!smallest || set.size < smallest.size) smallest = set
      }
      if (smallest)
        for (const arch of smallest) {
          let match = true
          for (let i = 0; i < types.length; i++) {
            if (!arch.types.has(types[i])) {
              match = false
              break
            }
          }
          if (match) {
            const entities = arch.entities
            for (let i = 0; i < entities.length; i++) result.push(entities[i])
          }
        }
    } else {
      // Zero-arg query: ALL live entities across every archetype.
      for (const arch of this.archetypes.values()) {
        const entities = arch.entities
        for (let i = 0; i < entities.length; i++) result.push(entities[i])
      }
    }

    this.queryCache.set(key, result)
    // Register this cache entry under each requested type for O(1) invalidation.
    for (let i = 0; i < types.length; i++) {
      let keys = this.cacheKeysByType.get(types[i])
      if (!keys) {
        keys = new Set()
        this.cacheKeysByType.set(types[i], keys)
      }
      keys.add(key)
    }
    return result
  }

  queryOne(...types: string[]): EntityId | undefined {
    this.flushDirty()
    // Start from the smallest per-type archetype set — same strategy as
    // query() — instead of scanning every archetype in the world.
    let smallest: Set<Archetype> | undefined
    for (const t of types) {
      const set = this.typeIndex.get(t)
      if (!set || set.size === 0) return undefined
      if (!smallest || set.size < smallest.size) smallest = set
    }
    if (!smallest) {
      // No types requested: any live entity (slot 0 when populated).
      return this.liveCount > 0 ? this.idOfSlot[0] : undefined
    }
    if (types.length <= 1) {
      for (const arch of smallest) {
        if (arch.entities.length > 0) return arch.entities[0]
      }
      return undefined
    }
    for (const arch of smallest) {
      let match = true
      for (let i = 0; i < types.length; i++) {
        if (!arch.types.has(types[i])) {
          match = false
          break
        }
      }
      if (match && arch.entities.length > 0) return arch.entities[0]
    }
    return undefined
  }

  /**
   * Returns the first entity that has a Tag component containing the given tag string.
   * O(n) over entities with the Tag component — use sparingly in hot paths.
   */
  findByTag(tag: string): EntityId | undefined {
    for (const id of this.query('Tag')) {
      const t = this.getComponent<{ type: 'Tag'; tags: string[] }>(id, 'Tag')
      if (t?.tags.includes(tag)) return id
    }
    return undefined
  }

  /**
   * Returns all entities that have a Tag component containing the given tag string.
   */
  findAllByTag(tag: string): EntityId[] {
    const result: EntityId[] = []
    for (const id of this.query('Tag')) {
      const t = this.getComponent<{ type: 'Tag'; tags: string[] }>(id, 'Tag')
      if (t?.tags.includes(tag)) result.push(id)
    }
    return result
  }

  // ── Deterministic RNG ───────────────────────────────────────────────────────

  /** Enable deterministic mode with a fixed seed. All internal randomness uses this RNG. */
  setDeterministicSeed(seed: number): void {
    this._rngState = seed >>> 0
    this._deterministic = true
  }

  /** Returns a pseudo-random number in [0, 1). Uses seeded LCG in deterministic mode,
   *  Math.random() otherwise. */
  rng(): number {
    if (!this._deterministic) return Math.random()
    // 32-bit LCG: Numerical Recipes constants
    this._rngState = (Math.imul(this._rngState, 1664525) + 1013904223) >>> 0
    return this._rngState / 0x100000000
  }

  // ── Snapshot / Restore ──────────────────────────────────────────────────────

  /** Capture a full serialisable snapshot of all entity/component data + RNG state. */
  getSnapshot(): WorldSnapshot {
    const entities: WorldSnapshot['entities'] = []
    for (let slot = 0; slot < this.liveCount; slot++) {
      const id = this.idOfSlot[slot]
      const components: Component[] = []
      for (let tid = 0; tid < this.columns.length; tid++) {
        const col = this.columns[tid]
        const idx = col.sparse[slot]
        if (idx !== -1) components.push(_cloneComponent(col.dense[idx]))
      }
      entities.push({ id, components })
    }
    return { nextId: this.nextId, rngState: this._rngState, entities }
  }

  /** Restore world state from a previously captured snapshot. */
  restoreSnapshot(snapshot: WorldSnapshot): void {
    this.clear()
    this.nextId = snapshot.nextId
    this._rngState = snapshot.rngState
    // Pre-intern every component type so columns exist before slot packing.
    for (const { components } of snapshot.entities) {
      for (const comp of components) this.internType(comp.type)
    }
    for (const { id, components } of snapshot.entities) {
      this.ensureCapacity(id)
      const slot = this.liveCount++
      this.slotOfId[id] = slot
      this.idOfSlot[slot] = id
      for (const comp of components) {
        const col = this.columns[this.typeIds.get(comp.type)!]
        col.dense.push(comp)
        col.ownerSlot.push(slot)
        col.sparse[slot] = col.dense.length - 1
      }
      const arch = this.getOrCreateArchetype(components.map((c) => c.type))
      this.entityPos.set(id, arch.entities.length)
      arch.entities.push(id)
      this.entityArchetype.set(id, arch)
    }
    this.dirtyAll = true
  }

  // ── Binary snapshot ─────────────────────────────────────────────────────────
  //
  // Binary format (little-endian):
  //   [4] nextId       uint32
  //   [4] rngState     uint32
  //   [4] entityCount  uint32
  //   for each entity:
  //     [4] id              uint32
  //     [2] componentCount  uint16
  //     for each component:
  //       [2] typeLen uint16  — byte length of the type string (UTF-8)
  //       [N] type    bytes
  //       [4] dataLen uint32  — byte length of JSON component body (without `type`)
  //       [N] data    bytes
  //
  // Storing `type` separately avoids repeating it inside each JSON body,
  // which measurably reduces size in worlds with many entities.

  /**
   * Serialise the world state into a compact binary format.
   *
   * Smaller than JSON for large worlds because entity IDs are fixed-width
   * integers and the `type` string is stored once per component rather than
   * duplicated as a JSON key in every body.
   *
   * Compatible with `restoreSnapshotBinary`.
   */
  getSnapshotBinary(): Uint8Array {
    // Serialise directly from column storage — no intermediate deep-cloned
    // WorldSnapshot (that alone used to double the cost).
    const enc = this._encoder ?? (this._encoder = new TextEncoder())

    // First pass: encode component bodies, tracking total size.
    const eecs: Array<{ id: number; comps: Array<{ tb: Uint8Array; db: Uint8Array }> }> = []
    let size = 12 // nextId + rngState + entityCount
    for (let slot = 0; slot < this.liveCount; slot++) {
      const id = this.idOfSlot[slot]
      const encoded: Array<{ tb: Uint8Array; db: Uint8Array }> = []
      for (let tid = 0; tid < this.columns.length; tid++) {
        const col = this.columns[tid]
        const idx = col.sparse[slot]
        if (idx === -1) continue
        const comp = col.dense[idx] as unknown as Record<string, unknown>
        const rest = { ...comp } as Record<string, unknown>
        delete rest['type']
        const tb = enc.encode(col.name)
        const json =
          '~' +
          JSON.stringify(rest, (_k, v) =>
            typeof v === 'number' && !isFinite(v)
              ? '~' + (v === Infinity ? 'i' : v === -Infinity ? 'm' : 'n')
              : typeof v === 'string' && v[0] === '~'
                ? '~' + v
                : v,
          )
        const db = enc.encode(json)
        encoded.push({ tb, db })
        size += 2 + tb.byteLength + 4 + db.byteLength
      }
      eecs.push({ id, comps: encoded })
      size += 6 // id (4) + componentCount (2)
    }

    const buf = new ArrayBuffer(size)
    const view = new DataView(buf)
    const u8 = new Uint8Array(buf)
    let o = 0

    view.setUint32(o, this.nextId, true)
    o += 4
    view.setUint32(o, this._rngState, true)
    o += 4
    view.setUint32(o, eecs.length, true)
    o += 4

    for (const { id, comps } of eecs) {
      view.setUint32(o, id, true)
      o += 4
      view.setUint16(o, comps.length, true)
      o += 2
      for (const { tb, db } of comps) {
        view.setUint16(o, tb.byteLength, true)
        o += 2
        u8.set(tb, o)
        o += tb.byteLength
        view.setUint32(o, db.byteLength, true)
        o += 4
        u8.set(db, o)
        o += db.byteLength
      }
    }

    return u8
  }

  /**
   * Restore world state from a binary buffer produced by `getSnapshotBinary`.
   */
  restoreSnapshotBinary(data: Uint8Array): void {
    const dec = new TextDecoder()
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    let o = 0

    const nextId = view.getUint32(o, true)
    o += 4
    const rngState = view.getUint32(o, true)
    o += 4
    const entityCount = view.getUint32(o, true)
    o += 4

    const entities: WorldSnapshot['entities'] = []
    for (let e = 0; e < entityCount; e++) {
      const id = view.getUint32(o, true)
      o += 4
      const compCount = view.getUint16(o, true)
      o += 2
      const components: Component[] = []
      for (let c = 0; c < compCount; c++) {
        const typeLen = view.getUint16(o, true)
        o += 2
        const type = dec.decode(data.subarray(o, o + typeLen))
        o += typeLen
        const dataLen = view.getUint32(o, true)
        o += 4
        const json = dec.decode(data.subarray(o, o + dataLen))
        const bodyStart = json.indexOf('{')
        const marker = json.slice(0, bodyStart)
        const body = JSON.parse(
          json.slice(bodyStart),
          marker
            ? (_k, v) =>
                v === '~i'
                  ? Infinity
                  : v === '~m'
                    ? -Infinity
                    : v === '~n'
                      ? NaN
                      : typeof v === 'string' && v.startsWith('~~')
                        ? v.slice(1)
                        : v
            : undefined,
        ) as Record<string, unknown>
        o += dataLen
        components.push({ type, ...body } as Component)
      }
      entities.push({ id, components })
    }

    this.restoreSnapshot({ nextId, rngState, entities })
  }

  // ── Delta snapshot ──────────────────────────────────────────────────────────

  /**
   * Compute a delta snapshot relative to `baseline`.
   *
   * Only includes entities whose components differ from `baseline`.
   * Entities deleted since `baseline` appear in `removed`.
   *
   * Pair with `applyDeltaSnapshot` to reconstruct the full snapshot from a
   * baseline + a sequence of deltas without sending full world state each tick.
   */
  getDeltaSnapshot(baseline: WorldSnapshot): DeltaSnapshot {
    const baseMap = new Map(baseline.entities.map((e) => [e.id, e]))
    const changed: WorldSnapshot['entities'] = []
    const removed: number[] = []

    // Compare live column storage against the baseline without cloning
    // unchanged entities — only entities that actually changed are cloned.
    for (let slot = 0; slot < this.liveCount; slot++) {
      const id = this.idOfSlot[slot]
      const base = baseMap.get(id)
      // Build the live component list lazily: first detect a difference via
      // counts, then clone only when needed.
      let count = 0
      for (let tid = 0; tid < this.columns.length; tid++) {
        if (this.columns[tid].sparse[slot] !== -1) count++
      }
      if (!base) {
        changed.push({ id, components: this.cloneComponentsAt(slot, count) })
        continue
      }
      const liveComps = this.liveComponentsAt(slot, count)
      if (_componentsChanged(liveComps, base.components)) {
        changed.push({ id, components: liveComps.map(_cloneComponent) })
      }
    }

    for (const { id } of baseline.entities) {
      if (this.slotOf(id) < 0) removed.push(id)
    }

    return { nextId: this.nextId, rngState: this._rngState, changed, removed }
  }

  /** Materialise this slot's components (order = column order). */
  private liveComponentsAt(slot: number, knownCount: number): Component[] {
    const out: Component[] = new Array(knownCount)
    let n = 0
    for (let tid = 0; tid < this.columns.length; tid++) {
      const col = this.columns[tid]
      const idx = col.sparse[slot]
      if (idx !== -1) out[n++] = col.dense[idx]
    }
    return out
  }

  private cloneComponentsAt(slot: number, knownCount: number): Component[] {
    return this.liveComponentsAt(slot, knownCount).map(_cloneComponent)
  }

  /** Appends `system`, or inserts it before `before` when given and present. */
  addSystem(system: System, before?: System): void {
    const i = before ? this.systems.indexOf(before) : -1
    if (i === -1) this.systems.push(system)
    else this.systems.splice(i, 0, system)
  }

  removeSystem(system: System): void {
    const idx = this.systems.indexOf(system)
    if (idx !== -1) this.systems.splice(idx, 1)
  }

  update(dt: number): void {
    for (const system of this.systems) {
      system.update(this, dt)
    }
  }

  clear(): void {
    // Keep the interned type table and the column objects: callers cache
    // numeric type IDs (`typeId`) for the world's lifetime, so a reset must
    // not renumber them. Only the contents are dropped. Do not clear typeIds
    // here, even though it looks like the obvious reset.
    for (const col of this.columns) {
      col.dense.length = 0
      col.ownerSlot.length = 0
      col.sparse.fill(-1)
    }
    this.slotOfId.fill(-1)
    this.idOfSlot.fill(-1)
    this.liveCount = 0
    this.archetypes.clear()
    this.typeIndex.clear()
    this.entityArchetype.clear()
    this.entityPos.clear()
    this.queryCache.clear()
    this.cacheKeysByType.clear()
    this.dirtyTypes.clear()
    this.dirtyAll = false
    this.nextId = 0
    // `_deterministic` is world configuration, not state, so it is deliberately
    // kept: a reset or a restore must not silently fall back to Math.random()
    // (rollback and replay would diverge). The stream restarts from zero like
    // the rest of the reset.
    this._rngState = 0
  }

  get entityCount(): number {
    return this.liveCount
  }
}
