/**
 * Impulse-based 2D physics system.
 *
 * Replaces the old AABB platformer-style X-then-Y resolution with a proper
 * sequential impulse constraint solver. Handles arbitrary collision normals,
 * angular momentum, mass-based response, and Coulomb friction.
 *
 * Pipeline per fixed step:
 *  1. Classify entities → compute mass properties
 *  2. Apply forces (gravity, user forces, damping)
 *  3. Broad phase (spatial grid)
 *  4. Narrow phase (generate contact manifolds)
 *  5. Initialize + warm-start constraints
 *  6. Velocity solver iterations (normal + friction impulses)
 *  7. Integrate positions (x += vx·dt)
 *  8. Position solver iterations (Baumgarte penetration correction)
 *  9. CCD pass, ground detection, sleep, contact events
 *
 * Reference: Rapier (src/dynamics/solver), Box2D (b2ContactSolver)
 */

import type { System, ECSWorld, EntityId } from '@xip/core'
import type { TransformComponent } from '@xip/core'
import type { EventBus } from '@xip/core'
import type { RigidBodyComponent } from './components/rigidbody'
import type { BoxColliderComponent } from './components/boxCollider'
import type { CircleColliderComponent } from './components/circleCollider'
import type { CapsuleColliderComponent } from './components/capsuleCollider'
import type { CompoundColliderComponent, ColliderShape } from './components/compoundCollider'
import type { ConvexPolygonColliderComponent } from './components/convexPolygonCollider'
import type { TriangleColliderComponent } from './components/triangleCollider'
import type { SegmentColliderComponent } from './components/segmentCollider'
import type { HeightFieldColliderComponent } from './components/heightFieldCollider'
import type { HalfSpaceColliderComponent } from './components/halfSpaceCollider'
import type { TriMeshColliderComponent } from './components/triMeshCollider'
import type { JointComponent } from './components/joint'
import type { ContactManifold } from './contactManifold'
import {
  generateBoxBoxManifold,
  generateCircleCircleManifold,
  generateCircleBoxManifold,
  generateCapsuleBoxManifold,
  generateCapsuleCircleManifold,
  generateCapsuleCapsuleManifold,
  warmStartManifold,
} from './contactManifold'
import {
  generatePolygonPolygonManifold,
  generatePolygonCircleManifold,
  generatePolygonBoxManifold,
  generateSegmentCircleManifold,
  generateSegmentBoxManifold,
  generateHalfSpaceCircleManifold,
  generateHalfSpaceBoxManifold,
  generateHeightFieldCircleManifold,
  generateHeightFieldBoxManifold,
} from './satManifold'
import { generateTriMeshCircleManifold, generateTriMeshBoxManifold } from './triMeshManifold'
import { buildBVH } from './bvh'
import type { BVH } from './bvh'
import {
  boxMassProperties,
  circleMassProperties,
  capsuleMassProperties,
  polygonMassProperties,
  triangleMassProperties,
  parallelAxis,
} from './massProperties'
import { combineCoefficients } from './combineRules'
import type { SolverBody } from './impulseSolver'
import {
  initializeConstraints,
  solveVelocities,
  solvePositions,
  initializePseudoVelocities,
  integratePseudoVelocities,
} from './impulseSolver'

// ── Physics configuration ───────────────────────────────────────────────────

/**
 * Physics hooks — user-provided callbacks for filtering and modifying contacts.
 */
export interface PhysicsHooks {
  /** Return false to skip contact generation between a pair. */
  onContactFilter?: (entityA: EntityId, entityB: EntityId) => boolean
  /** Return false to skip sensor intersection events for a pair. */
  onIntersectionFilter?: (entityA: EntityId, entityB: EntityId) => boolean
  /** Modify solver contacts — can change friction, restitution, normal, or set tangent velocity. */
  onContactModify?: (manifold: ContactManifold) => void
}

// ── Per-world interned type IDs ──────────────────────────────────────────────
// Numeric component-type IDs skip the string hash on every getComponent in
// the per-entity pair scans below. Cached per world instance (WeakMap).
interface PhysicsTypeIds {
  transform: number
  rigidBody: number
  box: number
  circle: number
  polygon: number
  capsule: number
  triangle: number
  compound: number
}
const _typeIdCache = new WeakMap<object, PhysicsTypeIds>()
function tids(world: ECSWorld): PhysicsTypeIds {
  let t = _typeIdCache.get(world)
  if (!t) {
    t = {
      transform: world.typeId('Transform'),
      rigidBody: world.typeId('RigidBody'),
      box: world.typeId('BoxCollider'),
      circle: world.typeId('CircleCollider'),
      polygon: world.typeId('ConvexPolygonCollider'),
      capsule: world.typeId('CapsuleCollider'),
      triangle: world.typeId('TriangleCollider'),
      compound: world.typeId('CompoundCollider'),
    }
    _typeIdCache.set(world, t)
  }
  return t
}

export interface PhysicsConfig {
  /** Number of velocity constraint solver iterations. Default: 8 */
  velocityIterations: number
  /** Number of position correction iterations. Default: 4 */
  positionIterations: number
  /** Position correction factor (Baumgarte β). Default: 0.2 */
  positionCorrectionBeta: number
  /** Allowed penetration before correction kicks in. Default: 0.5 */
  penetrationSlop: number
  /** Velocity below which restitution is ignored. Default: 20 */
  restitutionThreshold: number
  /** Enable warm starting from cached impulses. Default: true */
  warmStarting: boolean
  /** Warm starting factor (0–1). Default: 0.85 */
  warmStartingFactor: number
  /** Default density for auto mass computation. Default: 1.0 */
  defaultDensity: number
  /** Number of sub-steps per fixed step. Default: 1 (no sub-stepping) */
  substeps: number
  /** Minimum contact force impulse to emit contactForce events. Default: 0 (emit all) */
  contactForceThreshold: number
}

const DEFAULT_CONFIG: PhysicsConfig = {
  velocityIterations: 8,
  positionIterations: 4,
  positionCorrectionBeta: 0.2,
  penetrationSlop: 0.5,
  restitutionThreshold: 20,
  warmStarting: true,
  warmStartingFactor: 0.85,
  defaultDensity: 1,
  substeps: 1,
  contactForceThreshold: 0,
}

// ── AABB helpers ────────────────────────────────────────────────────────────

interface AABB {
  cx: number
  cy: number
  hw: number
  hh: number
}

function getAABB(transform: TransformComponent, collider: BoxColliderComponent): AABB {
  return {
    cx: transform.x + collider.offsetX,
    cy: transform.y + collider.offsetY,
    hw: collider.width / 2,
    hh: collider.height / 2,
  }
}

function getCapsuleAABB(transform: TransformComponent, capsule: CapsuleColliderComponent): AABB {
  return {
    cx: transform.x + capsule.offsetX,
    cy: transform.y + capsule.offsetY,
    hw: capsule.width / 2,
    hh: capsule.height / 2,
  }
}

function getOverlap(a: AABB, b: AABB): { x: number; y: number } | null {
  const dx = a.cx - b.cx
  const dy = a.cy - b.cy
  const ox = a.hw + b.hw - Math.abs(dx)
  const oy = a.hh + b.hh - Math.abs(dy)
  if (ox <= 0 || oy <= 0) return null
  return { x: dx >= 0 ? ox : -ox, y: dy >= 0 ? oy : -oy }
}

/**
 * For a sloped collider, computes the surface Y at the given world X.
 */
function getSlopeSurfaceY(st: TransformComponent, sc: BoxColliderComponent, worldX: number): number | null {
  const hw = sc.width / 2
  const hh = sc.height / 2
  const cx = st.x + sc.offsetX
  const cy = st.y + sc.offsetY
  const left = cx - hw
  const right = cx + hw
  if (worldX < left || worldX > right) return null
  const dx = worldX - left
  const angleRad = sc.slope * (Math.PI / 180)
  return cy - hh + dx * Math.tan(angleRad)
}

// ── Layer / mask filtering ──────────────────────────────────────────────────

function maskAllows(mask: string | string[], layer: string): boolean {
  if (mask === '*') return true
  if (Array.isArray(mask)) return mask.includes(layer)
  return mask === layer
}

function canInteract(
  aLayer: string,
  aMask: string | string[],
  bLayer: string,
  bMask: string | string[],
  aGroup?: string,
  bGroup?: string,
): boolean {
  // Same non-empty group → skip (e.g. parts of the same character)
  if (aGroup && bGroup && aGroup === bGroup) return false
  return maskAllows(aMask, bLayer) && maskAllows(bMask, aLayer)
}

// ── Compound collider helpers ───────────────────────────────────────────────

function shapeToAABB(tx: number, ty: number, shape: ColliderShape): AABB {
  if (shape.type === 'box') {
    return { cx: tx + shape.offsetX, cy: ty + shape.offsetY, hw: (shape.width ?? 0) / 2, hh: (shape.height ?? 0) / 2 }
  }
  const r = shape.radius ?? 0
  return { cx: tx + shape.offsetX, cy: ty + shape.offsetY, hw: r, hh: r }
}

function shapeOverlapsAABB(tx: number, ty: number, shape: ColliderShape, other: AABB): boolean {
  if (shape.type === 'box') return !!getOverlap(shapeToAABB(tx, ty, shape), other)
  const r = shape.radius ?? 0
  const cx = tx + shape.offsetX
  const cy = ty + shape.offsetY
  const nearX = Math.max(other.cx - other.hw, Math.min(cx, other.cx + other.hw))
  const nearY = Math.max(other.cy - other.hh, Math.min(cy, other.cy + other.hh))
  const dx = cx - nearX
  const dy = cy - nearY
  return dx * dx + dy * dy < r * r
}

function shapeOverlapsCircle(
  tx: number,
  ty: number,
  shape: ColliderShape,
  cx: number,
  cy: number,
  cr: number,
): boolean {
  if (shape.type === 'circle') {
    const r = shape.radius ?? 0
    const dx = tx + shape.offsetX - cx
    const dy = ty + shape.offsetY - cy
    return dx * dx + dy * dy < (r + cr) * (r + cr)
  }
  const aabb = shapeToAABB(tx, ty, shape)
  const nearX = Math.max(aabb.cx - aabb.hw, Math.min(cx, aabb.cx + aabb.hw))
  const nearY = Math.max(aabb.cy - aabb.hh, Math.min(cy, aabb.cy + aabb.hh))
  const dx = cx - nearX
  const dy = cy - nearY
  return dx * dx + dy * dy < cr * cr
}

function getCompoundBounds(tx: number, ty: number, shapes: ColliderShape[]): AABB {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of shapes) {
    const a = shapeToAABB(tx, ty, s)
    if (a.cx - a.hw < minX) minX = a.cx - a.hw
    if (a.cx + a.hw > maxX) maxX = a.cx + a.hw
    if (a.cy - a.hh < minY) minY = a.cy - a.hh
    if (a.cy + a.hh > maxY) maxY = a.cy + a.hh
  }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, hw: (maxX - minX) / 2, hh: (maxY - minY) / 2 }
}

function polygonWorldAABB(
  vertices: { x: number; y: number }[],
  tx: number,
  ty: number,
  offX: number,
  offY: number,
): AABB {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const v of vertices) {
    const wx = tx + offX + v.x
    const wy = ty + offY + v.y
    if (wx < minX) minX = wx
    if (wx > maxX) maxX = wx
    if (wy < minY) minY = wy
    if (wy > maxY) maxY = wy
  }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, hw: (maxX - minX) / 2, hh: (maxY - minY) / 2 }
}

// ── Swept AABB (CCD) ───────────────────────────────────────────────────────

function sweepAABB(aCx: number, aCy: number, aHw: number, aHh: number, dx: number, dy: number, b: AABB): number | null {
  const eHw = b.hw + aHw
  const eHh = b.hh + aHh
  const left = b.cx - eHw
  const right = b.cx + eHw
  const top = b.cy - eHh
  const bottom = b.cy + eHh
  let tmin = -Infinity
  let tmax = Infinity
  if (dx !== 0) {
    const t1 = (left - aCx) / dx
    const t2 = (right - aCx) / dx
    tmin = Math.max(tmin, Math.min(t1, t2))
    tmax = Math.min(tmax, Math.max(t1, t2))
  } else if (aCx < left || aCx > right) return null
  if (dy !== 0) {
    const t1 = (top - aCy) / dy
    const t2 = (bottom - aCy) / dy
    tmin = Math.max(tmin, Math.min(t1, t2))
    tmax = Math.min(tmax, Math.max(t1, t2))
  } else if (aCy < top || aCy > bottom) return null
  if (tmax < 0 || tmin > tmax || tmin > 1) return null
  const t = Math.max(0, tmin)
  return t > 1 ? null : t
}

// ── Contact pair tracking ───────────────────────────────────────────────────

// Packed numeric pair key — canonical order (min first), exact for entity
// IDs < 2^26 (~67M; IDs may be reused after clear/restore). Zero string
// allocation per contact pair per frame.
// Ids below 2^15 pack into a small integer (no boxed double in Maps); larger
// ids use a disjoint range above 2^30.
const PAIR_MUL = 0x4000000 // 2^26
function pairKey(a: EntityId, b: EntityId): number {
  const lo = a < b ? a : b
  const hi = a < b ? b : a
  return hi < 0x8000 ? (lo << 15) | hi : 0x40000000 + lo * PAIR_MUL + hi
}

// A contact wakes a sleeping body only when the other body is moving; two
// sleeping bodies (or sleeping-on-static) stay asleep.
function wakePair(a: RigidBodyComponent, b: RigidBodyComponent): void {
  if (a.sleeping === b.sleeping) return
  const sleeper = a.sleeping ? a : b
  const other = a.sleeping ? b : a
  // A neighbour that is itself settling (sleepTimer > 0) doesn't count as moving.
  if (other.isStatic || other.sleepTimer > 0) return
  sleeper.sleeping = false
  sleeper.sleepTimer = 0
}

/** Shared immutable placeholder for entities excluded from spatial pairing. */

// Map whose clear() is O(1): entries carry the generation they were written
// in, so refilling every step overwrites slots instead of rehashing a fresh
// table. Stale entries are pruned when they outnumber live ones.
class GenerationCache<V> {
  private readonly map = new Map<number, { gen: number; value: V }>()
  private gen = 0
  private live = 0

  get(key: number): V | undefined {
    const e = this.map.get(key)
    return e !== undefined && e.gen === this.gen ? e.value : undefined
  }

  set(key: number, value: V): void {
    const e = this.map.get(key)
    if (e === undefined) this.map.set(key, { gen: this.gen, value })
    else {
      e.gen = this.gen
      e.value = value
    }
    this.live++
  }

  clear(): void {
    if (this.map.size > 64 && this.map.size > this.live * 2) {
      const gen = this.gen
      this.map.forEach((e, k) => {
        if (e.gen !== gen) this.map.delete(k)
      })
    }
    this.gen++
    this.live = 0
  }
}

// ── Physics System ──────────────────────────────────────────────────────────

export class PhysicsSystem implements System {
  private accumulator = 0
  private readonly FIXED_DT = 1 / 60
  private readonly MAX_ACCUMULATOR = 0.1
  private readonly config: PhysicsConfig

  // Contact event tracking
  private activeTriggerPairs = new Map<number, [EntityId, EntityId]>()
  private activeCollisionPairs = new Map<number, [EntityId, EntityId]>()
  private activeCirclePairs = new Map<number, [EntityId, EntityId]>()
  private activeCompoundPairs = new Map<number, [EntityId, EntityId]>()
  private activeCapsulePairs = new Map<number, [EntityId, EntityId]>()
  private activePolygonPairs = new Map<number, [EntityId, EntityId]>()

  // Platform carry tracking
  private staticPrevPos = new Map<EntityId, { x: number; y: number }>()

  // Manifold cache for warm starting
  private manifoldCache = new GenerationCache<ContactManifold>()

  // Collider keys keep the cache valid across entity ID reuse and allow
  // discarded collider instances to be collected with their BVHs.
  private bvhCache = new WeakMap<
    TriMeshColliderComponent,
    { bvh: BVH; vertices: { x: number; y: number }[]; indices: number[] }
  >()

  // Physics hooks for filtering and modifying contacts
  private hooks: PhysicsHooks = {}

  // ── Scratch containers — reused every frame to avoid GC pressure ──────────
  //
  // Previously these were allocated fresh inside update() every substep,
  // producing ~20 Map/Set allocations per frame. Now they live as instance
  // fields and are cleared at the start of each use. Never escape the class.
  //
  // The _current*Pairs fields are double-buffered with their active*Pairs
  // counterparts: at the end of each substep, the filled "current" is swapped
  // with "active", and next substep clears the new "current" (which was the
  // previous "active"). Same enter/stay/exit event semantics, zero allocation.

  private _staticDelta = new Map<EntityId, { dx: number; dy: number }>()
  private readonly _preStepX: number[] = []
  private readonly _preStepY: number[] = []
  private _spatialGrid = new Map<number, EntityId[]>()
  private _jointExcludedPairs = new Set<number>()
  private _solverBodies = new Map<number, SolverBody>()
  private readonly _solverPool: SolverBody[] = []
  private _solverPoolUsed = 0
  private solverBody(id: EntityId, t: TransformComponent, rb: RigidBodyComponent | null): SolverBody {
    // Sleeping bodies are immovable for the solver; their own supports are skipped.
    if (rb !== null && rb.sleeping) rb = null
    let b = this._solverPool[this._solverPoolUsed]
    if (b === undefined) {
      b = {} as SolverBody
      this._solverPool.push(b)
    }
    this._solverPoolUsed++
    b.entityId = id
    b.x = t.x
    b.y = t.y
    b.rotation = t.rotation
    b.vx = rb ? rb.vx : 0
    b.vy = rb ? rb.vy : 0
    b.angVel = rb ? rb.angularVelocity : 0
    b.invMass = rb ? rb.invMass : 0
    b.invInertia = rb ? rb.invInertia : 0
    b.dominance = rb ? rb.dominance : 0
    b.pvx = 0
    b.pvy = 0
    b.pAngVel = 0
    return b
  }
  private _triggerNormals = new Map<number, { nx: number; ny: number }>()
  private _circleNormals = new Map<number, { nx: number; ny: number }>()
  /** Shared scratch for per-body "checked" neighbor dedup; cleared per iteration. */
  private _checkedScratch = new Set<EntityId>()
  private _pairGridScratch = new Map<number, EntityId[]>()
  private _currentCollisionPairs = new Map<number, [EntityId, EntityId]>()
  private _currentTriggerPairs = new Map<number, [EntityId, EntityId]>()
  private _currentCirclePairs = new Map<number, [EntityId, EntityId]>()
  private _currentCompoundPairs = new Map<number, [EntityId, EntityId]>()
  private _currentCapsulePairs = new Map<number, [EntityId, EntityId]>()
  private _currentPolygonPairs = new Map<number, [EntityId, EntityId]>()
  /** Reused across steps instead of `[...staticBox, ...kinematicBox]` every step. */
  private _nonDynamicScratch: EntityId[] = []
  /** Reused across steps instead of a 5-way array spread-concat every step. */
  private _allDynamicsScratch: EntityId[] = []
  private readonly _idScratch: EntityId[][] = []
  private scratchIds(i: number): EntityId[] {
    const a = this._idScratch[i] ?? (this._idScratch[i] = [])
    a.length = 0
    return a
  }

  constructor(
    private gravity: number,
    private readonly events?: EventBus,
    config?: Partial<PhysicsConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Set physics hooks for contact filtering and modification. */
  setHooks(hooks: PhysicsHooks): void {
    this.hooks = hooks
  }

  setGravity(g: number): void {
    this.gravity = g
  }

  update(world: ECSWorld, dt: number): void {
    this.accumulator += dt
    if (this.accumulator > this.MAX_ACCUMULATOR) this.accumulator = this.MAX_ACCUMULATOR
    while (this.accumulator >= this.FIXED_DT) {
      const substeps = Math.max(1, this.config.substeps)
      const subDt = this.FIXED_DT / substeps
      for (let s = 0; s < substeps; s++) {
        this.step(world, subDt)
      }
      this.accumulator -= this.FIXED_DT
    }
  }

  // ── Spatial grid ────────────────────────────────────────────────────────

  // Spatial cells are bit-packed numbers (±32767 cells per axis ≈ ±4.2M px
  // at CELL=128), so per-body cell enumeration never builds strings.
  private getCells(cx: number, cy: number, hw: number, hh: number): number[] {
    const CELL = 128
    const x0 = Math.floor((cx - hw) / CELL)
    const x1 = Math.floor((cx + hw) / CELL)
    const y0 = Math.floor((cy - hh) / CELL)
    const y1 = Math.floor((cy + hh) / CELL)
    const cells: number[] = []
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        cells.push(((x + 32768) << 16) | (y + 32768))
      }
    }
    return cells
  }

  /**
   * Invoke `cb(ia, ib)` once for every unordered pair in `ids` whose AABBs
   * overlap (touching counts). `getBounds` returning null excludes an entity.
   */
  private forEachSpatialCandidatePair(
    ids: EntityId[],
    getBounds: (id: EntityId) => { cx: number; cy: number; hw: number; hh: number } | null,
    cb: (ia: EntityId, ib: EntityId) => void,
  ): void {
    const n = ids.length
    if (n < 2) return
    this.loadBounds(0, ids, getBounds)
    const cell = this.chooseCell(0, n)
    this.fillGrid(0, n, cell)
    const { _bx0: X0, _bx1: X1, _by0: Y0, _by1: Y1, _cx0: C0, _cx1: C1, _cy0: D0, _cy1: D1 } = this
    const grid = this._pairGridScratch
    for (let i = 0; i < n; i++) {
      if (C0[i] > C1[i]) continue
      const ax0 = X0[i],
        ax1 = X1[i],
        ay0 = Y0[i],
        ay1 = Y1[i]
      const ci0 = C0[i],
        di0 = D0[i]
      for (let x = ci0; x <= C1[i]; x++) {
        for (let y = di0; y <= D1[i]; y++) {
          const bucket = grid.get(((x + 32768) << 16) | (y + 32768))
          if (bucket === undefined) continue
          for (let k = 0; k < bucket.length; k++) {
            const j = bucket[k]
            if (j <= i) continue
            if (X0[j] > ax1 || X1[j] < ax0 || Y0[j] > ay1 || Y1[j] < ay0) continue
            // Report each pair only in the first cell both boxes share.
            if (x !== (C0[j] > ci0 ? C0[j] : ci0) || y !== (D0[j] > di0 ? D0[j] : di0)) continue
            cb(ids[i], ids[j])
          }
        }
      }
    }
  }

  /** Cross-set variant: pairs (a in idsA, b in idsB) with overlapping AABBs, a !== b. */
  private forEachSpatialCandidateCrossPair(
    idsA: EntityId[],
    idsB: EntityId[],
    getBoundsA: (id: EntityId) => { cx: number; cy: number; hw: number; hh: number } | null,
    getBoundsB: (id: EntityId) => { cx: number; cy: number; hw: number; hh: number } | null,
    cb: (a: EntityId, b: EntityId) => void,
  ): void {
    const na = idsA.length
    const nb = idsB.length
    if (na === 0 || nb === 0) return
    this.loadBounds(0, idsB, getBoundsB)
    this.loadBounds(nb, idsA, getBoundsA)
    const cell = this.chooseCell(0, nb + na)
    this.fillGrid(0, nb, cell)
    const inv = 1 / cell
    const { _bx0: X0, _bx1: X1, _by0: Y0, _by1: Y1, _cx0: C0, _cy0: D0 } = this
    const grid = this._pairGridScratch
    for (let ia = 0; ia < na; ia++) {
      const i = nb + ia
      const ax0 = X0[i]
      if (ax0 > X1[i]) continue
      const ax1 = X1[i],
        ay0 = Y0[i],
        ay1 = Y1[i]
      const ci0 = Math.floor(ax0 * inv),
        ci1 = Math.floor(ax1 * inv),
        di0 = Math.floor(ay0 * inv),
        di1 = Math.floor(ay1 * inv)
      const idA = idsA[ia]
      for (let x = ci0; x <= ci1; x++) {
        for (let y = di0; y <= di1; y++) {
          const bucket = grid.get(((x + 32768) << 16) | (y + 32768))
          if (bucket === undefined) continue
          for (let k = 0; k < bucket.length; k++) {
            const j = bucket[k]
            if (X0[j] > ax1 || X1[j] < ax0 || Y0[j] > ay1 || Y1[j] < ay0) continue
            if (x !== (C0[j] > ci0 ? C0[j] : ci0) || y !== (D0[j] > di0 ? D0[j] : di0)) continue
            const idB = idsB[j]
            if (idB !== idA) cb(idA, idB)
          }
        }
      }
    }
  }

  private _bx0 = new Float64Array(256)
  private _bx1 = new Float64Array(256)
  private _by0 = new Float64Array(256)
  private _by1 = new Float64Array(256)
  private _cx0 = new Int32Array(256)
  private _cx1 = new Int32Array(256)
  private _cy0 = new Int32Array(256)
  private _cy1 = new Int32Array(256)
  private readonly _bucketPool: number[][] = []

  /** Writes AABBs for `ids` at offset `at`; excluded entities get an empty box (x0 > x1). */
  private loadBounds(
    at: number,
    ids: EntityId[],
    getBounds: (id: EntityId) => { cx: number; cy: number; hw: number; hh: number } | null,
  ): void {
    const need = at + ids.length
    if (need > this._bx0.length) {
      const size = Math.max(need, this._bx0.length * 2)
      const grow = <T extends Float64Array | Int32Array>(old: T, make: new (n: number) => T): T => {
        const next = new make(size)
        next.set(old)
        return next
      }
      this._bx0 = grow(this._bx0, Float64Array)
      this._bx1 = grow(this._bx1, Float64Array)
      this._by0 = grow(this._by0, Float64Array)
      this._by1 = grow(this._by1, Float64Array)
      this._cx0 = grow(this._cx0, Int32Array)
      this._cx1 = grow(this._cx1, Int32Array)
      this._cy0 = grow(this._cy0, Int32Array)
      this._cy1 = grow(this._cy1, Int32Array)
    }
    for (let k = 0; k < ids.length; k++) {
      const b = getBounds(ids[k])
      const i = at + k
      if (b === null) {
        this._bx0[i] = 1
        this._bx1[i] = 0
        continue
      }
      this._bx0[i] = b.cx - b.hw
      this._bx1[i] = b.cx + b.hw
      this._by0[i] = b.cy - b.hh
      this._by1[i] = b.cy + b.hh
    }
  }

  /** Cell size ~4x the median-ish body extent, so most bodies touch 1-4 cells. */
  private chooseCell(from: number, to: number): number {
    let sum = 0
    let count = 0
    for (let i = from; i < to; i++) {
      const w = this._bx1[i] - this._bx0[i]
      if (w < 0) continue
      const h = this._by1[i] - this._by0[i]
      sum += w > h ? w : h
      count++
    }
    if (count === 0) return 128
    const avg = sum / count
    return Math.min(512, Math.max(16, avg * 2))
  }

  private fillGrid(from: number, to: number, cell: number): void {
    const grid = this._pairGridScratch
    const pool = this._bucketPool
    for (const bucket of grid.values()) {
      bucket.length = 0
      pool.push(bucket)
    }
    grid.clear()
    const inv = 1 / cell
    const { _bx0: X0, _bx1: X1, _by0: Y0, _by1: Y1, _cx0: C0, _cx1: C1, _cy0: D0, _cy1: D1 } = this
    for (let i = from; i < to; i++) {
      if (X0[i] > X1[i]) {
        C0[i] = 1
        C1[i] = 0
        continue
      }
      const x0 = (C0[i] = Math.floor(X0[i] * inv))
      const x1 = (C1[i] = Math.floor(X1[i] * inv))
      const y0 = (D0[i] = Math.floor(Y0[i] * inv))
      const y1 = (D1[i] = Math.floor(Y1[i] * inv))
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = ((x + 32768) << 16) | (y + 32768)
          let bucket = grid.get(key)
          if (bucket === undefined) {
            bucket = pool.pop() ?? []
            grid.set(key, bucket)
          }
          bucket.push(i)
        }
      }
    }
  }

  // ── Mass properties ─────────────────────────────────────────────────────

  private computeMassProperties(
    rb: RigidBodyComponent,
    boxCol?: BoxColliderComponent,
    circleCol?: CircleColliderComponent,
    capsuleCol?: CapsuleColliderComponent,
    polygonCol?: ConvexPolygonColliderComponent,
    triangleCol?: TriangleColliderComponent,
  ): void {
    if (!rb._massPropertiesDirty) return
    rb._massPropertiesDirty = false

    if (rb.isStatic || rb.isKinematic) {
      rb.invMass = 0
      rb.invInertia = 0
      rb.inertia = 0
      return
    }

    const density = rb.density > 0 ? rb.density : this.config.defaultDensity
    let mass: number
    let inertia: number

    if (rb.mass > 0) {
      // Explicit mass — still compute inertia from shape
      mass = rb.mass
      if (boxCol) {
        const props = boxMassProperties(boxCol.width, boxCol.height, density)
        inertia = props.inertia * (mass / props.mass)
      } else if (circleCol) {
        const props = circleMassProperties(circleCol.radius, density)
        inertia = props.inertia * (mass / props.mass)
      } else if (capsuleCol) {
        const props = capsuleMassProperties(capsuleCol.width, capsuleCol.height, density)
        inertia = props.inertia * (mass / props.mass)
      } else if (polygonCol) {
        const props = polygonMassProperties(polygonCol.vertices, density)
        inertia = props.mass > 0 ? props.inertia * (mass / props.mass) : mass
      } else if (triangleCol) {
        const props = triangleMassProperties(triangleCol.a, triangleCol.b, triangleCol.c, density)
        inertia = props.mass > 0 ? props.inertia * (mass / props.mass) : mass
      } else {
        inertia = mass // fallback
      }
    } else {
      // Auto-compute from density × area
      if (boxCol) {
        const props = boxMassProperties(boxCol.width, boxCol.height, density)
        mass = props.mass
        inertia = props.inertia
        // Parallel axis theorem for offset colliders
        if (boxCol.offsetX !== 0 || boxCol.offsetY !== 0) {
          inertia = parallelAxis(inertia, mass, boxCol.offsetX, boxCol.offsetY)
        }
      } else if (circleCol) {
        const props = circleMassProperties(circleCol.radius, density)
        mass = props.mass
        inertia = props.inertia
        if (circleCol.offsetX !== 0 || circleCol.offsetY !== 0) {
          inertia = parallelAxis(inertia, mass, circleCol.offsetX, circleCol.offsetY)
        }
      } else if (capsuleCol) {
        const props = capsuleMassProperties(capsuleCol.width, capsuleCol.height, density)
        mass = props.mass
        inertia = props.inertia
        if (capsuleCol.offsetX !== 0 || capsuleCol.offsetY !== 0) {
          inertia = parallelAxis(inertia, mass, capsuleCol.offsetX, capsuleCol.offsetY)
        }
      } else if (polygonCol) {
        const props = polygonMassProperties(polygonCol.vertices, density)
        mass = props.mass
        inertia = props.inertia
        if (polygonCol.offsetX !== 0 || polygonCol.offsetY !== 0) {
          inertia = parallelAxis(inertia, mass, polygonCol.offsetX, polygonCol.offsetY)
        }
      } else if (triangleCol) {
        const props = triangleMassProperties(triangleCol.a, triangleCol.b, triangleCol.c, density)
        mass = props.mass
        inertia = props.inertia
        if (triangleCol.offsetX !== 0 || triangleCol.offsetY !== 0) {
          inertia = parallelAxis(inertia, mass, triangleCol.offsetX, triangleCol.offsetY)
        }
      } else {
        mass = 1
        inertia = 1
      }
    }

    rb.mass = mass
    rb.inertia = inertia
    rb.invMass = mass > 0 ? 1 / mass : 0
    rb.invInertia = rb.lockRotation || inertia <= 0 ? 0 : 1 / inertia
  }

  // ── Main step ───────────────────────────────────────────────────────────

  private step(world: ECSWorld, dt: number): void {
    const T = tids(world)
    // ── Phase 0: Classify entities ────────────────────────────────────────

    const allBox = world.query('Transform', 'RigidBody', 'BoxCollider')
    const allCircle = world.query('Transform', 'CircleCollider')
    const allCapsule = world.query('Transform', 'RigidBody', 'CapsuleCollider')

    const dynamicBox = this.scratchIds(0)
    const staticBox = this.scratchIds(1)
    const kinematicBox = this.scratchIds(2)

    for (const id of allBox) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      if (!rb.enabled) continue
      if (rb.isStatic) staticBox.push(id)
      else if (rb.isKinematic) kinematicBox.push(id)
      else dynamicBox.push(id)
    }

    const dynamicCircle = this.scratchIds(3)
    const staticCircle = this.scratchIds(4)
    for (const id of allCircle) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)
      if (rb && !rb.enabled) continue
      if (!rb) continue
      if (rb.isStatic || rb.isKinematic) staticCircle.push(id)
      else dynamicCircle.push(id)
    }

    const capsuleDynamics = this.scratchIds(5)
    const contactCapsules = this.scratchIds(6)
    for (const id of allCapsule) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      if (!rb.enabled) continue
      if (!rb.isStatic) {
        contactCapsules.push(id)
        if (!rb.isKinematic) capsuleDynamics.push(id)
      }
    }

    const allPolygon = world.query('Transform', 'RigidBody', 'ConvexPolygonCollider')
    const allTriangle = world.query('Transform', 'RigidBody', 'TriangleCollider')
    const allSegment = world.query('Transform', 'SegmentCollider')
    const allHeightField = world.query('Transform', 'HeightFieldCollider')
    const allHalfSpace = world.query('Transform', 'HalfSpaceCollider')
    const allTriMesh = world.query('Transform', 'TriMeshCollider')

    const dynamicPolygon = this.scratchIds(7)
    const staticPolygon = this.scratchIds(8)
    for (const id of allPolygon) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      if (!rb.enabled) continue
      if (rb.isStatic || rb.isKinematic) staticPolygon.push(id)
      else dynamicPolygon.push(id)
    }

    const dynamicTriangle = this.scratchIds(9)
    const staticTriangle = this.scratchIds(10)
    for (const id of allTriangle) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      if (!rb.enabled) continue
      if (rb.isStatic || rb.isKinematic) staticTriangle.push(id)
      else dynamicTriangle.push(id)
    }

    // All static-like entities for spatial grid (statics + kinematics)
    const nonDynamic = this._nonDynamicScratch
    nonDynamic.length = 0
    for (const id of staticBox) nonDynamic.push(id)
    for (const id of kinematicBox) nonDynamic.push(id)

    // ── Prune dead entity pairs ───────────────────────────────────────────

    this.pruneDeadPairs(world)

    // ── Phase 0.5: Kinematic position-based mode ──────────────────────────
    // Apply explicit kinematic targets before static deltas, spatial grids,
    // and contacts are built. The computed velocity is preserved so dynamic
    // bodies see the kinematic motion through the solver.

    for (const id of world.query('Transform', 'RigidBody')) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      if (!rb.isKinematic || !rb.enabled) continue
      const t = world.getComponent<TransformComponent>(id, T.transform)!
      if (rb._nextKinematicX !== null || rb._nextKinematicY !== null) {
        if (rb._nextKinematicX !== null) {
          rb.vx = (rb._nextKinematicX - t.x) / dt
          t.x = rb._nextKinematicX
        } else {
          rb.vx = 0
        }
        if (rb._nextKinematicY !== null) {
          rb.vy = (rb._nextKinematicY - t.y) / dt
          t.y = rb._nextKinematicY
        } else {
          rb.vy = 0
        }
        rb._nextKinematicX = null
        rb._nextKinematicY = null
      }
      if (rb._nextKinematicRotation !== null) {
        rb.angularVelocity = (rb._nextKinematicRotation - t.rotation) / dt
        t.rotation = rb._nextKinematicRotation
        rb._nextKinematicRotation = null
      }
    }

    // ── Platform carry ────────────────────────────────────────────────────

    const staticDelta = this._staticDelta
    staticDelta.clear()
    for (const sid of nonDynamic) {
      const st = world.getComponent<TransformComponent>(sid, T.transform)!
      const prev = this.staticPrevPos.get(sid)
      if (prev) staticDelta.set(sid, { dx: st.x - prev.x, dy: st.y - prev.y })
      this.staticPrevPos.set(sid, { x: st.x, y: st.y })
    }
    for (const sid of this.staticPrevPos.keys()) {
      if (!world.hasEntity(sid)) this.staticPrevPos.delete(sid)
    }

    // ── Compute mass properties ───────────────────────────────────────────

    for (const id of allBox) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      const col = world.getComponent<BoxColliderComponent>(id, T.box)!
      this.computeMassProperties(rb, col)
    }
    for (const id of allCircle) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)
      if (!rb) continue
      const col = world.getComponent<CircleColliderComponent>(id, T.circle)!
      this.computeMassProperties(rb, undefined, col)
    }
    for (const id of allCapsule) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      const col = world.getComponent<CapsuleColliderComponent>(id, T.capsule)!
      this.computeMassProperties(rb, undefined, undefined, col)
    }
    for (const id of allPolygon) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      const col = world.getComponent<ConvexPolygonColliderComponent>(id, T.polygon)!
      this.computeMassProperties(rb, undefined, undefined, undefined, col)
    }
    for (const id of allTriangle) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      const col = world.getComponent<TriangleColliderComponent>(id, T.triangle)!
      this.computeMassProperties(rb, undefined, undefined, undefined, undefined, col)
    }

    // ── Wake sleeping bodies on moving platforms ──────────────────────────

    for (const id of dynamicBox) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      if (!rb.sleeping) continue
      const transform = world.getComponent<TransformComponent>(id, T.transform)!
      const col = world.getComponent<BoxColliderComponent>(id, T.box)!
      const dynAABB = getAABB(transform, col)
      const probeAABB: AABB = { cx: dynAABB.cx, cy: dynAABB.cy + 2, hw: dynAABB.hw, hh: dynAABB.hh }
      for (const sid of nonDynamic) {
        const delta = staticDelta.get(sid)
        if (!delta || (delta.dx === 0 && delta.dy === 0)) continue
        const st = world.getComponent<TransformComponent>(sid, T.transform)!
        const sc = world.getComponent<BoxColliderComponent>(sid, T.box)!
        const ov = getOverlap(probeAABB, getAABB(st, sc))
        if (ov && Math.abs(ov.y) <= Math.abs(ov.x) && ov.y < 0) {
          rb.sleeping = false
          rb.sleepTimer = 0
          break
        }
      }
    }

    // ── Phase 1: Force accumulation + velocity integration ────────────────

    // All dynamics: box, circle, capsule, polygon, triangle
    const allDynamics = this._allDynamicsScratch
    allDynamics.length = 0
    for (const id of dynamicBox) allDynamics.push(id)
    for (const id of dynamicCircle) allDynamics.push(id)
    for (const id of capsuleDynamics) allDynamics.push(id)
    for (const id of dynamicPolygon) allDynamics.push(id)
    for (const id of dynamicTriangle) allDynamics.push(id)

    this._anySleeping = false
    for (const id of allDynamics) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!

      // Sleep check
      if (!rb.isStatic && !rb.isKinematic) {
        const speed = Math.abs(rb.vx) + Math.abs(rb.vy) + Math.abs(rb.angularVelocity) * 10
        if (speed < rb.sleepThreshold) {
          rb.sleepTimer += dt
          if (rb.sleepTimer >= rb.sleepDelay) rb.sleeping = true
        } else {
          rb.sleepTimer = 0
          rb.sleeping = false
        }
      }
      if (rb.sleeping) {
        this._anySleeping = true
        continue
      }

      rb.onGround = false
      rb.isNearGround = false

      // Apply gravity
      if (!rb.lockY) rb.forceY += this.gravity * rb.gravityScale * rb.mass

      // Integrate forces → velocity: v += (F / m) * dt
      if (rb.invMass > 0) {
        rb.vx += rb.forceX * rb.invMass * dt
        rb.vy += rb.forceY * rb.invMass * dt
      }
      if (rb.invInertia > 0) {
        rb.angularVelocity += rb.torque * rb.invInertia * dt
      }

      // Clear force accumulators
      rb.forceX = 0
      rb.forceY = 0
      rb.torque = 0

      // Axis locks
      if (rb.lockX) rb.vx = 0
      if (rb.lockY) rb.vy = 0
      if (rb.lockRotation) rb.angularVelocity = 0

      // Linear damping
      if (rb.linearDamping > 0) {
        rb.vx *= 1 - rb.linearDamping
        rb.vy *= 1 - rb.linearDamping
      }
      // Angular damping
      if (rb.angularDamping > 0) {
        rb.angularVelocity *= 1 - rb.angularDamping
      }

      // Velocity clamping
      if (rb.maxLinearVelocity > 0) {
        const speed = Math.sqrt(rb.vx * rb.vx + rb.vy * rb.vy)
        if (speed > rb.maxLinearVelocity) {
          const scale = rb.maxLinearVelocity / speed
          rb.vx *= scale
          rb.vy *= scale
        }
      }
      if (rb.maxAngularVelocity > 0) {
        if (Math.abs(rb.angularVelocity) > rb.maxAngularVelocity) {
          rb.angularVelocity = Math.sign(rb.angularVelocity) * rb.maxAngularVelocity
        }
      }

      // Drop-through counter
      if (rb.dropThrough > 0) rb.dropThrough--
    }

    // Save pre-integration positions for CCD and one-way platform checks
    const preX = this._preStepX
    const preY = this._preStepY
    preX.length = preY.length = dynamicBox.length
    for (let i = 0; i < dynamicBox.length; i++) {
      const t = world.getComponent<TransformComponent>(dynamicBox[i], T.transform)!
      preX[i] = t.x
      preY[i] = t.y
    }

    // ── Phase 2: Build spatial grid ───────────────────────────────────────

    const spatialGrid = this._spatialGrid
    spatialGrid.clear()

    // Insert static/kinematic box entities
    for (const sid of nonDynamic) {
      const st = world.getComponent<TransformComponent>(sid, T.transform)!
      const sc = world.getComponent<BoxColliderComponent>(sid, T.box)!
      if (!sc.enabled) continue
      const aabb = getAABB(st, sc)
      for (const cell of this.getCells(aabb.cx, aabb.cy, aabb.hw, aabb.hh)) {
        let bucket = spatialGrid.get(cell)
        if (!bucket) {
          bucket = []
          spatialGrid.set(cell, bucket)
        }
        bucket.push(sid)
      }
    }

    // ── Phase 2.5: Build joint contact exclusion set ─────────────────────
    // Joints with contactsEnabled=false prevent contact generation between
    // the two connected bodies.
    const jointExcludedPairs = this._jointExcludedPairs
    jointExcludedPairs.clear()
    for (const jid of world.query('Joint')) {
      const j = world.getComponent<JointComponent>(jid, 'Joint')!
      if (!j.enabled || j.broken) continue
      if (!j.contactsEnabled) {
        const ka = pairKey(j.entityA, j.entityB)
        jointExcludedPairs.add(ka)
      }
    }

    // ── Phase 3: Narrow phase — generate contact manifolds ────────────────

    const manifolds: ContactManifold[] = []
    const currentCollisionPairs = this._currentCollisionPairs
    currentCollisionPairs.clear()

    type CollisionMaterial = Pick<
      BoxColliderComponent,
      'friction' | 'frictionCombineRule' | 'restitution' | 'restitutionCombineRule'
    >
    const addGeneratedManifold = (
      entityA: EntityId,
      entityB: EntityId,
      result: { normalX: number; normalY: number; points: ContactManifold['points'] },
      colliderA: CollisionMaterial,
      colliderB: CollisionMaterial,
    ): void => {
      const key = pairKey(entityA, entityB)
      const manifold: ContactManifold = {
        entityA,
        entityB,
        normalX: result.normalX,
        normalY: result.normalY,
        points: result.points,
        friction: combineCoefficients(
          colliderA.friction,
          colliderA.frictionCombineRule,
          colliderB.friction,
          colliderB.frictionCombineRule,
        ),
        restitution: combineCoefficients(
          colliderA.restitution,
          colliderA.restitutionCombineRule,
          colliderB.restitution,
          colliderB.restitutionCombineRule,
        ),
      }
      const cached = this.manifoldCache.get(key)
      if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
      manifolds.push(manifold)
      currentCollisionPairs.set(key, [entityA, entityB])
    }

    // Dynamic box vs static/kinematic box
    for (const id of dynamicBox) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      if (rb.sleeping) continue
      const transform = world.getComponent<TransformComponent>(id, T.transform)!
      const col = world.getComponent<BoxColliderComponent>(id, T.box)!
      if (!col.enabled || col.isTrigger) continue

      const dynAABB = getAABB(transform, col)
      const candidateCells = this.getCells(dynAABB.cx, dynAABB.cy, dynAABB.hw, dynAABB.hh)
      const checked = this._checkedScratch
      checked.clear()

      for (const cell of candidateCells) {
        const bucket = spatialGrid.get(cell)
        if (!bucket) continue
        for (const sid of bucket) {
          if (checked.has(sid)) continue
          checked.add(sid)
          const st = world.getComponent<TransformComponent>(sid, T.transform)!
          const sc = world.getComponent<BoxColliderComponent>(sid, T.box)!
          if (!sc.enabled || sc.isTrigger) continue
          if (!canInteract(col.layer, col.mask, sc.layer, sc.mask, col.group, sc.group)) continue

          // One-way platform check
          if (sc.oneWay) {
            if (rb.dropThrough > 0) continue
            const platformTop = st.y + sc.offsetY - sc.height / 2
            const entityCenterY = transform.y + col.offsetY
            // Skip if entity center is below platform surface — entity is underneath
            if (entityCenterY > platformTop) continue
            if (rb.vy < 0) continue // moving upward — skip
          }

          // Slope handling: generate tilted contact normal
          if (sc.slope !== 0) {
            const ov = getOverlap(getAABB(transform, col), getAABB(st, sc))
            if (!ov) continue
            const entityBottom = transform.y + col.offsetY + col.height / 2
            const entityCenterX = transform.x + col.offsetX
            const surfaceY = getSlopeSurfaceY(st, sc, entityCenterX)
            if (surfaceY === null || entityBottom <= surfaceY) continue

            const penetration = entityBottom - surfaceY
            const angleRad = sc.slope * (Math.PI / 180)
            // Slope normal: perpendicular to slope surface
            const slopeNx = -Math.sin(angleRad)
            const slopeNy = -Math.cos(angleRad)

            const contactX = entityCenterX

            const combinedFriction = combineCoefficients(
              col.friction,
              col.frictionCombineRule,
              sc.friction,
              sc.frictionCombineRule,
            )
            const combinedRestitution = combineCoefficients(
              col.restitution,
              col.restitutionCombineRule,
              sc.restitution,
              sc.restitutionCombineRule,
            )

            manifolds.push({
              entityA: id,
              entityB: sid,
              normalX: slopeNx,
              normalY: slopeNy,
              points: [
                {
                  worldAx: contactX,
                  worldAy: entityBottom,
                  worldBx: contactX,
                  worldBy: surfaceY,
                  rAx: contactX - transform.x,
                  rAy: entityBottom - transform.y,
                  rBx: contactX - st.x,
                  rBy: surfaceY - st.y,
                  penetration,
                  normalImpulse: 0,
                  tangentImpulse: 0,
                  featureId: 100, // slope feature
                },
              ],
              friction: combinedFriction,
              restitution: combinedRestitution,
            })

            const key = pairKey(id, sid)
            currentCollisionPairs.set(key, [id, sid])
            continue
          }

          // Standard box-box manifold
          const aabb = getAABB(transform, col)
          const sAABB = getAABB(st, sc)
          const result = generateBoxBoxManifold(
            aabb.cx,
            aabb.cy,
            aabb.hw,
            aabb.hh,
            sAABB.cx,
            sAABB.cy,
            sAABB.hw,
            sAABB.hh,
          )
          if (!result) continue

          const combinedFriction = combineCoefficients(
            col.friction,
            col.frictionCombineRule,
            sc.friction,
            sc.frictionCombineRule,
          )
          const combinedRestitution = combineCoefficients(
            col.restitution,
            col.restitutionCombineRule,
            sc.restitution,
            sc.restitutionCombineRule,
          )

          const key = pairKey(id, sid)
          const manifold: ContactManifold = {
            entityA: id,
            entityB: sid,
            normalX: result.normalX,
            normalY: result.normalY,
            points: result.points,
            friction: combinedFriction,
            restitution: combinedRestitution,
          }

          // Warm start from cache
          const cached = this.manifoldCache.get(key)
          if (cached && this.config.warmStarting) {
            warmStartManifold(manifold, cached, this.config.warmStartingFactor)
          }

          manifolds.push(manifold)
          currentCollisionPairs.set(key, [id, sid])
        }
      }
    }

    // Dynamic box vs dynamic box
    this.forEachSpatialCandidatePair(
      dynamicBox,
      (id) => {
        const c = world.getComponent<BoxColliderComponent>(id, T.box)!
        if (!c.enabled) return null
        return getAABB(world.getComponent<TransformComponent>(id, T.transform)!, c)
      },
      (ia, ib) => {
        const rba = world.getComponent<RigidBodyComponent>(ia, T.rigidBody)!
        const rbb = world.getComponent<RigidBodyComponent>(ib, T.rigidBody)!

        const ta = world.getComponent<TransformComponent>(ia, T.transform)!
        const tb = world.getComponent<TransformComponent>(ib, T.transform)!
        const ca = world.getComponent<BoxColliderComponent>(ia, T.box)!
        const cb = world.getComponent<BoxColliderComponent>(ib, T.box)!
        if (!ca.enabled || !cb.enabled) return
        if (ca.isTrigger || cb.isTrigger) return
        if (!canInteract(ca.layer, ca.mask, cb.layer, cb.mask, ca.group, cb.group)) return

        const aabbA = getAABB(ta, ca)
        const aabbB = getAABB(tb, cb)
        const result = generateBoxBoxManifold(
          aabbA.cx,
          aabbA.cy,
          aabbA.hw,
          aabbA.hh,
          aabbB.cx,
          aabbB.cy,
          aabbB.hw,
          aabbB.hh,
        )
        if (!result) return

        // Wake sleeping bodies on contact
        wakePair(rba, rbb)

        const combinedFriction = combineCoefficients(
          ca.friction,
          ca.frictionCombineRule,
          cb.friction,
          cb.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          ca.restitution,
          ca.restitutionCombineRule,
          cb.restitution,
          cb.restitutionCombineRule,
        )

        const key = pairKey(ia, ib)
        const manifold: ContactManifold = {
          entityA: ia,
          entityB: ib,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }

        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) {
          warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        }

        manifolds.push(manifold)
        currentCollisionPairs.set(key, [ia, ib])
      },
    )

    // Dynamic circle vs static box
    for (const cid of dynamicCircle) {
      const rb = world.getComponent<RigidBodyComponent>(cid, T.rigidBody)!
      if (rb.sleeping) continue
      const ct = world.getComponent<TransformComponent>(cid, T.transform)!
      const cc = world.getComponent<CircleColliderComponent>(cid, T.circle)!
      if (!cc.enabled || cc.isTrigger) continue

      const circleCx = ct.x + cc.offsetX
      const circleCy = ct.y + cc.offsetY
      const circleAABB: AABB = { cx: circleCx, cy: circleCy, hw: cc.radius, hh: cc.radius }
      const candidateCells = this.getCells(circleAABB.cx, circleAABB.cy, circleAABB.hw, circleAABB.hh)
      const checked = this._checkedScratch
      checked.clear()

      for (const cell of candidateCells) {
        const bucket = spatialGrid.get(cell)
        if (!bucket) continue
        for (const sid of bucket) {
          if (checked.has(sid)) continue
          checked.add(sid)
          const st = world.getComponent<TransformComponent>(sid, T.transform)!
          const sc = world.getComponent<BoxColliderComponent>(sid, T.box)!
          if (!sc.enabled || sc.isTrigger) continue
          if (!canInteract(cc.layer, cc.mask, sc.layer, sc.mask, cc.group, sc.group)) continue

          const sAABB = getAABB(st, sc)
          const result = generateCircleBoxManifold(
            circleCx,
            circleCy,
            cc.radius,
            sAABB.cx,
            sAABB.cy,
            sAABB.hw,
            sAABB.hh,
          )
          if (!result) continue

          const combinedFriction = combineCoefficients(
            cc.friction,
            cc.frictionCombineRule,
            sc.friction,
            sc.frictionCombineRule,
          )
          const combinedRestitution = combineCoefficients(
            cc.restitution,
            cc.restitutionCombineRule,
            sc.restitution,
            sc.restitutionCombineRule,
          )

          const key = pairKey(cid, sid)
          const manifold: ContactManifold = {
            entityA: cid,
            entityB: sid,
            normalX: result.normalX,
            normalY: result.normalY,
            points: result.points,
            friction: combinedFriction,
            restitution: combinedRestitution,
          }

          const cached = this.manifoldCache.get(key)
          if (cached && this.config.warmStarting) {
            warmStartManifold(manifold, cached, this.config.warmStartingFactor)
          }

          manifolds.push(manifold)
          currentCollisionPairs.set(key, [cid, sid])
        }
      }
    }

    // Dynamic circle vs dynamic circle
    this.forEachSpatialCandidatePair(
      dynamicCircle,
      (id) => {
        const c = world.getComponent<CircleColliderComponent>(id, T.circle)!
        if (!c.enabled) return null
        const t = world.getComponent<TransformComponent>(id, T.transform)!
        return { cx: t.x + c.offsetX, cy: t.y + c.offsetY, hw: c.radius, hh: c.radius }
      },
      (ia, ib) => {
        const rba = world.getComponent<RigidBodyComponent>(ia, T.rigidBody)!
        const rbb = world.getComponent<RigidBodyComponent>(ib, T.rigidBody)!

        const ta = world.getComponent<TransformComponent>(ia, T.transform)!
        const tb = world.getComponent<TransformComponent>(ib, T.transform)!
        const ca = world.getComponent<CircleColliderComponent>(ia, T.circle)!
        const cb = world.getComponent<CircleColliderComponent>(ib, T.circle)!
        if (!ca.enabled || !cb.enabled || ca.isTrigger || cb.isTrigger) return
        if (!canInteract(ca.layer, ca.mask, cb.layer, cb.mask, ca.group, cb.group)) return

        const result = generateCircleCircleManifold(
          ta.x + ca.offsetX,
          ta.y + ca.offsetY,
          ca.radius,
          tb.x + cb.offsetX,
          tb.y + cb.offsetY,
          cb.radius,
        )
        if (!result) return

        wakePair(rba, rbb)

        const combinedFriction = combineCoefficients(
          ca.friction,
          ca.frictionCombineRule,
          cb.friction,
          cb.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          ca.restitution,
          ca.restitutionCombineRule,
          cb.restitution,
          cb.restitutionCombineRule,
        )

        const key = pairKey(ia, ib)
        const manifold: ContactManifold = {
          entityA: ia,
          entityB: ib,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }

        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) {
          warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        }

        manifolds.push(manifold)
        currentCollisionPairs.set(key, [ia, ib])
      },
    )

    // Dynamic circle vs dynamic box
    this.forEachSpatialCandidateCrossPair(
      dynamicCircle,
      dynamicBox,
      (id) => {
        const crb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
        if (crb.sleeping) return null
        const cc = world.getComponent<CircleColliderComponent>(id, T.circle)!
        if (!cc.enabled || cc.isTrigger) return null
        const ct = world.getComponent<TransformComponent>(id, T.transform)!
        return { cx: ct.x + cc.offsetX, cy: ct.y + cc.offsetY, hw: cc.radius, hh: cc.radius }
      },
      (id) => {
        const bc = world.getComponent<BoxColliderComponent>(id, T.box)!
        if (!bc.enabled) return null
        return getAABB(world.getComponent<TransformComponent>(id, T.transform)!, bc)
      },
      (cid, bid) => {
        const crb = world.getComponent<RigidBodyComponent>(cid, T.rigidBody)!
        const brb = world.getComponent<RigidBodyComponent>(bid, T.rigidBody)!
        const ct = world.getComponent<TransformComponent>(cid, T.transform)!
        const cc = world.getComponent<CircleColliderComponent>(cid, T.circle)!
        const bt = world.getComponent<TransformComponent>(bid, T.transform)!
        const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
        if (bc.isTrigger) return
        if (!canInteract(cc.layer, cc.mask, bc.layer, bc.mask, cc.group, bc.group)) return

        const bAABB = getAABB(bt, bc)
        const result = generateCircleBoxManifold(
          ct.x + cc.offsetX,
          ct.y + cc.offsetY,
          cc.radius,
          bAABB.cx,
          bAABB.cy,
          bAABB.hw,
          bAABB.hh,
        )
        if (!result) return

        wakePair(crb, brb)

        const combinedFriction = combineCoefficients(
          cc.friction,
          cc.frictionCombineRule,
          bc.friction,
          bc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          cc.restitution,
          cc.restitutionCombineRule,
          bc.restitution,
          bc.restitutionCombineRule,
        )

        const key = pairKey(cid, bid)
        const manifold: ContactManifold = {
          entityA: cid,
          entityB: bid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }

        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) {
          warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        }

        manifolds.push(manifold)
        currentCollisionPairs.set(key, [cid, bid])
      },
    )

    // ── Dynamic bodies vs static/kinematic circle geometry ───────────────
    this.forEachSpatialCandidateCrossPair(
      staticCircle,
      dynamicCircle,
      (id) => {
        const sc = world.getComponent<CircleColliderComponent>(id, T.circle)!
        if (!sc.enabled || sc.isTrigger) return null
        const st = world.getComponent<TransformComponent>(id, T.transform)!
        return { cx: st.x + sc.offsetX, cy: st.y + sc.offsetY, hw: sc.radius, hh: sc.radius }
      },
      (id) => {
        const crb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
        if (crb.sleeping) return null
        const cc = world.getComponent<CircleColliderComponent>(id, T.circle)!
        if (!cc.enabled || cc.isTrigger) return null
        const ct = world.getComponent<TransformComponent>(id, T.transform)!
        return { cx: ct.x + cc.offsetX, cy: ct.y + cc.offsetY, hw: cc.radius, hh: cc.radius }
      },
      (sid, cid) => {
        const st = world.getComponent<TransformComponent>(sid, T.transform)!
        const sc = world.getComponent<CircleColliderComponent>(sid, T.circle)!
        const ct = world.getComponent<TransformComponent>(cid, T.transform)!
        const cc = world.getComponent<CircleColliderComponent>(cid, T.circle)!
        if (!canInteract(cc.layer, cc.mask, sc.layer, sc.mask, cc.group, sc.group)) return

        const sx = st.x + sc.offsetX
        const sy = st.y + sc.offsetY
        const result = generateCircleCircleManifold(ct.x + cc.offsetX, ct.y + cc.offsetY, cc.radius, sx, sy, sc.radius)
        if (result) addGeneratedManifold(cid, sid, result, cc, sc)
      },
    )

    this.forEachSpatialCandidateCrossPair(
      staticCircle,
      dynamicBox,
      (id) => {
        const sc = world.getComponent<CircleColliderComponent>(id, T.circle)!
        if (!sc.enabled || sc.isTrigger) return null
        const st = world.getComponent<TransformComponent>(id, T.transform)!
        return { cx: st.x + sc.offsetX, cy: st.y + sc.offsetY, hw: sc.radius, hh: sc.radius }
      },
      (id) => {
        const brb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
        if (brb.sleeping) return null
        const bc = world.getComponent<BoxColliderComponent>(id, T.box)!
        if (!bc.enabled || bc.isTrigger) return null
        return getAABB(world.getComponent<TransformComponent>(id, T.transform)!, bc)
      },
      (sid, bid) => {
        const st = world.getComponent<TransformComponent>(sid, T.transform)!
        const sc = world.getComponent<CircleColliderComponent>(sid, T.circle)!
        const bt = world.getComponent<TransformComponent>(bid, T.transform)!
        const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
        if (!canInteract(sc.layer, sc.mask, bc.layer, bc.mask, sc.group, bc.group)) return

        const sx = st.x + sc.offsetX
        const sy = st.y + sc.offsetY
        const bAABB = getAABB(bt, bc)
        const result = generateCircleBoxManifold(sx, sy, sc.radius, bAABB.cx, bAABB.cy, bAABB.hw, bAABB.hh)
        if (result) addGeneratedManifold(sid, bid, result, sc, bc)
      },
    )

    for (const sid of staticCircle) {
      const st = world.getComponent<TransformComponent>(sid, T.transform)!
      const sc = world.getComponent<CircleColliderComponent>(sid, T.circle)!
      if (!sc.enabled || sc.isTrigger) continue
      const sx = st.x + sc.offsetX
      const sy = st.y + sc.offsetY

      for (const pid of dynamicPolygon) {
        if (pid === sid) continue
        const prb = world.getComponent<RigidBodyComponent>(pid, T.rigidBody)!
        if (prb.sleeping) continue
        const pt = world.getComponent<TransformComponent>(pid, T.transform)!
        const pc = world.getComponent<ConvexPolygonColliderComponent>(pid, T.polygon)!
        if (!pc.enabled || pc.isTrigger) continue
        if (!canInteract(pc.layer, pc.mask, sc.layer, sc.mask, pc.group, sc.group)) continue

        const result = generatePolygonCircleManifold(pc.vertices, pt.x, pt.y, pc.offsetX, pc.offsetY, sx, sy, sc.radius)
        if (result) addGeneratedManifold(pid, sid, result, pc, sc)
      }

      for (const tid of dynamicTriangle) {
        if (tid === sid) continue
        const trb = world.getComponent<RigidBodyComponent>(tid, T.rigidBody)!
        if (trb.sleeping) continue
        const tt = world.getComponent<TransformComponent>(tid, T.transform)!
        const tc = world.getComponent<TriangleColliderComponent>(tid, T.triangle)!
        if (!tc.enabled || tc.isTrigger) continue
        if (!canInteract(tc.layer, tc.mask, sc.layer, sc.mask, tc.group, sc.group)) continue

        const result = generatePolygonCircleManifold(
          [tc.a, tc.b, tc.c],
          tt.x,
          tt.y,
          tc.offsetX,
          tc.offsetY,
          sx,
          sy,
          sc.radius,
        )
        if (result) addGeneratedManifold(tid, sid, result, tc, sc)
      }
    }

    const addStaticPolygonContacts = (
      sid: EntityId,
      sc: ConvexPolygonColliderComponent | TriangleColliderComponent,
      vertices: { x: number; y: number }[],
    ): void => {
      if (!sc.enabled || sc.isTrigger) return
      const st = world.getComponent<TransformComponent>(sid, T.transform)!

      for (const cid of dynamicCircle) {
        if (cid === sid) continue
        const crb = world.getComponent<RigidBodyComponent>(cid, T.rigidBody)!
        if (crb.sleeping) continue
        const ct = world.getComponent<TransformComponent>(cid, T.transform)!
        const cc = world.getComponent<CircleColliderComponent>(cid, T.circle)!
        if (!cc.enabled || cc.isTrigger) continue
        if (!canInteract(sc.layer, sc.mask, cc.layer, cc.mask, sc.group, cc.group)) continue

        const result = generatePolygonCircleManifold(
          vertices,
          st.x,
          st.y,
          sc.offsetX,
          sc.offsetY,
          ct.x + cc.offsetX,
          ct.y + cc.offsetY,
          cc.radius,
        )
        if (result) addGeneratedManifold(sid, cid, result, sc, cc)
      }

      for (const bid of dynamicBox) {
        if (bid === sid) continue
        const brb = world.getComponent<RigidBodyComponent>(bid, T.rigidBody)!
        if (brb.sleeping) continue
        const bt = world.getComponent<TransformComponent>(bid, T.transform)!
        const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
        if (!bc.enabled || bc.isTrigger) continue
        if (!canInteract(sc.layer, sc.mask, bc.layer, bc.mask, sc.group, bc.group)) continue

        const bAABB = getAABB(bt, bc)
        const result = generatePolygonBoxManifold(
          vertices,
          st.x,
          st.y,
          sc.offsetX,
          sc.offsetY,
          bAABB.cx,
          bAABB.cy,
          bAABB.hw,
          bAABB.hh,
        )
        if (result) addGeneratedManifold(sid, bid, result, sc, bc)
      }

      for (const pid of dynamicPolygon) {
        if (pid === sid) continue
        const prb = world.getComponent<RigidBodyComponent>(pid, T.rigidBody)!
        if (prb.sleeping) continue
        const pt = world.getComponent<TransformComponent>(pid, T.transform)!
        const pc = world.getComponent<ConvexPolygonColliderComponent>(pid, T.polygon)!
        if (!pc.enabled || pc.isTrigger) continue
        if (!canInteract(pc.layer, pc.mask, sc.layer, sc.mask, pc.group, sc.group)) continue

        const result = generatePolygonPolygonManifold(
          pc.vertices,
          pt.x,
          pt.y,
          pc.offsetX,
          pc.offsetY,
          vertices,
          st.x,
          st.y,
          sc.offsetX,
          sc.offsetY,
        )
        if (result) addGeneratedManifold(pid, sid, result, pc, sc)
      }

      for (const tid of dynamicTriangle) {
        if (tid === sid) continue
        const trb = world.getComponent<RigidBodyComponent>(tid, T.rigidBody)!
        if (trb.sleeping) continue
        const tt = world.getComponent<TransformComponent>(tid, T.transform)!
        const tc = world.getComponent<TriangleColliderComponent>(tid, T.triangle)!
        if (!tc.enabled || tc.isTrigger) continue
        if (!canInteract(tc.layer, tc.mask, sc.layer, sc.mask, tc.group, sc.group)) continue

        const result = generatePolygonPolygonManifold(
          [tc.a, tc.b, tc.c],
          tt.x,
          tt.y,
          tc.offsetX,
          tc.offsetY,
          vertices,
          st.x,
          st.y,
          sc.offsetX,
          sc.offsetY,
        )
        if (result) addGeneratedManifold(tid, sid, result, tc, sc)
      }
    }

    // ── Dynamic bodies vs static/kinematic polygon and triangle geometry ──
    for (const sid of staticPolygon) {
      const sc = world.getComponent<ConvexPolygonColliderComponent>(sid, T.polygon)!
      addStaticPolygonContacts(sid, sc, sc.vertices)
    }
    for (const sid of staticTriangle) {
      const sc = world.getComponent<TriangleColliderComponent>(sid, T.triangle)!
      addStaticPolygonContacts(sid, sc, [sc.a, sc.b, sc.c])
    }

    // ── Capsule vs static box (upgraded from AABB to proper manifold) ──────
    for (const cid of contactCapsules) {
      const rb = world.getComponent<RigidBodyComponent>(cid, T.rigidBody)!
      if (rb.sleeping) continue
      const ct = world.getComponent<TransformComponent>(cid, T.transform)!
      const cc = world.getComponent<CapsuleColliderComponent>(cid, T.capsule)!
      if (!cc.enabled || cc.isTrigger) continue

      const capCx = ct.x + cc.offsetX
      const capCy = ct.y + cc.offsetY
      const capHw = cc.width / 2
      const capHh = cc.height / 2
      const candidateCells = this.getCells(capCx, capCy, capHw, capHh)
      const checked = this._checkedScratch
      checked.clear()

      for (const cell of candidateCells) {
        const bucket = spatialGrid.get(cell)
        if (!bucket) continue
        for (const sid of bucket) {
          if (checked.has(sid)) continue
          checked.add(sid)
          const st = world.getComponent<TransformComponent>(sid, T.transform)!
          const sc = world.getComponent<BoxColliderComponent>(sid, T.box)!
          if (!sc.enabled || sc.isTrigger) continue
          if (!canInteract(cc.layer, cc.mask, sc.layer, sc.mask, cc.group, sc.group)) continue

          const sAABB = getAABB(st, sc)
          const result = generateCapsuleBoxManifold(capCx, capCy, capHw, capHh, sAABB.cx, sAABB.cy, sAABB.hw, sAABB.hh)
          if (!result) continue

          const combinedFriction = combineCoefficients(
            cc.friction,
            cc.frictionCombineRule,
            sc.friction,
            sc.frictionCombineRule,
          )
          const combinedRestitution = combineCoefficients(
            cc.restitution,
            cc.restitutionCombineRule,
            sc.restitution,
            sc.restitutionCombineRule,
          )

          const key = pairKey(cid, sid)
          const manifold: ContactManifold = {
            entityA: cid,
            entityB: sid,
            normalX: result.normalX,
            normalY: result.normalY,
            points: result.points,
            friction: combinedFriction,
            restitution: combinedRestitution,
          }
          const cached = this.manifoldCache.get(key)
          if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
          manifolds.push(manifold)
          currentCollisionPairs.set(key, [cid, sid])
        }
      }
    }

    // ── Capsule vs dynamic box ───────────────────────────────────────────
    this.forEachSpatialCandidateCrossPair(
      contactCapsules,
      dynamicBox,
      (id) => {
        const crb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
        if (crb.sleeping) return null
        const cc = world.getComponent<CapsuleColliderComponent>(id, T.capsule)!
        if (!cc.enabled || cc.isTrigger) return null
        const ct = world.getComponent<TransformComponent>(id, T.transform)!
        return { cx: ct.x + cc.offsetX, cy: ct.y + cc.offsetY, hw: cc.width / 2, hh: cc.height / 2 }
      },
      (id) => {
        const bc = world.getComponent<BoxColliderComponent>(id, T.box)!
        if (!bc.enabled) return null
        return getAABB(world.getComponent<TransformComponent>(id, T.transform)!, bc)
      },
      (cid, bid) => {
        const crb = world.getComponent<RigidBodyComponent>(cid, T.rigidBody)!
        const brb = world.getComponent<RigidBodyComponent>(bid, T.rigidBody)!
        const ct = world.getComponent<TransformComponent>(cid, T.transform)!
        const cc = world.getComponent<CapsuleColliderComponent>(cid, T.capsule)!
        const bt = world.getComponent<TransformComponent>(bid, T.transform)!
        const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
        if (bc.isTrigger) return
        if (!canInteract(cc.layer, cc.mask, bc.layer, bc.mask, cc.group, bc.group)) return

        const capCx = ct.x + cc.offsetX
        const capCy = ct.y + cc.offsetY
        const capHw = cc.width / 2
        const capHh = cc.height / 2
        const bAABB = getAABB(bt, bc)
        const result = generateCapsuleBoxManifold(capCx, capCy, capHw, capHh, bAABB.cx, bAABB.cy, bAABB.hw, bAABB.hh)
        if (!result) return

        wakePair(crb, brb)

        const combinedFriction = combineCoefficients(
          cc.friction,
          cc.frictionCombineRule,
          bc.friction,
          bc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          cc.restitution,
          cc.restitutionCombineRule,
          bc.restitution,
          bc.restitutionCombineRule,
        )

        const key = pairKey(cid, bid)
        const manifold: ContactManifold = {
          entityA: cid,
          entityB: bid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [cid, bid])
      },
    )

    // ── Capsule vs capsule ───────────────────────────────────────────────
    this.forEachSpatialCandidatePair(
      contactCapsules,
      (id) => {
        const c = world.getComponent<CapsuleColliderComponent>(id, T.capsule)!
        if (!c.enabled) return null
        const t = world.getComponent<TransformComponent>(id, T.transform)!
        return { cx: t.x + c.offsetX, cy: t.y + c.offsetY, hw: c.width / 2, hh: c.height / 2 }
      },
      (ia, ib) => {
        const rba = world.getComponent<RigidBodyComponent>(ia, T.rigidBody)!
        const rbb = world.getComponent<RigidBodyComponent>(ib, T.rigidBody)!
        const ta = world.getComponent<TransformComponent>(ia, T.transform)!
        const tb = world.getComponent<TransformComponent>(ib, T.transform)!
        const ca = world.getComponent<CapsuleColliderComponent>(ia, T.capsule)!
        const cb = world.getComponent<CapsuleColliderComponent>(ib, T.capsule)!
        if (!ca.enabled || !cb.enabled || ca.isTrigger || cb.isTrigger) return
        if (!canInteract(ca.layer, ca.mask, cb.layer, cb.mask, ca.group, cb.group)) return

        const result = generateCapsuleCapsuleManifold(
          ta.x + ca.offsetX,
          ta.y + ca.offsetY,
          ca.width / 2,
          ca.height / 2,
          tb.x + cb.offsetX,
          tb.y + cb.offsetY,
          cb.width / 2,
          cb.height / 2,
        )
        if (!result) return

        wakePair(rba, rbb)

        const combinedFriction = combineCoefficients(
          ca.friction,
          ca.frictionCombineRule,
          cb.friction,
          cb.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          ca.restitution,
          ca.restitutionCombineRule,
          cb.restitution,
          cb.restitutionCombineRule,
        )

        const key = pairKey(ia, ib)
        const manifold: ContactManifold = {
          entityA: ia,
          entityB: ib,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [ia, ib])
      },
    )

    // ── Capsule vs dynamic circle ────────────────────────────────────────
    this.forEachSpatialCandidateCrossPair(
      contactCapsules,
      dynamicCircle,
      (id) => {
        const crb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
        if (crb.sleeping) return null
        const cc = world.getComponent<CapsuleColliderComponent>(id, T.capsule)!
        if (!cc.enabled || cc.isTrigger) return null
        const ct = world.getComponent<TransformComponent>(id, T.transform)!
        return { cx: ct.x + cc.offsetX, cy: ct.y + cc.offsetY, hw: cc.width / 2, hh: cc.height / 2 }
      },
      (id) => {
        const oc = world.getComponent<CircleColliderComponent>(id, T.circle)!
        if (!oc.enabled) return null
        const ot = world.getComponent<TransformComponent>(id, T.transform)!
        return { cx: ot.x + oc.offsetX, cy: ot.y + oc.offsetY, hw: oc.radius, hh: oc.radius }
      },
      (cid, oid) => {
        const crb = world.getComponent<RigidBodyComponent>(cid, T.rigidBody)!
        const orb = world.getComponent<RigidBodyComponent>(oid, T.rigidBody)!
        const ct = world.getComponent<TransformComponent>(cid, T.transform)!
        const cc = world.getComponent<CapsuleColliderComponent>(cid, T.capsule)!
        const ot = world.getComponent<TransformComponent>(oid, T.transform)!
        const oc = world.getComponent<CircleColliderComponent>(oid, T.circle)!
        if (oc.isTrigger) return
        if (!canInteract(cc.layer, cc.mask, oc.layer, oc.mask, cc.group, oc.group)) return

        const capCx = ct.x + cc.offsetX
        const capCy = ct.y + cc.offsetY
        const capHw = cc.width / 2
        const capHh = cc.height / 2
        const result = generateCapsuleCircleManifold(
          capCx,
          capCy,
          capHw,
          capHh,
          ot.x + oc.offsetX,
          ot.y + oc.offsetY,
          oc.radius,
        )
        if (!result) return

        wakePair(crb, orb)

        const combinedFriction = combineCoefficients(
          cc.friction,
          cc.frictionCombineRule,
          oc.friction,
          oc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          cc.restitution,
          cc.restitutionCombineRule,
          oc.restitution,
          oc.restitutionCombineRule,
        )

        const key = pairKey(cid, oid)
        const manifold: ContactManifold = {
          entityA: cid,
          entityB: oid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [cid, oid])
      },
    )

    // ── Polygon vs static box ────────────────────────────────────────────
    for (const pid of dynamicPolygon) {
      const rb = world.getComponent<RigidBodyComponent>(pid, T.rigidBody)!
      if (rb.sleeping) continue
      const pt = world.getComponent<TransformComponent>(pid, T.transform)!
      const pc = world.getComponent<ConvexPolygonColliderComponent>(pid, T.polygon)!
      if (!pc.enabled || pc.isTrigger) continue

      // Compute polygon AABB for spatial grid query
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity
      for (const v of pc.vertices) {
        const wx = v.x + pt.x + pc.offsetX
        const wy = v.y + pt.y + pc.offsetY
        if (wx < minX) minX = wx
        if (wx > maxX) maxX = wx
        if (wy < minY) minY = wy
        if (wy > maxY) maxY = wy
      }
      const polyHw = (maxX - minX) / 2
      const polyHh = (maxY - minY) / 2
      const polyCx = (minX + maxX) / 2
      const polyCy = (minY + maxY) / 2

      const candidateCells = this.getCells(polyCx, polyCy, polyHw, polyHh)
      const checked = this._checkedScratch
      checked.clear()

      for (const cell of candidateCells) {
        const bucket = spatialGrid.get(cell)
        if (!bucket) continue
        for (const sid of bucket) {
          if (checked.has(sid)) continue
          checked.add(sid)
          const st = world.getComponent<TransformComponent>(sid, T.transform)!
          const sc = world.getComponent<BoxColliderComponent>(sid, T.box)!
          if (!sc.enabled || sc.isTrigger) continue
          if (!canInteract(pc.layer, pc.mask, sc.layer, sc.mask, pc.group, sc.group)) continue

          const sAABB = getAABB(st, sc)
          const result = generatePolygonBoxManifold(
            pc.vertices,
            pt.x,
            pt.y,
            pc.offsetX,
            pc.offsetY,
            sAABB.cx,
            sAABB.cy,
            sAABB.hw,
            sAABB.hh,
          )
          if (!result) continue

          const combinedFriction = combineCoefficients(
            pc.friction,
            pc.frictionCombineRule,
            sc.friction,
            sc.frictionCombineRule,
          )
          const combinedRestitution = combineCoefficients(
            pc.restitution,
            pc.restitutionCombineRule,
            sc.restitution,
            sc.restitutionCombineRule,
          )

          const key = pairKey(pid, sid)
          const manifold: ContactManifold = {
            entityA: pid,
            entityB: sid,
            normalX: result.normalX,
            normalY: result.normalY,
            points: result.points,
            friction: combinedFriction,
            restitution: combinedRestitution,
          }
          const cached = this.manifoldCache.get(key)
          if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
          manifolds.push(manifold)
          currentCollisionPairs.set(key, [pid, sid])
        }
      }
    }

    // ── Polygon vs dynamic box ───────────────────────────────────────────
    this.forEachSpatialCandidateCrossPair(
      dynamicPolygon,
      dynamicBox,
      (id) => {
        const prb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
        if (prb.sleeping) return null
        const pc = world.getComponent<ConvexPolygonColliderComponent>(id, T.polygon)!
        if (!pc.enabled || pc.isTrigger) return null
        const pt = world.getComponent<TransformComponent>(id, T.transform)!
        return polygonWorldAABB(pc.vertices, pt.x, pt.y, pc.offsetX, pc.offsetY)
      },
      (id) => {
        const bc = world.getComponent<BoxColliderComponent>(id, T.box)!
        if (!bc.enabled) return null
        return getAABB(world.getComponent<TransformComponent>(id, T.transform)!, bc)
      },
      (pid, bid) => {
        const prb = world.getComponent<RigidBodyComponent>(pid, T.rigidBody)!
        const brb = world.getComponent<RigidBodyComponent>(bid, T.rigidBody)!
        const pt = world.getComponent<TransformComponent>(pid, T.transform)!
        const pc = world.getComponent<ConvexPolygonColliderComponent>(pid, T.polygon)!
        const bt = world.getComponent<TransformComponent>(bid, T.transform)!
        const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
        if (bc.isTrigger) return
        if (!canInteract(pc.layer, pc.mask, bc.layer, bc.mask, pc.group, bc.group)) return

        const bAABB = getAABB(bt, bc)
        const result = generatePolygonBoxManifold(
          pc.vertices,
          pt.x,
          pt.y,
          pc.offsetX,
          pc.offsetY,
          bAABB.cx,
          bAABB.cy,
          bAABB.hw,
          bAABB.hh,
        )
        if (!result) return

        wakePair(prb, brb)

        const combinedFriction = combineCoefficients(
          pc.friction,
          pc.frictionCombineRule,
          bc.friction,
          bc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          pc.restitution,
          pc.restitutionCombineRule,
          bc.restitution,
          bc.restitutionCombineRule,
        )

        const key = pairKey(pid, bid)
        const manifold: ContactManifold = {
          entityA: pid,
          entityB: bid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [pid, bid])
      },
    )

    // ── Polygon vs polygon ───────────────────────────────────────────────
    this.forEachSpatialCandidatePair(
      dynamicPolygon,
      (id) => {
        const c = world.getComponent<ConvexPolygonColliderComponent>(id, T.polygon)!
        if (!c.enabled) return null
        const t = world.getComponent<TransformComponent>(id, T.transform)!
        return polygonWorldAABB(c.vertices, t.x, t.y, c.offsetX, c.offsetY)
      },
      (ia, ib) => {
        const rba = world.getComponent<RigidBodyComponent>(ia, T.rigidBody)!
        const rbb = world.getComponent<RigidBodyComponent>(ib, T.rigidBody)!
        const ta = world.getComponent<TransformComponent>(ia, T.transform)!
        const tb = world.getComponent<TransformComponent>(ib, T.transform)!
        const ca = world.getComponent<ConvexPolygonColliderComponent>(ia, T.polygon)!
        const cb = world.getComponent<ConvexPolygonColliderComponent>(ib, T.polygon)!
        if (!ca.enabled || !cb.enabled || ca.isTrigger || cb.isTrigger) return
        if (!canInteract(ca.layer, ca.mask, cb.layer, cb.mask, ca.group, cb.group)) return

        const result = generatePolygonPolygonManifold(
          ca.vertices,
          ta.x,
          ta.y,
          ca.offsetX,
          ca.offsetY,
          cb.vertices,
          tb.x,
          tb.y,
          cb.offsetX,
          cb.offsetY,
        )
        if (!result) return

        wakePair(rba, rbb)

        const combinedFriction = combineCoefficients(
          ca.friction,
          ca.frictionCombineRule,
          cb.friction,
          cb.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          ca.restitution,
          ca.restitutionCombineRule,
          cb.restitution,
          cb.restitutionCombineRule,
        )

        const key = pairKey(ia, ib)
        const manifold: ContactManifold = {
          entityA: ia,
          entityB: ib,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [ia, ib])
      },
    )

    // ── Polygon vs dynamic circle ────────────────────────────────────────
    this.forEachSpatialCandidateCrossPair(
      dynamicPolygon,
      dynamicCircle,
      (id) => {
        const prb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
        if (prb.sleeping) return null
        const pc = world.getComponent<ConvexPolygonColliderComponent>(id, T.polygon)!
        if (!pc.enabled || pc.isTrigger) return null
        const pt = world.getComponent<TransformComponent>(id, T.transform)!
        return polygonWorldAABB(pc.vertices, pt.x, pt.y, pc.offsetX, pc.offsetY)
      },
      (id) => {
        const oc = world.getComponent<CircleColliderComponent>(id, T.circle)!
        if (!oc.enabled) return null
        const ot = world.getComponent<TransformComponent>(id, T.transform)!
        return { cx: ot.x + oc.offsetX, cy: ot.y + oc.offsetY, hw: oc.radius, hh: oc.radius }
      },
      (pid, oid) => {
        const prb = world.getComponent<RigidBodyComponent>(pid, T.rigidBody)!
        const orb = world.getComponent<RigidBodyComponent>(oid, T.rigidBody)!
        const pt = world.getComponent<TransformComponent>(pid, T.transform)!
        const pc = world.getComponent<ConvexPolygonColliderComponent>(pid, T.polygon)!
        const ot = world.getComponent<TransformComponent>(oid, T.transform)!
        const oc = world.getComponent<CircleColliderComponent>(oid, T.circle)!
        if (oc.isTrigger) return
        if (!canInteract(pc.layer, pc.mask, oc.layer, oc.mask, pc.group, oc.group)) return

        const result = generatePolygonCircleManifold(
          pc.vertices,
          pt.x,
          pt.y,
          pc.offsetX,
          pc.offsetY,
          ot.x + oc.offsetX,
          ot.y + oc.offsetY,
          oc.radius,
        )
        if (!result) return

        wakePair(prb, orb)

        const combinedFriction = combineCoefficients(
          pc.friction,
          pc.frictionCombineRule,
          oc.friction,
          oc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          pc.restitution,
          pc.restitutionCombineRule,
          oc.restitution,
          oc.restitutionCombineRule,
        )

        const key = pairKey(pid, oid)
        const manifold: ContactManifold = {
          entityA: pid,
          entityB: oid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [pid, oid])
      },
    )

    // ── Triangle vs static box (treat as 3-vertex polygon) ───────────────
    for (const tid of dynamicTriangle) {
      const rb = world.getComponent<RigidBodyComponent>(tid, T.rigidBody)!
      if (rb.sleeping) continue
      const tt = world.getComponent<TransformComponent>(tid, T.transform)!
      const tc = world.getComponent<TriangleColliderComponent>(tid, T.triangle)!
      if (!tc.enabled || tc.isTrigger) continue

      const triVerts = [tc.a, tc.b, tc.c]

      // Compute triangle AABB for spatial grid query
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity
      for (const v of triVerts) {
        const wx = v.x + tt.x + tc.offsetX
        const wy = v.y + tt.y + tc.offsetY
        if (wx < minX) minX = wx
        if (wx > maxX) maxX = wx
        if (wy < minY) minY = wy
        if (wy > maxY) maxY = wy
      }
      const triHw = (maxX - minX) / 2
      const triHh = (maxY - minY) / 2
      const triCx = (minX + maxX) / 2
      const triCy = (minY + maxY) / 2

      const candidateCells = this.getCells(triCx, triCy, triHw, triHh)
      const checked = this._checkedScratch
      checked.clear()

      for (const cell of candidateCells) {
        const bucket = spatialGrid.get(cell)
        if (!bucket) continue
        for (const sid of bucket) {
          if (checked.has(sid)) continue
          checked.add(sid)
          const st = world.getComponent<TransformComponent>(sid, T.transform)!
          const sc = world.getComponent<BoxColliderComponent>(sid, T.box)!
          if (!sc.enabled || sc.isTrigger) continue
          if (!canInteract(tc.layer, tc.mask, sc.layer, sc.mask, tc.group, sc.group)) continue

          const sAABB = getAABB(st, sc)
          const result = generatePolygonBoxManifold(
            triVerts,
            tt.x,
            tt.y,
            tc.offsetX,
            tc.offsetY,
            sAABB.cx,
            sAABB.cy,
            sAABB.hw,
            sAABB.hh,
          )
          if (!result) continue

          const combinedFriction = combineCoefficients(
            tc.friction,
            tc.frictionCombineRule,
            sc.friction,
            sc.frictionCombineRule,
          )
          const combinedRestitution = combineCoefficients(
            tc.restitution,
            tc.restitutionCombineRule,
            sc.restitution,
            sc.restitutionCombineRule,
          )

          const key = pairKey(tid, sid)
          const manifold: ContactManifold = {
            entityA: tid,
            entityB: sid,
            normalX: result.normalX,
            normalY: result.normalY,
            points: result.points,
            friction: combinedFriction,
            restitution: combinedRestitution,
          }
          const cached = this.manifoldCache.get(key)
          if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
          manifolds.push(manifold)
          currentCollisionPairs.set(key, [tid, sid])
        }
      }
    }

    // ── Triangle vs dynamic circle (treat as 3-vertex polygon) ───────────
    for (const tid of dynamicTriangle) {
      const trb = world.getComponent<RigidBodyComponent>(tid, T.rigidBody)!
      if (trb.sleeping) continue
      const tt = world.getComponent<TransformComponent>(tid, T.transform)!
      const tc = world.getComponent<TriangleColliderComponent>(tid, T.triangle)!
      if (!tc.enabled || tc.isTrigger) continue

      const triVerts = [tc.a, tc.b, tc.c]

      for (const oid of dynamicCircle) {
        const orb = world.getComponent<RigidBodyComponent>(oid, T.rigidBody)!
        const ot = world.getComponent<TransformComponent>(oid, T.transform)!
        const oc = world.getComponent<CircleColliderComponent>(oid, T.circle)!
        if (!oc.enabled || oc.isTrigger) continue
        if (!canInteract(tc.layer, tc.mask, oc.layer, oc.mask, tc.group, oc.group)) continue

        const result = generatePolygonCircleManifold(
          triVerts,
          tt.x,
          tt.y,
          tc.offsetX,
          tc.offsetY,
          ot.x + oc.offsetX,
          ot.y + oc.offsetY,
          oc.radius,
        )
        if (!result) continue

        wakePair(trb, orb)

        const combinedFriction = combineCoefficients(
          tc.friction,
          tc.frictionCombineRule,
          oc.friction,
          oc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          tc.restitution,
          tc.restitutionCombineRule,
          oc.restitution,
          oc.restitutionCombineRule,
        )

        const key = pairKey(tid, oid)
        const manifold: ContactManifold = {
          entityA: tid,
          entityB: oid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [tid, oid])
      }
    }

    // ── Segment vs dynamic box & circle (segments are always static) ─────
    for (const sid of allSegment) {
      const st = world.getComponent<TransformComponent>(sid, T.transform)!
      const sc = world.getComponent<SegmentColliderComponent>(sid, 'SegmentCollider')!
      if (!sc.enabled || sc.isTrigger) continue

      const segAx = st.x + sc.offsetX + sc.start.x
      const segAy = st.y + sc.offsetY + sc.start.y
      const segBx = st.x + sc.offsetX + sc.end.x
      const segBy = st.y + sc.offsetY + sc.end.y

      for (const bid of dynamicBox) {
        const brb = world.getComponent<RigidBodyComponent>(bid, T.rigidBody)!
        if (brb.sleeping) continue
        const bt = world.getComponent<TransformComponent>(bid, T.transform)!
        const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
        if (!bc.enabled || bc.isTrigger) continue
        if (!canInteract(sc.layer, sc.mask, bc.layer, bc.mask, sc.group, bc.group)) continue

        const bAABB = getAABB(bt, bc)
        const result = generateSegmentBoxManifold(segAx, segAy, segBx, segBy, bAABB.cx, bAABB.cy, bAABB.hw, bAABB.hh)
        if (!result) continue

        const combinedFriction = combineCoefficients(
          sc.friction,
          sc.frictionCombineRule,
          bc.friction,
          bc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          sc.restitution,
          sc.restitutionCombineRule,
          bc.restitution,
          bc.restitutionCombineRule,
        )

        const key = pairKey(sid, bid)
        const manifold: ContactManifold = {
          entityA: sid,
          entityB: bid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [sid, bid])
      }

      for (const cid of dynamicCircle) {
        const crb = world.getComponent<RigidBodyComponent>(cid, T.rigidBody)!
        if (crb.sleeping) continue
        const ct = world.getComponent<TransformComponent>(cid, T.transform)!
        const cc = world.getComponent<CircleColliderComponent>(cid, T.circle)!
        if (!cc.enabled || cc.isTrigger) continue
        if (!canInteract(sc.layer, sc.mask, cc.layer, cc.mask, sc.group, cc.group)) continue

        const result = generateSegmentCircleManifold(
          segAx,
          segAy,
          segBx,
          segBy,
          ct.x + cc.offsetX,
          ct.y + cc.offsetY,
          cc.radius,
        )
        if (!result) continue

        const combinedFriction = combineCoefficients(
          sc.friction,
          sc.frictionCombineRule,
          cc.friction,
          cc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          sc.restitution,
          sc.restitutionCombineRule,
          cc.restitution,
          cc.restitutionCombineRule,
        )

        const key = pairKey(sid, cid)
        const manifold: ContactManifold = {
          entityA: sid,
          entityB: cid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [sid, cid])
      }
    }

    // ── HeightField vs dynamic box & circle (heightfields are static) ────
    for (const hid of allHeightField) {
      const ht = world.getComponent<TransformComponent>(hid, T.transform)!
      const hc = world.getComponent<HeightFieldColliderComponent>(hid, 'HeightFieldCollider')!
      if (!hc.enabled) continue

      for (const bid of dynamicBox) {
        const brb = world.getComponent<RigidBodyComponent>(bid, T.rigidBody)!
        if (brb.sleeping) continue
        const bt = world.getComponent<TransformComponent>(bid, T.transform)!
        const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
        if (!bc.enabled || bc.isTrigger) continue
        if (!canInteract(hc.layer, hc.mask, bc.layer, bc.mask, hc.group, bc.group)) continue

        const bAABB = getAABB(bt, bc)
        const result = generateHeightFieldBoxManifold(
          ht.x,
          ht.y,
          hc.heights,
          hc.scaleX,
          hc.scaleY,
          bAABB.cx,
          bAABB.cy,
          bAABB.hw,
          bAABB.hh,
        )
        if (!result) continue

        const combinedFriction = combineCoefficients(
          hc.friction,
          hc.frictionCombineRule,
          bc.friction,
          bc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          hc.restitution,
          hc.restitutionCombineRule,
          bc.restitution,
          bc.restitutionCombineRule,
        )

        const key = pairKey(hid, bid)
        const manifold: ContactManifold = {
          entityA: hid,
          entityB: bid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [hid, bid])
      }

      for (const cid of dynamicCircle) {
        const crb = world.getComponent<RigidBodyComponent>(cid, T.rigidBody)!
        if (crb.sleeping) continue
        const ct = world.getComponent<TransformComponent>(cid, T.transform)!
        const cc = world.getComponent<CircleColliderComponent>(cid, T.circle)!
        if (!cc.enabled || cc.isTrigger) continue
        if (!canInteract(hc.layer, hc.mask, cc.layer, cc.mask, hc.group, cc.group)) continue

        const result = generateHeightFieldCircleManifold(
          ht.x,
          ht.y,
          hc.heights,
          hc.scaleX,
          hc.scaleY,
          ct.x + cc.offsetX,
          ct.y + cc.offsetY,
          cc.radius,
        )
        if (!result) continue

        const combinedFriction = combineCoefficients(
          hc.friction,
          hc.frictionCombineRule,
          cc.friction,
          cc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          hc.restitution,
          hc.restitutionCombineRule,
          cc.restitution,
          cc.restitutionCombineRule,
        )

        const key = pairKey(hid, cid)
        const manifold: ContactManifold = {
          entityA: hid,
          entityB: cid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [hid, cid])
      }
    }

    // ── HalfSpace vs dynamic box & circle (infinite, test all dynamics) ──
    for (const hid of allHalfSpace) {
      const ht = world.getComponent<TransformComponent>(hid, T.transform)!
      const hc = world.getComponent<HalfSpaceColliderComponent>(hid, 'HalfSpaceCollider')!
      if (!hc.enabled) continue

      for (const bid of dynamicBox) {
        const brb = world.getComponent<RigidBodyComponent>(bid, T.rigidBody)!
        if (brb.sleeping) continue
        const bt = world.getComponent<TransformComponent>(bid, T.transform)!
        const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
        if (!bc.enabled || bc.isTrigger) continue
        if (!canInteract(hc.layer, hc.mask, bc.layer, bc.mask, hc.group, bc.group)) continue

        const bAABB = getAABB(bt, bc)
        const result = generateHalfSpaceBoxManifold(
          ht.x,
          ht.y,
          hc.normalX,
          hc.normalY,
          bAABB.cx,
          bAABB.cy,
          bAABB.hw,
          bAABB.hh,
        )
        if (!result) continue

        const combinedFriction = combineCoefficients(
          hc.friction,
          hc.frictionCombineRule,
          bc.friction,
          bc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          hc.restitution,
          hc.restitutionCombineRule,
          bc.restitution,
          bc.restitutionCombineRule,
        )

        const key = pairKey(hid, bid)
        const manifold: ContactManifold = {
          entityA: hid,
          entityB: bid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [hid, bid])
      }

      for (const cid of dynamicCircle) {
        const crb = world.getComponent<RigidBodyComponent>(cid, T.rigidBody)!
        if (crb.sleeping) continue
        const ct = world.getComponent<TransformComponent>(cid, T.transform)!
        const cc = world.getComponent<CircleColliderComponent>(cid, T.circle)!
        if (!cc.enabled || cc.isTrigger) continue
        if (!canInteract(hc.layer, hc.mask, cc.layer, cc.mask, hc.group, cc.group)) continue

        const result = generateHalfSpaceCircleManifold(
          ht.x,
          ht.y,
          hc.normalX,
          hc.normalY,
          ct.x + cc.offsetX,
          ct.y + cc.offsetY,
          cc.radius,
        )
        if (!result) continue

        const combinedFriction = combineCoefficients(
          hc.friction,
          hc.frictionCombineRule,
          cc.friction,
          cc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          hc.restitution,
          hc.restitutionCombineRule,
          cc.restitution,
          cc.restitutionCombineRule,
        )

        const key = pairKey(hid, cid)
        const manifold: ContactManifold = {
          entityA: hid,
          entityB: cid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [hid, cid])
      }
    }

    // ── TriMesh vs dynamic box & circle (with BVH acceleration) ──────────
    for (const mid of allTriMesh) {
      const mt = world.getComponent<TransformComponent>(mid, T.transform)!
      const mc = world.getComponent<TriMeshColliderComponent>(mid, 'TriMeshCollider')!
      if (!mc.enabled) continue

      // Cache geometry in mesh-local space so moving the entity only changes
      // the query transform. Compare values as well as array identity because
      // callers can reshape the mutable vertices and indices in place.
      let cachedBVH = this.bvhCache.get(mc)
      const geometryChanged =
        !cachedBVH ||
        cachedBVH.vertices.length !== mc.vertices.length ||
        cachedBVH.indices.length !== mc.indices.length ||
        mc.vertices.some((v, i) => v.x !== cachedBVH!.vertices[i].x || v.y !== cachedBVH!.vertices[i].y) ||
        mc.indices.some((index, i) => index !== cachedBVH!.indices[i])
      if (geometryChanged) {
        cachedBVH = {
          bvh: buildBVH(mc.vertices, mc.indices),
          vertices: mc.vertices.map(({ x, y }) => ({ x, y })),
          indices: [...mc.indices],
        }
        this.bvhCache.set(mc, cachedBVH)
      }
      const bvh = cachedBVH!.bvh

      for (const bid of dynamicBox) {
        const brb = world.getComponent<RigidBodyComponent>(bid, T.rigidBody)!
        if (brb.sleeping) continue
        const bt = world.getComponent<TransformComponent>(bid, T.transform)!
        const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
        if (!bc.enabled || bc.isTrigger) continue
        if (!canInteract(mc.layer, mc.mask, bc.layer, bc.mask, mc.group, bc.group)) continue

        const bAABB = getAABB(bt, bc)
        const result = generateTriMeshBoxManifold(bvh, mt.x, mt.y, bAABB.cx, bAABB.cy, bAABB.hw, bAABB.hh)
        if (!result) continue

        const combinedFriction = combineCoefficients(
          mc.friction,
          mc.frictionCombineRule,
          bc.friction,
          bc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          mc.restitution,
          mc.restitutionCombineRule,
          bc.restitution,
          bc.restitutionCombineRule,
        )

        const key = pairKey(mid, bid)
        const manifold: ContactManifold = {
          entityA: mid,
          entityB: bid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [mid, bid])
      }

      for (const cid of dynamicCircle) {
        const crb = world.getComponent<RigidBodyComponent>(cid, T.rigidBody)!
        if (crb.sleeping) continue
        const ct = world.getComponent<TransformComponent>(cid, T.transform)!
        const cc = world.getComponent<CircleColliderComponent>(cid, T.circle)!
        if (!cc.enabled || cc.isTrigger) continue
        if (!canInteract(mc.layer, mc.mask, cc.layer, cc.mask, mc.group, cc.group)) continue

        const result = generateTriMeshCircleManifold(bvh, mt.x, mt.y, ct.x + cc.offsetX, ct.y + cc.offsetY, cc.radius)
        if (!result) continue

        const combinedFriction = combineCoefficients(
          mc.friction,
          mc.frictionCombineRule,
          cc.friction,
          cc.frictionCombineRule,
        )
        const combinedRestitution = combineCoefficients(
          mc.restitution,
          mc.restitutionCombineRule,
          cc.restitution,
          cc.restitutionCombineRule,
        )

        const key = pairKey(mid, cid)
        const manifold: ContactManifold = {
          entityA: mid,
          entityB: cid,
          normalX: result.normalX,
          normalY: result.normalY,
          points: result.points,
          friction: combinedFriction,
          restitution: combinedRestitution,
        }
        const cached = this.manifoldCache.get(key)
        if (cached && this.config.warmStarting) warmStartManifold(manifold, cached, this.config.warmStartingFactor)
        manifolds.push(manifold)
        currentCollisionPairs.set(key, [mid, cid])
      }
    }

    // ── Phase 3.5: Filter and modify manifolds ───────────────────────────
    // Remove manifolds for joint contact exclusions
    if (jointExcludedPairs.size > 0) {
      for (let i = manifolds.length - 1; i >= 0; i--) {
        const m = manifolds[i]
        const ka = pairKey(m.entityA, m.entityB)
        if (jointExcludedPairs.has(ka)) {
          manifolds.splice(i, 1)
        }
      }
    }
    // Apply onContactFilter hook — user can reject contact pairs
    if (this.hooks.onContactFilter) {
      for (let i = manifolds.length - 1; i >= 0; i--) {
        if (!this.hooks.onContactFilter(manifolds[i].entityA, manifolds[i].entityB)) {
          manifolds.splice(i, 1)
        }
      }
    }
    // Apply onContactModify hook — user can change friction, restitution, normal
    if (this.hooks.onContactModify) {
      for (const m of manifolds) {
        this.hooks.onContactModify(m)
      }
    }

    // ── Phase 4: Build solver bodies ──────────────────────────────────────

    const solverBodies = this._solverBodies
    solverBodies.clear()
    this._solverPoolUsed = 0

    for (const id of allBox) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      const t = world.getComponent<TransformComponent>(id, T.transform)!
      solverBodies.set(id, this.solverBody(id, t, rb))
    }
    for (const id of dynamicCircle) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      const t = world.getComponent<TransformComponent>(id, T.transform)!
      solverBodies.set(id, this.solverBody(id, t, rb))
    }
    // Also add static circle entities that are referenced in manifolds
    for (const id of allCircle) {
      if (solverBodies.has(id)) continue
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)
      if (!rb) continue
      const t = world.getComponent<TransformComponent>(id, T.transform)!
      solverBodies.set(id, this.solverBody(id, t, rb))
    }

    // Add capsule solver bodies
    for (const id of allCapsule) {
      if (solverBodies.has(id)) continue
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      const t = world.getComponent<TransformComponent>(id, T.transform)!
      solverBodies.set(id, this.solverBody(id, t, rb))
    }

    // Add polygon dynamic/static solver bodies
    for (const id of allPolygon) {
      if (solverBodies.has(id)) continue
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      const t = world.getComponent<TransformComponent>(id, T.transform)!
      solverBodies.set(id, this.solverBody(id, t, rb))
    }

    // Add triangle dynamic/static solver bodies
    for (const id of allTriangle) {
      if (solverBodies.has(id)) continue
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      const t = world.getComponent<TransformComponent>(id, T.transform)!
      solverBodies.set(id, this.solverBody(id, t, rb))
    }

    // Add static-only solver bodies for segments, heightfields, halfspaces, trimeshes
    // (they appear in manifolds as entityA but have invMass=0, invInertia=0)
    for (const id of allSegment) {
      if (solverBodies.has(id)) continue
      const t = world.getComponent<TransformComponent>(id, T.transform)!
      solverBodies.set(id, this.solverBody(id, t, null))
    }
    for (const id of allHeightField) {
      if (solverBodies.has(id)) continue
      const t = world.getComponent<TransformComponent>(id, T.transform)!
      solverBodies.set(id, this.solverBody(id, t, null))
    }
    for (const id of allHalfSpace) {
      if (solverBodies.has(id)) continue
      const t = world.getComponent<TransformComponent>(id, T.transform)!
      solverBodies.set(id, this.solverBody(id, t, null))
    }
    for (const id of allTriMesh) {
      if (solverBodies.has(id)) continue
      const t = world.getComponent<TransformComponent>(id, T.transform)!
      solverBodies.set(id, this.solverBody(id, t, null))
    }

    // ── Phase 5: Solve velocity constraints ───────────────────────────────

    const constraints = initializeConstraints(
      manifolds,
      solverBodies,
      this.config.warmStarting,
      this.config.warmStartingFactor,
      this.config.restitutionThreshold,
    )

    solveVelocities(constraints, this.config.velocityIterations)

    // ── Phase 5b: Additional solver iterations for bodies that request them ──
    {
      // Find the max additionalSolverIterations across all bodies
      let maxExtra = 0
      for (const [, body] of solverBodies) {
        const rb = world.getComponent<RigidBodyComponent>(body.entityId, 'RigidBody')
        if (rb && rb.additionalSolverIterations > maxExtra) {
          maxExtra = rb.additionalSolverIterations
        }
      }
      if (maxExtra > 0) {
        // Filter constraints where at least one body has additionalSolverIterations > 0
        const extraConstraints = constraints.filter((c) => {
          const rbA = world.getComponent<RigidBodyComponent>(c.bodyA.entityId, 'RigidBody')
          const rbB = world.getComponent<RigidBodyComponent>(c.bodyB.entityId, 'RigidBody')
          return (rbA && rbA.additionalSolverIterations > 0) || (rbB && rbB.additionalSolverIterations > 0)
        })
        if (extraConstraints.length > 0) {
          solveVelocities(extraConstraints, maxExtra)
        }
      }
    }

    // ── Phase 5c: Contact force events ──────────────────────────────────
    // Emit contactForce events with total impulse magnitude per contact pair
    if (this.events) {
      const threshold = this.config.contactForceThreshold
      for (const m of manifolds) {
        let totalNormal = 0
        let totalTangent = 0
        for (const pt of m.points) {
          totalNormal += Math.abs(pt.normalImpulse)
          totalTangent += Math.abs(pt.tangentImpulse)
        }
        const totalImpulse = totalNormal + totalTangent
        if (totalImpulse > threshold) {
          this.events.emit('contactForce', {
            entityA: m.entityA,
            entityB: m.entityB,
            totalNormalImpulse: totalNormal,
            totalTangentImpulse: totalTangent,
            totalImpulse,
            normalX: m.normalX,
            normalY: m.normalY,
          })
        }
      }
    }

    // ── Phase 6: Integrate positions ──────────────────────────────────────

    for (const id of allDynamics) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      if (rb.sleeping) continue

      const body = solverBodies.get(id)
      if (!body) continue

      // Write solved velocities back
      rb.vx = body.vx
      rb.vy = body.vy
      rb.angularVelocity = body.angVel

      const transform = world.getComponent<TransformComponent>(id, T.transform)!
      transform.x += rb.vx * dt
      transform.y += rb.vy * dt
      transform.rotation += rb.angularVelocity * dt

      // Update solver body positions
      body.x = transform.x
      body.y = transform.y
      body.rotation = transform.rotation
    }

    // ── Phase 7: Solve position constraints (split impulse) ──────────────

    initializePseudoVelocities(solverBodies)

    solvePositions(
      constraints,
      this.config.positionIterations,
      this.config.positionCorrectionBeta,
      this.config.penetrationSlop,
    )

    integratePseudoVelocities(solverBodies)

    // Write corrected positions back to transforms
    for (const id of allDynamics) {
      const body = solverBodies.get(id)
      if (!body) continue
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      if (rb.sleeping || rb.isStatic || rb.isKinematic) continue
      const transform = world.getComponent<TransformComponent>(id, T.transform)!
      transform.x = body.x
      transform.y = body.y
      transform.rotation = body.rotation
    }

    // ── Cache manifolds for warm starting ─────────────────────────────────

    this.manifoldCache.clear()
    for (const m of manifolds) {
      this.manifoldCache.set(pairKey(m.entityA, m.entityB), m)
    }

    // ── Phase 8: CCD ──────────────────────────────────────────────────────

    for (let pi = 0; pi < dynamicBox.length; pi++) {
      const id = dynamicBox[pi]
      const prevX = preX[pi]
      const prevY = preY[pi]
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      if (!rb.ccd || rb.sleeping) continue
      const transform = world.getComponent<TransformComponent>(id, T.transform)!
      const col = world.getComponent<BoxColliderComponent>(id, T.box)!

      const totalDx = transform.x - prevX
      const totalDy = transform.y - prevY
      const moveLen = Math.abs(totalDx) + Math.abs(totalDy)
      const halfSize = Math.min(col.width, col.height) / 2
      if (moveLen <= halfSize) continue

      const startCx = prevX + col.offsetX
      const startCy = prevY + col.offsetY
      const hw = col.width / 2
      const hh = col.height / 2

      let earliestT = 1.0
      let hitSid: EntityId | null = null

      const endCx = startCx + totalDx
      const endCy = startCy + totalDy
      const sweepCells = this.getCells(
        (Math.min(startCx, endCx) + Math.max(startCx, endCx)) / 2,
        (Math.min(startCy, endCy) + Math.max(startCy, endCy)) / 2,
        (Math.max(startCx, endCx) - Math.min(startCx, endCx)) / 2 + hw,
        (Math.max(startCy, endCy) - Math.min(startCy, endCy)) / 2 + hh,
      )
      const checked = this._checkedScratch
      checked.clear()
      for (const cell of sweepCells) {
        const bucket = spatialGrid.get(cell)
        if (!bucket) continue
        for (const sid of bucket) {
          if (checked.has(sid)) continue
          checked.add(sid)
          const st = world.getComponent<TransformComponent>(sid, T.transform)!
          const sc = world.getComponent<BoxColliderComponent>(sid, T.box)!
          if (sc.isTrigger || !sc.enabled) continue
          if (!canInteract(col.layer, col.mask, sc.layer, sc.mask, col.group, sc.group)) continue

          const t = sweepAABB(startCx, startCy, hw, hh, totalDx, totalDy, getAABB(st, sc))
          if (t !== null && t < earliestT) {
            earliestT = t
            hitSid = sid
          }
        }
      }

      if (hitSid !== null && earliestT < 1.0) {
        const eps = 0.01
        const clampedT = Math.max(0, earliestT - eps / (Math.hypot(totalDx, totalDy) || 1))
        transform.x = prevX + totalDx * clampedT
        transform.y = prevY + totalDy * clampedT

        const st = world.getComponent<TransformComponent>(hitSid, T.transform)!
        const sc = world.getComponent<BoxColliderComponent>(hitSid, T.box)!
        const staticAABB = getAABB(st, sc)
        const contactCx = prevX + col.offsetX + totalDx * earliestT
        const contactCy = prevY + col.offsetY + totalDy * earliestT
        const dxFromCenter = contactCx - staticAABB.cx
        const dyFromCenter = contactCy - staticAABB.cy
        const overlapX = hw + staticAABB.hw - Math.abs(dxFromCenter)
        const overlapY = hh + staticAABB.hh - Math.abs(dyFromCenter)

        if (overlapX > overlapY) {
          rb.vy = rb.restitution > 0 ? -rb.vy * rb.restitution : 0
          if (dyFromCenter < 0) rb.onGround = true
        } else {
          rb.vx = rb.restitution > 0 ? -rb.vx * rb.restitution : 0
        }
      }
    }

    // ── Phase 9: Ground detection from contacts ───────────────────────────

    // Mark onGround from solved contacts
    // Normal convention: points from entityA toward entityB.
    // If normalY > 0.5 → normal points downward (A above B) → entity A is on ground.
    // If normalY < -0.5 → normal points upward (B above A) → entity B is on ground.
    for (const manifold of manifolds) {
      if (manifold.normalY > 0.5) {
        const rb = world.getComponent<RigidBodyComponent>(manifold.entityA, 'RigidBody')
        if (rb && !rb.isStatic && !rb.isKinematic) {
          rb.onGround = true
          // Platform carry
          const delta = staticDelta.get(manifold.entityB)
          if (delta) {
            const t = world.getComponent<TransformComponent>(manifold.entityA, 'Transform')!
            t.x += delta.dx
            if (delta.dy < 0) t.y += delta.dy
          }
        }
      } else if (manifold.normalY < -0.5) {
        const rb = world.getComponent<RigidBodyComponent>(manifold.entityB, 'RigidBody')
        if (rb && !rb.isStatic && !rb.isKinematic) {
          rb.onGround = true
          const delta = staticDelta.get(manifold.entityA)
          if (delta) {
            const t = world.getComponent<TransformComponent>(manifold.entityB, 'Transform')!
            t.x += delta.dx
            if (delta.dy < 0) t.y += delta.dy
          }
        }
      }
    }

    // ── Phase 10: Near-ground probe ───────────────────────────────────────

    for (const id of dynamicBox) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      if (rb.onGround) {
        rb.isNearGround = true
        continue
      }
      if (rb.sleeping) continue
      const transform = world.getComponent<TransformComponent>(id, T.transform)!
      const col = world.getComponent<BoxColliderComponent>(id, T.box)!
      const probeAABB: AABB = {
        cx: transform.x + col.offsetX,
        cy: transform.y + col.offsetY + 2,
        hw: col.width / 2,
        hh: col.height / 2,
      }
      const candidateCells = this.getCells(probeAABB.cx, probeAABB.cy, probeAABB.hw, probeAABB.hh)
      const checked = this._checkedScratch
      checked.clear()
      outer: for (const cell of candidateCells) {
        const bucket = spatialGrid.get(cell)
        if (!bucket) continue
        for (const sid of bucket) {
          if (checked.has(sid)) continue
          checked.add(sid)
          const st = world.getComponent<TransformComponent>(sid, T.transform)!
          const sc = world.getComponent<BoxColliderComponent>(sid, T.box)!
          if (sc.isTrigger || !sc.enabled) continue
          if (!canInteract(col.layer, col.mask, sc.layer, sc.mask, col.group, sc.group)) continue
          const ov = getOverlap(probeAABB, getAABB(st, sc))
          if (ov && Math.abs(ov.y) <= Math.abs(ov.x) && ov.y < 0) {
            rb.isNearGround = true
            break outer
          }
        }
      }
    }

    // ── Phase 10b: Near-ground for capsule dynamics ───────────────────────

    for (const id of capsuleDynamics) {
      const rb = world.getComponent<RigidBodyComponent>(id, T.rigidBody)!
      if (rb.onGround) {
        rb.isNearGround = true
        continue
      }
      const transform = world.getComponent<TransformComponent>(id, T.transform)!
      const cap = world.getComponent<CapsuleColliderComponent>(id, T.capsule)!
      const probeAABB: AABB = {
        cx: transform.x + cap.offsetX,
        cy: transform.y + cap.offsetY + 2,
        hw: cap.width / 2,
        hh: cap.height / 2,
      }
      const candidateCells = this.getCells(probeAABB.cx, probeAABB.cy, probeAABB.hw, probeAABB.hh)
      const checked = this._checkedScratch
      checked.clear()
      outerCap: for (const cell of candidateCells) {
        const bucket = spatialGrid.get(cell)
        if (!bucket) continue
        for (const sid of bucket) {
          if (checked.has(sid)) continue
          checked.add(sid)
          const st = world.getComponent<TransformComponent>(sid, T.transform)!
          const sc = world.getComponent<BoxColliderComponent>(sid, T.box)!
          if (sc.isTrigger || !sc.enabled) continue
          if (!canInteract(cap.layer, cap.mask, sc.layer, sc.mask, cap.group, sc.group)) continue
          const ov = getOverlap(probeAABB, getAABB(st, sc))
          if (ov && Math.abs(ov.y) <= Math.abs(ov.x) && ov.y < 0) {
            rb.isNearGround = true
            break outerCap
          }
        }
      }
    }

    // ── Phase 11: Joint constraints ───────────────────────────────────────

    const jointEntities = world.query('Joint')
    if (jointEntities.length > 0) {
      const JOINT_ITERATIONS = 4
      for (let iter = 0; iter < JOINT_ITERATIONS; iter++) {
        for (const jid of jointEntities) {
          const joint = world.getComponent<JointComponent>(jid, 'Joint')!
          if (!joint.enabled || joint.broken) continue

          const tA = world.getComponent<TransformComponent>(joint.entityA, 'Transform')
          const tB = world.getComponent<TransformComponent>(joint.entityB, 'Transform')
          if (!tA || !tB) continue
          const rbA = world.getComponent<RigidBodyComponent>(joint.entityA, 'RigidBody')
          const rbB = world.getComponent<RigidBodyComponent>(joint.entityB, 'RigidBody')

          const aStatic = !rbA || rbA.isStatic || rbA.isKinematic
          const bStatic = !rbB || rbB.isStatic || rbB.isKinematic

          const ax = tA.x + joint.anchorA.x
          const ay = tA.y + joint.anchorA.y
          const bx = tB.x + joint.anchorB.x
          const by = tB.y + joint.anchorB.y

          const dxAB = bx - ax
          const dyAB = by - ay
          const currentLength = Math.sqrt(dxAB * dxAB + dyAB * dyAB)

          let impulseAccum = 0

          if (joint.jointType === 'distance') {
            if (currentLength < 0.0001) continue
            const nx = dxAB / currentLength
            const ny = dyAB / currentLength
            const diff = currentLength - joint.length
            impulseAccum = Math.abs(diff)
            const correctionX = nx * diff * 0.5
            const correctionY = ny * diff * 0.5
            if (!aStatic && !bStatic) {
              tA.x += correctionX
              tA.y += correctionY
              tB.x -= correctionX
              tB.y -= correctionY
            } else if (!aStatic) {
              tA.x += correctionX * 2
              tA.y += correctionY * 2
            } else if (!bStatic) {
              tB.x -= correctionX * 2
              tB.y -= correctionY * 2
            }
          } else if (joint.jointType === 'spring') {
            if (currentLength < 0.0001) continue
            const nx = dxAB / currentLength
            const ny = dyAB / currentLength
            const displacement = currentLength - joint.length
            let fx = joint.stiffness * displacement * nx
            let fy = joint.stiffness * displacement * ny
            if (rbA && rbB) {
              const relVx = rbB.vx - rbA.vx
              const relVy = rbB.vy - rbA.vy
              const relVDot = relVx * nx + relVy * ny
              fx += joint.damping * relVDot * nx
              fy += joint.damping * relVDot * ny
            }
            impulseAccum = Math.sqrt(fx * fx + fy * fy) * dt
            if (!aStatic && rbA) {
              rbA.vx += fx * dt
              rbA.vy += fy * dt
            }
            if (!bStatic && rbB) {
              rbB.vx -= fx * dt
              rbB.vy -= fy * dt
            }
          } else if (joint.jointType === 'revolute') {
            // Position constraint: anchor points must coincide
            const midX = (ax + bx) / 2
            const midY = (ay + by) / 2
            impulseAccum = currentLength
            if (!aStatic && !bStatic) {
              tA.x += midX - ax
              tA.y += midY - ay
              tB.x += midX - bx
              tB.y += midY - by
            } else if (!aStatic) {
              tA.x += bx - ax
              tA.y += by - ay
            } else if (!bStatic) {
              tB.x += ax - bx
              tB.y += ay - by
            }

            // Angle limits
            if (joint.minAngle !== null || joint.maxAngle !== null) {
              const relAngle = tB.rotation - tA.rotation
              const minA = joint.minAngle ?? -Infinity
              const maxA = joint.maxAngle ?? Infinity
              if (relAngle < minA) {
                const correction = minA - relAngle
                if (!aStatic && !bStatic) {
                  tA.rotation -= correction * 0.5
                  tB.rotation += correction * 0.5
                } else if (!aStatic) {
                  tA.rotation -= correction
                } else if (!bStatic) {
                  tB.rotation += correction
                }
              } else if (relAngle > maxA) {
                const correction = relAngle - maxA
                if (!aStatic && !bStatic) {
                  tA.rotation += correction * 0.5
                  tB.rotation -= correction * 0.5
                } else if (!aStatic) {
                  tA.rotation += correction
                } else if (!bStatic) {
                  tB.rotation -= correction
                }
              }
            }

            // Motor
            if (joint.motor && rbA && rbB) {
              const m = joint.motor
              let motorImpulse = 0
              if (m.mode === 'velocity') {
                // Target angular velocity difference
                const relAngVel = (rbB.angularVelocity ?? 0) - (rbA.angularVelocity ?? 0)
                motorImpulse = m.stiffness * (m.target - relAngVel) * dt
              } else {
                // Position mode: PD controller toward target angle
                const relAngle = tB.rotation - tA.rotation
                const relAngVel = (rbB.angularVelocity ?? 0) - (rbA.angularVelocity ?? 0)
                motorImpulse = (m.stiffness * (m.target - relAngle) - m.damping * relAngVel) * dt
              }
              // Clamp to maxForce
              if (m.maxForce > 0) {
                motorImpulse = Math.max(-m.maxForce * dt, Math.min(m.maxForce * dt, motorImpulse))
              }
              if (!aStatic) rbA.angularVelocity -= motorImpulse * (rbA.invInertia > 0 ? 1 : 0)
              if (!bStatic) rbB.angularVelocity += motorImpulse * (rbB.invInertia > 0 ? 1 : 0)
            }
          } else if (joint.jointType === 'rope') {
            const maxLen = joint.maxLength ?? joint.length
            if (currentLength <= maxLen) continue
            if (currentLength < 0.0001) continue
            const nx = dxAB / currentLength
            const ny = dyAB / currentLength
            const diff = currentLength - maxLen
            impulseAccum = diff
            const correctionX = nx * diff * 0.5
            const correctionY = ny * diff * 0.5
            if (!aStatic && !bStatic) {
              tA.x += correctionX
              tA.y += correctionY
              tB.x -= correctionX
              tB.y -= correctionY
            } else if (!aStatic) {
              tA.x += correctionX * 2
              tA.y += correctionY * 2
            } else if (!bStatic) {
              tB.x -= correctionX * 2
              tB.y -= correctionY * 2
            }
          } else if (joint.jointType === 'fixed' || joint.jointType === 'weld') {
            // Lock relative position: both anchors must coincide
            impulseAccum = currentLength
            if (currentLength > 0.0001) {
              const correctionX = dxAB * 0.5
              const correctionY = dyAB * 0.5
              if (!aStatic && !bStatic) {
                tA.x += correctionX
                tA.y += correctionY
                tB.x -= correctionX
                tB.y -= correctionY
              } else if (!aStatic) {
                tA.x += correctionX * 2
                tA.y += correctionY * 2
              } else if (!bStatic) {
                tB.x -= correctionX * 2
                tB.y -= correctionY * 2
              }
            }
            // Lock relative rotation: maintain initial rotation difference (0 for fixed)
            const relAngle = tB.rotation - tA.rotation
            if (Math.abs(relAngle) > 0.0001) {
              if (!aStatic && !bStatic) {
                tA.rotation += relAngle * 0.5
                tB.rotation -= relAngle * 0.5
              } else if (!aStatic) {
                tA.rotation += relAngle
              } else if (!bStatic) {
                tB.rotation -= relAngle
              }
            }
          } else if (joint.jointType === 'prismatic') {
            // Movement constrained to localAxisA direction only
            const axisX = joint.localAxisA.x
            const axisY = joint.localAxisA.y
            // Perpendicular axis
            const perpX = -axisY
            const perpY = axisX

            // Project displacement onto perpendicular — this is the error
            const perpError = dxAB * perpX + dyAB * perpY
            impulseAccum = Math.abs(perpError)

            // Correct perpendicular drift
            if (Math.abs(perpError) > 0.0001) {
              const cx = perpX * perpError * 0.5
              const cy = perpY * perpError * 0.5
              if (!aStatic && !bStatic) {
                tA.x += cx
                tA.y += cy
                tB.x -= cx
                tB.y -= cy
              } else if (!aStatic) {
                tA.x += cx * 2
                tA.y += cy * 2
              } else if (!bStatic) {
                tB.x -= cx * 2
                tB.y -= cy * 2
              }
            }

            // Distance limits along axis
            const axisDist = dxAB * axisX + dyAB * axisY
            if (joint.minDistance !== null && axisDist < joint.minDistance) {
              const diff = joint.minDistance - axisDist
              const cx = axisX * diff * 0.5
              const cy = axisY * diff * 0.5
              if (!aStatic && !bStatic) {
                tA.x -= cx
                tA.y -= cy
                tB.x += cx
                tB.y += cy
              } else if (!aStatic) {
                tA.x -= cx * 2
                tA.y -= cy * 2
              } else if (!bStatic) {
                tB.x += cx * 2
                tB.y += cy * 2
              }
            } else if (joint.maxDistance !== null && axisDist > joint.maxDistance) {
              const diff = axisDist - joint.maxDistance
              const cx = axisX * diff * 0.5
              const cy = axisY * diff * 0.5
              if (!aStatic && !bStatic) {
                tA.x += cx
                tA.y += cy
                tB.x -= cx
                tB.y -= cy
              } else if (!aStatic) {
                tA.x += cx * 2
                tA.y += cy * 2
              } else if (!bStatic) {
                tB.x -= cx * 2
                tB.y -= cy * 2
              }
            }

            // Motor along axis
            if (joint.motor && rbA && rbB) {
              const m = joint.motor
              let motorImpulse = 0
              if (m.mode === 'velocity') {
                const relVelAxis = (rbB.vx - rbA.vx) * axisX + (rbB.vy - rbA.vy) * axisY
                motorImpulse = m.stiffness * (m.target - relVelAxis) * dt
              } else {
                const relVelAxis = (rbB.vx - rbA.vx) * axisX + (rbB.vy - rbA.vy) * axisY
                motorImpulse = (m.stiffness * (m.target - axisDist) - m.damping * relVelAxis) * dt
              }
              if (m.maxForce > 0) {
                motorImpulse = Math.max(-m.maxForce * dt, Math.min(m.maxForce * dt, motorImpulse))
              }
              const invMassA = rbA.invMass || 0
              const invMassB = rbB.invMass || 0
              if (!aStatic && invMassA > 0) {
                rbA.vx -= motorImpulse * axisX * invMassA
                rbA.vy -= motorImpulse * axisY * invMassA
              }
              if (!bStatic && invMassB > 0) {
                rbB.vx += motorImpulse * axisX * invMassB
                rbB.vy += motorImpulse * axisY * invMassB
              }
            }
          } else if (joint.jointType === 'generic') {
            // Configurable per-axis locks
            // X-axis lock
            if (joint.axisLockX === 'locked') {
              const cx = dxAB * 0.5
              if (Math.abs(cx) > 0.0001) {
                if (!aStatic && !bStatic) {
                  tA.x += cx
                  tB.x -= cx
                } else if (!aStatic) {
                  tA.x += cx * 2
                } else if (!bStatic) {
                  tB.x -= cx * 2
                }
              }
            }
            // Y-axis lock
            if (joint.axisLockY === 'locked') {
              const cy = dyAB * 0.5
              if (Math.abs(cy) > 0.0001) {
                if (!aStatic && !bStatic) {
                  tA.y += cy
                  tB.y -= cy
                } else if (!aStatic) {
                  tA.y += cy * 2
                } else if (!bStatic) {
                  tB.y -= cy * 2
                }
              }
            }
            // Rotation lock
            if (joint.axisLockRotation === 'locked') {
              const relAngle = tB.rotation - tA.rotation
              if (Math.abs(relAngle) > 0.0001) {
                if (!aStatic && !bStatic) {
                  tA.rotation += relAngle * 0.5
                  tB.rotation -= relAngle * 0.5
                } else if (!aStatic) {
                  tA.rotation += relAngle
                } else if (!bStatic) {
                  tB.rotation -= relAngle
                }
              }
            }
            impulseAccum = currentLength
          }

          // Track accumulated impulse for break detection
          joint._accumulatedImpulse += impulseAccum

          // Break detection (check after last iteration)
          if (iter === JOINT_ITERATIONS - 1 && joint.breakForce > 0) {
            if (joint._accumulatedImpulse > joint.breakForce) {
              joint.broken = true
              this.events?.emit('jointBreak', { entityId: jid, joint, force: joint._accumulatedImpulse })
            }
            joint._accumulatedImpulse = 0 // reset for next frame
          }
        }
      }
    }

    // ── Phase 12: Collision events ────────────────────────────────────────

    if (this.listens('collision'))
      for (const [key, [a, b]] of currentCollisionPairs) {
        // manifoldCache holds the current-frame contact normal (A→B direction)
        const m = this.manifoldCache.get(key)
        const normalX = m?.normalX ?? 0
        const normalY = m?.normalY ?? 0
        if (!this.activeCollisionPairs.has(key)) {
          this.events?.emit('collisionEnter', { a, b, normalX, normalY })
        } else {
          this.events?.emit('collisionStay', { a, b, normalX, normalY })
        }
        this.events?.emit('collision', { a, b, normalX, normalY })
      }
    if (this.listens('collision'))
      for (const [key, [a, b]] of this.activeCollisionPairs) {
        if (!currentCollisionPairs.has(key)) {
          this.events?.emit('collisionExit', { a, b, normalX: 0, normalY: 0 })
        }
      }
    if (this._anySleeping) this.wakeSeparated(world, this.activeCollisionPairs, currentCollisionPairs)
    // Double-buffer swap: last frame's active becomes next frame's scratch.
    {
      const prev = this.activeCollisionPairs
      this.activeCollisionPairs = currentCollisionPairs
      this._currentCollisionPairs = prev
    }

    // ── Phase 13: Trigger detection ───────────────────────────────────────

    const allWithCollider = world.query('Transform', 'BoxCollider')
    const currentTriggerPairs = this._currentTriggerPairs
    currentTriggerPairs.clear()
    const triggerNormals = this._triggerNormals
    triggerNormals.clear()

    this.forEachSpatialCandidatePair(
      allWithCollider,
      (id) => {
        const c = world.getComponent<BoxColliderComponent>(id, T.box)!
        if (!c.enabled) return null
        return getAABB(world.getComponent<TransformComponent>(id, T.transform)!, c)
      },
      (ia, ib) => {
        const ca = world.getComponent<BoxColliderComponent>(ia, T.box)!
        const cb = world.getComponent<BoxColliderComponent>(ib, T.box)!
        if (!ca.isTrigger && !cb.isTrigger) return
        if (!ca.enabled || !cb.enabled) return
        if (!canInteract(ca.layer, ca.mask, cb.layer, cb.mask, ca.group, cb.group)) return
        const ta = world.getComponent<TransformComponent>(ia, T.transform)!
        const tb = world.getComponent<TransformComponent>(ib, T.transform)!
        const ov = getOverlap(getAABB(ta, ca), getAABB(tb, cb))
        if (!ov) return
        const key = pairKey(ia, ib)
        currentTriggerPairs.set(key, [ia, ib])
        // Contact normal (A→B) via minimum-penetration axis
        let nx = 0,
          ny = 0
        if (Math.abs(ov.x) < Math.abs(ov.y)) {
          nx = ov.x > 0 ? 1 : -1
        } else {
          ny = ov.y > 0 ? 1 : -1
        }
        triggerNormals.set(key, { nx, ny })
      },
    )

    if (this.listens('trigger'))
      for (const [key, [a, b]] of currentTriggerPairs) {
        const tn = triggerNormals.get(key)
        const normalX = tn?.nx ?? 0
        const normalY = tn?.ny ?? 0
        if (!this.activeTriggerPairs.has(key)) this.events?.emit('triggerEnter', { a, b, normalX, normalY })
        else this.events?.emit('triggerStay', { a, b, normalX, normalY })
        this.events?.emit('trigger', { a, b, normalX, normalY })
      }
    if (this.listens('trigger'))
      for (const [key, [a, b]] of this.activeTriggerPairs) {
        if (!currentTriggerPairs.has(key)) this.events?.emit('triggerExit', { a, b, normalX: 0, normalY: 0 })
      }
    {
      const prev = this.activeTriggerPairs
      this.activeTriggerPairs = currentTriggerPairs
      this._currentTriggerPairs = prev
    }

    // ── Phase 14: Circle contact events ───────────────────────────────────

    if (allCircle.length > 0) {
      const currentCirclePairs = this._currentCirclePairs
      currentCirclePairs.clear()
      const circleNormals = this._circleNormals
      circleNormals.clear()

      this.forEachSpatialCandidatePair(
        allCircle,
        (id) => {
          const c = world.getComponent<CircleColliderComponent>(id, T.circle)!
          if (!c.enabled) return null
          const t = world.getComponent<TransformComponent>(id, T.transform)!
          return { cx: t.x + c.offsetX, cy: t.y + c.offsetY, hw: c.radius, hh: c.radius }
        },
        (ia, ib) => {
          const ca = world.getComponent<CircleColliderComponent>(ia, T.circle)!
          const cb = world.getComponent<CircleColliderComponent>(ib, T.circle)!
          if (!ca.enabled || !cb.enabled) return
          if (!maskAllows(ca.mask, cb.layer) || !maskAllows(cb.mask, ca.layer)) return
          const ta = world.getComponent<TransformComponent>(ia, T.transform)!
          const tb = world.getComponent<TransformComponent>(ib, T.transform)!
          const dx = ta.x + ca.offsetX - (tb.x + cb.offsetX)
          const dy = ta.y + ca.offsetY - (tb.y + cb.offsetY)
          const distSq = dx * dx + dy * dy
          if (distSq < (ca.radius + cb.radius) ** 2) {
            const key = pairKey(ia, ib)
            currentCirclePairs.set(key, [ia, ib])
            // Normal points A→B (from ia toward ib)
            const dist = Math.sqrt(distSq)
            circleNormals.set(key, {
              nx: dist > 0 ? dx / dist : 0,
              ny: dist > 0 ? dy / dist : 0,
            })
          }
        },
      )

      // Circle-AABB events
      const allBoxes = world.query('Transform', 'BoxCollider')
      this.forEachSpatialCandidateCrossPair(
        allCircle,
        allBoxes,
        (id) => {
          const c = world.getComponent<CircleColliderComponent>(id, T.circle)!
          if (!c.enabled) return null
          const t = world.getComponent<TransformComponent>(id, T.transform)!
          return { cx: t.x + c.offsetX, cy: t.y + c.offsetY, hw: c.radius, hh: c.radius }
        },
        (id) => {
          const c = world.getComponent<BoxColliderComponent>(id, T.box)!
          if (!c.enabled) return null
          return getAABB(world.getComponent<TransformComponent>(id, T.transform)!, c)
        },
        (cid, bid) => {
          const cc = world.getComponent<CircleColliderComponent>(cid, T.circle)!
          const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
          if (!maskAllows(cc.mask, bc.layer) || !maskAllows(bc.mask, cc.layer)) return
          const ct = world.getComponent<TransformComponent>(cid, T.transform)!
          const cx = ct.x + cc.offsetX
          const cy = ct.y + cc.offsetY
          const bt = world.getComponent<TransformComponent>(bid, T.transform)!
          const bx = bt.x + bc.offsetX
          const by = bt.y + bc.offsetY
          const nearX = Math.max(bx - bc.width / 2, Math.min(cx, bx + bc.width / 2))
          const nearY = Math.max(by - bc.height / 2, Math.min(cy, by + bc.height / 2))
          const dx = cx - nearX
          const dy = cy - nearY
          const distSq = dx * dx + dy * dy
          if (distSq < cc.radius * cc.radius) {
            const key = pairKey(cid, bid)
            currentCirclePairs.set(key, [cid, bid])
            const dist = Math.sqrt(distSq)
            circleNormals.set(key, {
              nx: dist > 0 ? dx / dist : 0,
              ny: dist > 0 ? dy / dist : 0,
            })
          }
        },
      )

      if (this.listens('circle'))
        for (const [key, [a, b]] of currentCirclePairs) {
          const cn = circleNormals.get(key)
          const normalX = cn?.nx ?? 0
          const normalY = cn?.ny ?? 0
          if (!this.activeCirclePairs.has(key)) this.events?.emit('circleEnter', { a, b, normalX, normalY })
          else this.events?.emit('circleStay', { a, b, normalX, normalY })
          this.events?.emit('circle', { a, b, normalX, normalY })
        }
      if (this.listens('circle'))
        for (const [key, [a, b]] of this.activeCirclePairs) {
          if (!currentCirclePairs.has(key)) this.events?.emit('circleExit', { a, b, normalX: 0, normalY: 0 })
        }
      if (this._anySleeping) this.wakeSeparated(world, this.activeCirclePairs, currentCirclePairs)
      {
        const prev = this.activeCirclePairs
        this.activeCirclePairs = currentCirclePairs
        this._currentCirclePairs = prev
      }
    } else if (this.activeCirclePairs.size > 0) {
      for (const [, [a, b]] of this.activeCirclePairs) this.events?.emit('circleExit', { a, b, normalX: 0, normalY: 0 })
      this.activeCirclePairs.clear()
    }

    // ── Phase 15: Compound contact events ─────────────────────────────────

    const allCompound = world.query('Transform', 'CompoundCollider')
    if (allCompound.length > 0) {
      const currentCompoundPairs = this._currentCompoundPairs
      currentCompoundPairs.clear()

      const allBoxEntities = world.query('Transform', 'BoxCollider')
      for (const cid of allCompound) {
        const cc = world.getComponent<CompoundColliderComponent>(cid, T.compound)!
        const ct = world.getComponent<TransformComponent>(cid, T.transform)!
        for (const bid of allBoxEntities) {
          if (bid === cid) continue
          const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
          if (!canInteract(cc.layer, cc.mask, bc.layer, bc.mask, cc.group, bc.group)) continue
          const bt = world.getComponent<TransformComponent>(bid, T.transform)!
          const boxAABB = getAABB(bt, bc)
          for (const shape of cc.shapes) {
            if (shapeOverlapsAABB(ct.x, ct.y, shape, boxAABB)) {
              currentCompoundPairs.set(pairKey(cid, bid), [cid, bid])
              break
            }
          }
        }
      }

      for (const cid of allCompound) {
        const cc = world.getComponent<CompoundColliderComponent>(cid, T.compound)!
        const ct = world.getComponent<TransformComponent>(cid, T.transform)!
        for (const oid of allCircle) {
          if (oid === cid) continue
          const oc = world.getComponent<CircleColliderComponent>(oid, T.circle)!
          if (!canInteract(cc.layer, cc.mask, oc.layer, oc.mask, cc.group, oc.group)) continue
          const ot = world.getComponent<TransformComponent>(oid, T.transform)!
          for (const shape of cc.shapes) {
            if (shapeOverlapsCircle(ct.x, ct.y, shape, ot.x + oc.offsetX, ot.y + oc.offsetY, oc.radius)) {
              currentCompoundPairs.set(pairKey(cid, oid), [cid, oid])
              break
            }
          }
        }
      }

      for (let i = 0; i < allCompound.length; i++) {
        const ia = allCompound[i]
        const ca = world.getComponent<CompoundColliderComponent>(ia, T.compound)!
        const ta = world.getComponent<TransformComponent>(ia, T.transform)!
        const boundsA = getCompoundBounds(ta.x, ta.y, ca.shapes)
        for (let j = i + 1; j < allCompound.length; j++) {
          const ib = allCompound[j]
          const cb = world.getComponent<CompoundColliderComponent>(ib, T.compound)!
          if (!canInteract(ca.layer, ca.mask, cb.layer, cb.mask, ca.group, cb.group)) continue
          const tb = world.getComponent<TransformComponent>(ib, T.transform)!
          const boundsB = getCompoundBounds(tb.x, tb.y, cb.shapes)
          if (!getOverlap(boundsA, boundsB)) continue
          let hit = false
          outer2: for (const sa of ca.shapes) {
            const aabb = shapeToAABB(ta.x, ta.y, sa)
            for (const sb of cb.shapes) {
              if (sb.type === 'circle') {
                if (shapeOverlapsCircle(ta.x, ta.y, sa, tb.x + sb.offsetX, tb.y + sb.offsetY, sb.radius ?? 0)) {
                  hit = true
                  break outer2
                }
              } else {
                if (getOverlap(aabb, shapeToAABB(tb.x, tb.y, sb))) {
                  hit = true
                  break outer2
                }
              }
            }
          }
          if (hit) currentCompoundPairs.set(pairKey(ia, ib), [ia, ib])
        }
      }

      if (this.listens('compound'))
        for (const [key, [a, b]] of currentCompoundPairs) {
          if (!this.activeCompoundPairs.has(key)) this.events?.emit('compoundEnter', { a, b })
          else this.events?.emit('compoundStay', { a, b })
          this.events?.emit('compound', { a, b })
        }
      if (this.listens('compound'))
        for (const [key, [a, b]] of this.activeCompoundPairs) {
          if (!currentCompoundPairs.has(key)) this.events?.emit('compoundExit', { a, b })
        }
      {
        const prev = this.activeCompoundPairs
        this.activeCompoundPairs = currentCompoundPairs
        this._currentCompoundPairs = prev
      }
    } else if (this.activeCompoundPairs.size > 0) {
      for (const [, [a, b]] of this.activeCompoundPairs) this.events?.emit('compoundExit', { a, b })
      this.activeCompoundPairs.clear()
    }

    // ── Phase 16: Capsule contact events ──────────────────────────────────

    if (allCapsule.length > 0) {
      const currentCapsulePairs = this._currentCapsulePairs
      currentCapsulePairs.clear()
      const allBoxForCapsule = world.query('Transform', 'BoxCollider')

      for (const cid of allCapsule) {
        const cc = world.getComponent<CapsuleColliderComponent>(cid, T.capsule)!
        const ct = world.getComponent<TransformComponent>(cid, T.transform)!
        const capsuleAABB = getCapsuleAABB(ct, cc)
        for (const bid of allBoxForCapsule) {
          if (bid === cid) continue
          const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
          if (!canInteract(cc.layer, cc.mask, bc.layer, bc.mask, cc.group, bc.group)) continue
          const bt = world.getComponent<TransformComponent>(bid, T.transform)!
          if (getOverlap(capsuleAABB, getAABB(bt, bc))) {
            currentCapsulePairs.set(pairKey(cid, bid), [cid, bid])
          }
        }
      }

      this.forEachSpatialCandidatePair(
        allCapsule,
        (id) => {
          const c = world.getComponent<CapsuleColliderComponent>(id, T.capsule)!
          const t = world.getComponent<TransformComponent>(id, T.transform)!
          const aabb = getCapsuleAABB(t, c)
          return { cx: aabb.cx, cy: aabb.cy, hw: aabb.hw, hh: aabb.hh }
        },
        (ia, ib) => {
          const ca = world.getComponent<CapsuleColliderComponent>(ia, T.capsule)!
          const cb = world.getComponent<CapsuleColliderComponent>(ib, T.capsule)!
          if (!canInteract(ca.layer, ca.mask, cb.layer, cb.mask, ca.group, cb.group)) return
          const ta = world.getComponent<TransformComponent>(ia, T.transform)!
          const tb = world.getComponent<TransformComponent>(ib, T.transform)!
          if (getOverlap(getCapsuleAABB(ta, ca), getCapsuleAABB(tb, cb))) {
            currentCapsulePairs.set(pairKey(ia, ib), [ia, ib])
          }
        },
      )

      if (this.listens('capsule'))
        for (const [key, [a, b]] of currentCapsulePairs) {
          if (!this.activeCapsulePairs.has(key)) this.events?.emit('capsuleEnter', { a, b })
          else this.events?.emit('capsuleStay', { a, b })
          this.events?.emit('capsule', { a, b })
        }
      if (this.listens('capsule'))
        for (const [key, [a, b]] of this.activeCapsulePairs) {
          if (!currentCapsulePairs.has(key)) this.events?.emit('capsuleExit', { a, b })
        }
      {
        const prev = this.activeCapsulePairs
        this.activeCapsulePairs = currentCapsulePairs
        this._currentCapsulePairs = prev
      }
    } else if (this.activeCapsulePairs.size > 0) {
      for (const [, [a, b]] of this.activeCapsulePairs) this.events?.emit('capsuleExit', { a, b })
      this.activeCapsulePairs.clear()
    }

    // ── Phase 17: Polygon/Triangle contact events ─────────────────────────

    const allPolygonEntities = [...allPolygon, ...allTriangle]
    if (allPolygonEntities.length > 0) {
      const currentPolyPairs = this._currentPolygonPairs
      currentPolyPairs.clear()

      // Polygon/Triangle vs box
      const allBoxForPoly = world.query('Transform', 'BoxCollider')
      for (const pid of allPolygonEntities) {
        const isPoly = world.getComponent<ConvexPolygonColliderComponent>(pid, T.polygon)
        const isTri = world.getComponent<TriangleColliderComponent>(pid, T.triangle)
        const polyLayer = isPoly ? isPoly.layer : isTri ? isTri.layer : 'default'
        const polyMask = isPoly ? isPoly.mask : isTri ? isTri.mask : '*'
        const polyGroup = isPoly ? isPoly.group : isTri ? isTri.group : ''
        const polyEnabled = isPoly ? isPoly.enabled : isTri ? isTri.enabled : true

        if (!polyEnabled) continue

        const pt = world.getComponent<TransformComponent>(pid, T.transform)!
        const verts = isPoly ? isPoly.vertices : isTri ? [isTri.a, isTri.b, isTri.c] : []
        const offX = isPoly ? isPoly.offsetX : isTri ? isTri.offsetX : 0
        const offY = isPoly ? isPoly.offsetY : isTri ? isTri.offsetY : 0

        for (const bid of allBoxForPoly) {
          if (bid === pid) continue
          const bc = world.getComponent<BoxColliderComponent>(bid, T.box)!
          if (!bc.enabled) continue
          if (!canInteract(polyLayer, polyMask, bc.layer, bc.mask, polyGroup, bc.group)) continue
          const bt = world.getComponent<TransformComponent>(bid, T.transform)!
          const bAABB = getAABB(bt, bc)
          const result = generatePolygonBoxManifold(
            verts,
            pt.x,
            pt.y,
            offX,
            offY,
            bAABB.cx,
            bAABB.cy,
            bAABB.hw,
            bAABB.hh,
          )
          if (result) currentPolyPairs.set(pairKey(pid, bid), [pid, bid])
        }
      }

      // Polygon vs polygon
      for (let i = 0; i < allPolygonEntities.length; i++) {
        for (let j = i + 1; j < allPolygonEntities.length; j++) {
          const ia = allPolygonEntities[i]
          const ib = allPolygonEntities[j]
          const pa = world.getComponent<ConvexPolygonColliderComponent>(ia, T.polygon)
          const ta_tri = world.getComponent<TriangleColliderComponent>(ia, T.triangle)
          const pb = world.getComponent<ConvexPolygonColliderComponent>(ib, T.polygon)
          const tb_tri = world.getComponent<TriangleColliderComponent>(ib, T.triangle)
          const vertsA = pa ? pa.vertices : ta_tri ? [ta_tri.a, ta_tri.b, ta_tri.c] : []
          const vertsB = pb ? pb.vertices : tb_tri ? [tb_tri.a, tb_tri.b, tb_tri.c] : []
          const layerA = pa ? pa.layer : ta_tri ? ta_tri.layer : 'default'
          const maskA = pa ? pa.mask : ta_tri ? ta_tri.mask : '*'
          const groupA = pa ? pa.group : ta_tri ? ta_tri.group : ''
          const layerB = pb ? pb.layer : tb_tri ? tb_tri.layer : 'default'
          const maskB = pb ? pb.mask : tb_tri ? tb_tri.mask : '*'
          const groupB = pb ? pb.group : tb_tri ? tb_tri.group : ''
          if (!canInteract(layerA, maskA, layerB, maskB, groupA, groupB)) continue
          const ta2 = world.getComponent<TransformComponent>(ia, T.transform)!
          const tb2 = world.getComponent<TransformComponent>(ib, T.transform)!
          const offAx = pa ? pa.offsetX : ta_tri ? ta_tri.offsetX : 0
          const offAy = pa ? pa.offsetY : ta_tri ? ta_tri.offsetY : 0
          const offBx = pb ? pb.offsetX : tb_tri ? tb_tri.offsetX : 0
          const offBy = pb ? pb.offsetY : tb_tri ? tb_tri.offsetY : 0
          const result = generatePolygonPolygonManifold(
            vertsA,
            ta2.x,
            ta2.y,
            offAx,
            offAy,
            vertsB,
            tb2.x,
            tb2.y,
            offBx,
            offBy,
          )
          if (result) currentPolyPairs.set(pairKey(ia, ib), [ia, ib])
        }
      }

      if (this.listens('polygon'))
        for (const [key, [a, b]] of currentPolyPairs) {
          if (!this.activePolygonPairs.has(key)) this.events?.emit('polygonEnter', { a, b })
          else this.events?.emit('polygonStay', { a, b })
          this.events?.emit('polygon', { a, b })
        }
      if (this.listens('polygon'))
        for (const [key, [a, b]] of this.activePolygonPairs) {
          if (!currentPolyPairs.has(key)) this.events?.emit('polygonExit', { a, b })
        }
      {
        const prev = this.activePolygonPairs
        this.activePolygonPairs = currentPolyPairs
        this._currentPolygonPairs = prev
      }
    } else if (this.activePolygonPairs.size > 0) {
      for (const [, [a, b]] of this.activePolygonPairs) this.events?.emit('polygonExit', { a, b })
      this.activePolygonPairs.clear()
    }
  }

  private listens(prefix: string): boolean {
    const ev = this.events
    return (
      ev !== undefined &&
      (ev.has(prefix) || ev.has(prefix + 'Enter') || ev.has(prefix + 'Stay') || ev.has(prefix + 'Exit'))
    )
  }

  // ── Pair pruning ────────────────────────────────────────────────────────

  private _anySleeping = false

  // Bodies resting on something that moved away or vanished must not float.
  private wakeSeparated(
    world: ECSWorld,
    prev: Map<number, [EntityId, EntityId]>,
    cur: Map<number, [EntityId, EntityId]>,
  ): void {
    prev.forEach((pair, key) => {
      if (cur.has(key)) return
      const ra = world.getComponent<RigidBodyComponent>(pair[0], 'RigidBody')
      const rb = world.getComponent<RigidBodyComponent>(pair[1], 'RigidBody')
      if (!ra || !rb) return
      // A pair can also vanish because sleeping bodies are skipped by pairing.
      const movedA = !ra.sleeping && !ra.isStatic && ra.sleepTimer === 0
      const movedB = !rb.sleeping && !rb.isStatic && rb.sleepTimer === 0
      if (movedA && rb.sleeping) this.wake(world, pair[1])
      if (movedB && ra.sleeping) this.wake(world, pair[0])
    })
  }

  private wake(world: ECSWorld, id: EntityId): void {
    const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')
    if (rb && rb.sleeping) {
      rb.sleeping = false
      rb.sleepTimer = 0
    }
  }

  private pruneDeadPairs(world: ECSWorld): void {
    for (const [key, [a, b]] of this.activeTriggerPairs) {
      if (!world.hasEntity(a) || !world.hasEntity(b)) {
        this.events?.emit('triggerExit', { a, b })
        this.activeTriggerPairs.delete(key)
      }
    }
    for (const [key, [a, b]] of this.activeCollisionPairs) {
      if (!world.hasEntity(a) || !world.hasEntity(b)) {
        this.wake(world, a)
        this.wake(world, b)
        this.events?.emit('collisionExit', { a, b })
        this.activeCollisionPairs.delete(key)
      }
    }
    for (const [key, [a, b]] of this.activeCirclePairs) {
      if (!world.hasEntity(a) || !world.hasEntity(b)) {
        this.events?.emit('circleExit', { a, b })
        this.activeCirclePairs.delete(key)
      }
    }
    for (const [key, [a, b]] of this.activeCompoundPairs) {
      if (!world.hasEntity(a) || !world.hasEntity(b)) {
        this.events?.emit('compoundExit', { a, b })
        this.activeCompoundPairs.delete(key)
      }
    }
    for (const [key, [a, b]] of this.activeCapsulePairs) {
      if (!world.hasEntity(a) || !world.hasEntity(b)) {
        this.events?.emit('capsuleExit', { a, b })
        this.activeCapsulePairs.delete(key)
      }
    }
    for (const [key, [a, b]] of this.activePolygonPairs) {
      if (!world.hasEntity(a) || !world.hasEntity(b)) {
        this.events?.emit('polygonExit', { a, b })
        this.activePolygonPairs.delete(key)
      }
    }
  }
}
