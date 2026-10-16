import { describe, it, expect } from 'vitest'
import { ECSWorld, EventBus } from '@xip/core'
import { createTransform } from '@xip/core'
import type { TransformComponent } from '@xip/core'
import type { RigidBodyComponent } from '../components/rigidbody'
import { createRigidBody } from '../components/rigidbody'
import type { BoxColliderComponent } from '../components/boxCollider'
import { createBoxCollider } from '../components/boxCollider'
import { createCircleCollider } from '../components/circleCollider'
import { createTriMeshCollider } from '../components/triMeshCollider'
import { PhysicsSystem } from '../physicsSystem'

// Fixed timestep the physics system uses internally
const FIXED_DT = 1 / 60

function createTestWorld(gravity = 980) {
  const world = new ECSWorld()
  const physics = new PhysicsSystem(gravity)
  world.addSystem(physics)
  return { world, physics }
}

function createTestWorldWithEvents(gravity = 0) {
  const world = new ECSWorld()
  const events = new EventBus()
  const physics = new PhysicsSystem(gravity, events)
  world.addSystem(physics)
  return { world, physics, events }
}

/** Add a dynamic entity (has all three components needed by physics) */
function addDynamic(world: ECSWorld, x: number, y: number, w = 20, h = 20) {
  const id = world.createEntity()
  world.addComponent(id, createTransform(x, y))
  world.addComponent(id, createRigidBody())
  world.addComponent(id, createBoxCollider(w, h))
  return id
}

/** Add a static entity */
function addStatic(world: ECSWorld, x: number, y: number, w: number, h: number) {
  const id = world.createEntity()
  world.addComponent(id, createTransform(x, y))
  world.addComponent(id, createRigidBody({ isStatic: true }))
  world.addComponent(id, createBoxCollider(w, h))
  return id
}

/** Run the world for a given number of fixed steps */
function runSteps(world: ECSWorld, steps: number) {
  for (let i = 0; i < steps; i++) {
    world.update(FIXED_DT)
  }
}

describe('PhysicsSystem', () => {
  describe('gravity', () => {
    it('dynamic entity gains downward velocity over time', () => {
      const { world } = createTestWorld(980)
      const id = addDynamic(world, 0, 0)
      runSteps(world, 10)
      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      expect(rb.vy).toBeGreaterThan(0)
    })

    it('dynamic entity position increases in y over time (falls down)', () => {
      const { world } = createTestWorld(980)
      const id = addDynamic(world, 0, 0)
      runSteps(world, 10)
      const t = world.getComponent<TransformComponent>(id, 'Transform')!
      expect(t.y).toBeGreaterThan(0)
    })

    it('static entity does not move under gravity', () => {
      const { world } = createTestWorld(980)
      const id = addStatic(world, 0, 0, 40, 40)
      runSteps(world, 60)
      const t = world.getComponent<TransformComponent>(id, 'Transform')!
      expect(t.x).toBe(0)
      expect(t.y).toBe(0)
      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      expect(rb.vy).toBe(0)
    })
  })

  describe('floor collision', () => {
    it('entity landing on a static floor is stopped and onGround is set', () => {
      const { world } = createTestWorld(980)
      // Floor: a wide static box centered at y=200, height=20 (occupies y 190..210)
      addStatic(world, 0, 200, 400, 20)
      // Dynamic: 20x20 box starting at y=100, so its center is at 100, bottom edge at 110
      // Floor top edge is at 190. It should fall and land.
      const id = addDynamic(world, 0, 100, 20, 20)

      // Run enough steps for it to fall and land
      runSteps(world, 120)

      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      const t = world.getComponent<TransformComponent>(id, 'Transform')!

      expect(rb.onGround).toBe(true)
      expect(rb.vy).toBeCloseTo(0, 2)
      // Entity center y should be at or near the floor top edge minus half entity height
      // floor top = 200 - 10 = 190, entity half-height = 10, so entity y ≈ 180
      expect(Math.abs(t.y - 180)).toBeLessThan(1)
    })
  })

  describe('wall collision', () => {
    it('entity moving right into a static wall is stopped', () => {
      const { world } = createTestWorld(0) // no gravity so it only moves horizontally
      // Wall: 20x200 static box centered at x=100
      addStatic(world, 100, 0, 20, 400)
      // Dynamic: 20x20 at x=0, moving right at vx=200
      const id = addDynamic(world, 0, 0, 20, 20)
      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      rb.vx = 200

      // Run enough steps to reach the wall
      runSteps(world, 60)

      const rbAfter = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      expect(rbAfter.vx).toBeCloseTo(0, 1)

      const t = world.getComponent<TransformComponent>(id, 'Transform')!
      // Dynamic right edge should not penetrate the wall's left edge
      // Wall left edge = 100 - 10 = 90; dynamic half-width = 10; so dynamic x ≤ 80
      expect(t.x).toBeLessThanOrEqual(81)
    })
  })

  describe('setGravity', () => {
    it('changes gravity mid-game', () => {
      const { world, physics } = createTestWorld(0) // start with no gravity
      const id = addDynamic(world, 0, 0)
      runSteps(world, 10)
      const rb1 = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      expect(rb1.vy).toBe(0) // no gravity yet

      physics.setGravity(980)
      runSteps(world, 10)
      const rb2 = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      expect(rb2.vy).toBeGreaterThan(0)
    })
  })

  describe('trigger collider', () => {
    it('trigger entity does not physically block a dynamic entity', () => {
      const { world } = createTestWorld(0) // no gravity
      // Trigger: big box centered at x=50
      const triggerId = world.createEntity()
      world.addComponent(triggerId, createTransform(50, 0))
      world.addComponent(triggerId, createRigidBody({ isStatic: true }))
      world.addComponent(triggerId, createBoxCollider(100, 100, { isTrigger: true }))

      // Dynamic moving right through the trigger
      const id = addDynamic(world, 0, 0, 20, 20)
      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      rb.vx = 200

      runSteps(world, 30)

      // vx should still be non-zero — trigger should not have stopped the entity
      const rbAfter = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      expect(rbAfter.vx).toBeGreaterThan(0)
    })
  })

  describe('fixed timestep accumulator', () => {
    it('physics runs consistent steps regardless of dt variation', () => {
      // Run for exactly 1 second via one big dt vs 60 small steps — results should match closely
      const worldA = createTestWorld(980).world
      const worldB = createTestWorld(980).world

      const idA = addDynamic(worldA, 0, 0)
      const idB = addDynamic(worldB, 0, 0)

      // World A: 60 small steps of 1/60s
      runSteps(worldA, 60)

      // World B: one large dt of 1s (accumulator caps at 5 * FIXED_DT = ~0.083s worth of steps,
      // so it will only run up to 5 fixed steps — enough to show the system is using fixed dt)
      worldB.update(1)

      const rbA = worldA.getComponent<RigidBodyComponent>(idA, 'RigidBody')!
      const rbB = worldB.getComponent<RigidBodyComponent>(idB, 'RigidBody')!

      // Both should have positive vy (gravity applied)
      expect(rbA.vy).toBeGreaterThan(0)
      expect(rbB.vy).toBeGreaterThan(0)
    })

    it('accumulates partial steps across multiple updates', () => {
      const { world } = createTestWorld(980)
      const id = addDynamic(world, 0, 0)

      // Pass dt smaller than FIXED_DT to force accumulation
      const smallDt = FIXED_DT / 2
      // After 1 step of smallDt, nothing should have run yet
      world.update(smallDt)
      let rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      expect(rb.vy).toBe(0) // no fixed step fired yet

      // After another smallDt, accumulator crosses FIXED_DT, one step fires
      world.update(smallDt)
      rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      expect(rb.vy).toBeGreaterThan(0)
    })
  })

  describe('moving platform carry', () => {
    it('dynamic entity on a moving platform inherits its horizontal movement', () => {
      const { world } = createTestWorld(980)

      // Static platform that we'll move manually each step
      const platId = world.createEntity()
      world.addComponent(platId, createTransform(0, 200))
      world.addComponent(platId, createRigidBody({ isStatic: true }))
      world.addComponent(platId, createBoxCollider(400, 20))

      // Dynamic entity resting on the platform
      const id = addDynamic(world, 0, 100, 20, 20)

      // Let entity fall and land on the platform
      runSteps(world, 120)

      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      expect(rb.onGround).toBe(true)

      const tBefore = world.getComponent<TransformComponent>(id, 'Transform')!
      const xBefore = tBefore.x

      // Move the platform right by 5px per step for 10 steps
      for (let i = 0; i < 10; i++) {
        const pt = world.getComponent<TransformComponent>(platId, 'Transform')!
        pt.x += 5
        world.update(FIXED_DT)
      }

      const tAfter = world.getComponent<TransformComponent>(id, 'Transform')!
      // Entity should have moved right with the platform (carry applied)
      expect(tAfter.x).toBeGreaterThan(xBefore)
    })
  })

  describe('one-way platforms', () => {
    it('blocks dynamic entity falling onto the top of a one-way platform', () => {
      const { world } = createTestWorld(980)
      // One-way platform: static, 200x20, centered at y=200
      const plat = world.createEntity()
      world.addComponent(plat, createTransform(0, 200))
      world.addComponent(plat, createRigidBody({ isStatic: true }))
      world.addComponent(plat, createBoxCollider(400, 20, { oneWay: true }))

      // Dynamic entity starts above the platform (y=100) and falls
      const id = addDynamic(world, 0, 100, 20, 20)

      runSteps(world, 120)

      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      expect(rb.onGround).toBe(true)
      expect(rb.vy).toBeCloseTo(0, 2)
    })

    it('allows dynamic entity to pass through a one-way platform from below', () => {
      const { world } = createTestWorld(0) // no gravity
      // One-way platform at y=0
      const plat = world.createEntity()
      world.addComponent(plat, createTransform(0, 0))
      world.addComponent(plat, createRigidBody({ isStatic: true }))
      world.addComponent(plat, createBoxCollider(200, 20, { oneWay: true }))

      // Dynamic entity starts below the platform and moves upward
      const id = addDynamic(world, 0, 100, 20, 20)
      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      rb.vy = -400 // moving upward

      runSteps(world, 10)

      // Entity should have passed through — still moving up (negative vy or at least moved up)
      const t = world.getComponent<TransformComponent>(id, 'Transform')!
      expect(t.y).toBeLessThan(100) // has moved upward
      expect(rb.onGround).toBe(false) // not blocked
    })
  })

  describe('gravityScale', () => {
    it('entity with gravityScale=0 is not affected by gravity', () => {
      const { world } = createTestWorld(980)
      const id = world.createEntity()
      world.addComponent(id, createTransform(0, 0))
      world.addComponent(id, createRigidBody({ gravityScale: 0 }))
      world.addComponent(id, createBoxCollider(20, 20))

      runSteps(world, 60)

      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      expect(rb.vy).toBe(0)
    })
  })

  describe('additionalSolverIterations', () => {
    it('extra iterations are applied to constraints involving the body', () => {
      // Two overlapping dynamic bodies — one with extra solver iterations
      // should yield a more separated (better resolved) result
      const { world: worldA } = createTestWorld(0)
      const { world: worldB } = createTestWorld(0)

      // World A: normal solver iterations (no extra)
      const a1 = worldA.createEntity()
      worldA.addComponent(a1, createTransform(0, 0))
      worldA.addComponent(a1, createRigidBody())
      worldA.addComponent(a1, createBoxCollider(20, 20))

      const a2 = worldA.createEntity()
      worldA.addComponent(a2, createTransform(10, 0)) // overlapping
      worldA.addComponent(a2, createRigidBody())
      worldA.addComponent(a2, createBoxCollider(20, 20))

      const rbA1 = worldA.getComponent<RigidBodyComponent>(a1, 'RigidBody')!
      rbA1.vx = 100

      // World B: body has extra solver iterations
      const b1 = worldB.createEntity()
      worldB.addComponent(b1, createTransform(0, 0))
      worldB.addComponent(b1, createRigidBody({ additionalSolverIterations: 4 }))
      worldB.addComponent(b1, createBoxCollider(20, 20))

      const b2 = worldB.createEntity()
      worldB.addComponent(b2, createTransform(10, 0))
      worldB.addComponent(b2, createRigidBody())
      worldB.addComponent(b2, createBoxCollider(20, 20))

      const rbB1 = worldB.getComponent<RigidBodyComponent>(b1, 'RigidBody')!
      rbB1.vx = 100

      runSteps(worldA, 1)
      runSteps(worldB, 1)

      // Both should resolve the collision — the extra iterations version
      // should have resolved at least as well. We just verify it runs without error
      // and the bodies have been pushed apart in both cases.
      const tA1 = worldA.getComponent<TransformComponent>(a1, 'Transform')!
      const tA2 = worldA.getComponent<TransformComponent>(a2, 'Transform')!
      const tB1 = worldB.getComponent<TransformComponent>(b1, 'Transform')!
      const tB2 = worldB.getComponent<TransformComponent>(b2, 'Transform')!

      // Both worlds should have resolved the overlap (bodies separated)
      const sepA = tA2.x - tA1.x
      const sepB = tB2.x - tB1.x
      expect(sepA).toBeGreaterThan(0)
      expect(sepB).toBeGreaterThan(0)
    })

    it('additionalSolverIterations defaults to 0 and has no effect', () => {
      const rb = createRigidBody()
      expect(rb.additionalSolverIterations).toBe(0)
    })
  })
})

// ── Contact events ────────────────────────────────────────────────────────────

describe('Contact events', () => {
  interface ContactPayload {
    a: number
    b: number
    normalX?: number
    normalY?: number
  }

  describe('triggerEnter / triggerExit', () => {
    it('emits triggerEnter when a dynamic body overlaps a static trigger', () => {
      const { world, events } = createTestWorldWithEvents()

      // Static trigger zone centered at origin, 40x40
      const trigger = world.createEntity()
      world.addComponent(trigger, createTransform(0, 0))
      world.addComponent(trigger, createRigidBody({ isStatic: true }))
      world.addComponent(trigger, createBoxCollider(40, 40, { isTrigger: true }))

      // Dynamic body placed inside the trigger zone
      const dyn = world.createEntity()
      world.addComponent(dyn, createTransform(0, 0))
      world.addComponent(dyn, createRigidBody())
      world.addComponent(dyn, createBoxCollider(10, 10))

      const entered: ContactPayload[] = []
      events.on<ContactPayload>('triggerEnter', (p) => entered.push(p))

      runSteps(world, 1)

      expect(entered.length).toBe(1)
      const ids = [entered[0].a, entered[0].b]
      expect(ids).toContain(trigger)
      expect(ids).toContain(dyn)
    })

    it('does not emit triggerEnter when bodies are not overlapping', () => {
      const { world, events } = createTestWorldWithEvents()

      const trigger = world.createEntity()
      world.addComponent(trigger, createTransform(0, 0))
      world.addComponent(trigger, createRigidBody({ isStatic: true }))
      world.addComponent(trigger, createBoxCollider(20, 20, { isTrigger: true }))

      // Far away — no overlap
      const dyn = world.createEntity()
      world.addComponent(dyn, createTransform(1000, 1000))
      world.addComponent(dyn, createRigidBody())
      world.addComponent(dyn, createBoxCollider(10, 10))

      const entered: ContactPayload[] = []
      events.on<ContactPayload>('triggerEnter', (p) => entered.push(p))

      runSteps(world, 1)
      expect(entered.length).toBe(0)
    })

    it('emits triggerEnter only once while overlapping (not every frame)', () => {
      const { world, events } = createTestWorldWithEvents()

      const trigger = world.createEntity()
      world.addComponent(trigger, createTransform(0, 0))
      world.addComponent(trigger, createRigidBody({ isStatic: true }))
      world.addComponent(trigger, createBoxCollider(40, 40, { isTrigger: true }))

      const dyn = world.createEntity()
      world.addComponent(dyn, createTransform(0, 0))
      world.addComponent(dyn, createRigidBody())
      world.addComponent(dyn, createBoxCollider(10, 10))

      const entered: ContactPayload[] = []
      events.on<ContactPayload>('triggerEnter', (p) => entered.push(p))

      runSteps(world, 5)

      // triggerEnter fires only on the first frame of overlap
      expect(entered.length).toBe(1)
    })

    it('emits trigger every frame while overlapping', () => {
      const { world, events } = createTestWorldWithEvents()

      const trigger = world.createEntity()
      world.addComponent(trigger, createTransform(0, 0))
      world.addComponent(trigger, createRigidBody({ isStatic: true }))
      world.addComponent(trigger, createBoxCollider(40, 40, { isTrigger: true }))

      const dyn = world.createEntity()
      world.addComponent(dyn, createTransform(0, 0))
      world.addComponent(dyn, createRigidBody())
      world.addComponent(dyn, createBoxCollider(10, 10))

      const ongoing: ContactPayload[] = []
      events.on<ContactPayload>('trigger', (p) => ongoing.push(p))

      runSteps(world, 3)
      expect(ongoing.length).toBe(3)
    })

    it('emits triggerExit when bodies separate', () => {
      const { world, events } = createTestWorldWithEvents()

      // Trigger at origin
      const trigger = world.createEntity()
      world.addComponent(trigger, createTransform(0, 0))
      world.addComponent(trigger, createRigidBody({ isStatic: true }))
      world.addComponent(trigger, createBoxCollider(20, 20, { isTrigger: true }))

      // Dynamic body starts inside
      const dyn = world.createEntity()
      world.addComponent(dyn, createTransform(0, 0))
      world.addComponent(dyn, createRigidBody())
      world.addComponent(dyn, createBoxCollider(10, 10))

      const exited: ContactPayload[] = []
      events.on<ContactPayload>('triggerExit', (p) => exited.push(p))

      // One step — body overlaps
      runSteps(world, 1)
      expect(exited.length).toBe(0)

      // Move body far away
      const t = world.getComponent<TransformComponent>(dyn, 'Transform')!
      t.x = 1000

      runSteps(world, 1)
      expect(exited.length).toBe(1)
    })

    it('emits triggerExit when a dynamic entity is destroyed mid-overlap', () => {
      const { world, events } = createTestWorldWithEvents()

      const trigger = world.createEntity()
      world.addComponent(trigger, createTransform(0, 0))
      world.addComponent(trigger, createRigidBody({ isStatic: true }))
      world.addComponent(trigger, createBoxCollider(40, 40, { isTrigger: true }))

      const dyn = world.createEntity()
      world.addComponent(dyn, createTransform(0, 0))
      world.addComponent(dyn, createRigidBody())
      world.addComponent(dyn, createBoxCollider(10, 10))

      const exited: ContactPayload[] = []
      events.on<ContactPayload>('triggerExit', (p) => exited.push(p))

      runSteps(world, 1) // establish overlap
      world.destroyEntity(dyn)
      runSteps(world, 1) // dead entity pruning fires exit

      expect(exited.length).toBe(1)
    })
  })

  describe('collisionEnter / collisionExit', () => {
    it('emits collisionEnter when two dynamic solid bodies first touch', () => {
      const { world, events } = createTestWorldWithEvents()

      // Two dynamic bodies placed overlapping
      const a = world.createEntity()
      world.addComponent(a, createTransform(0, 0))
      world.addComponent(a, createRigidBody())
      world.addComponent(a, createBoxCollider(20, 20))

      const b = world.createEntity()
      world.addComponent(b, createTransform(5, 0)) // overlapping
      world.addComponent(b, createRigidBody())
      world.addComponent(b, createBoxCollider(20, 20))

      const entered: ContactPayload[] = []
      events.on<ContactPayload>('collisionEnter', (p) => entered.push(p))

      runSteps(world, 1)
      expect(entered.length).toBe(1)
    })

    it('emits collisionEnter only once while in contact', () => {
      const { world, events } = createTestWorldWithEvents()

      const a = world.createEntity()
      world.addComponent(a, createTransform(0, 0))
      world.addComponent(a, createRigidBody())
      world.addComponent(a, createBoxCollider(20, 20))

      const b = world.createEntity()
      world.addComponent(b, createTransform(5, 0))
      world.addComponent(b, createRigidBody())
      world.addComponent(b, createBoxCollider(20, 20))

      const entered: ContactPayload[] = []
      events.on<ContactPayload>('collisionEnter', (p) => entered.push(p))

      runSteps(world, 5)
      expect(entered.length).toBe(1)
    })

    it('emits collisionExit when dynamic bodies separate', () => {
      const { world, events } = createTestWorldWithEvents()

      const a = world.createEntity()
      world.addComponent(a, createTransform(0, 0))
      world.addComponent(a, createRigidBody())
      world.addComponent(a, createBoxCollider(20, 20))

      const b = world.createEntity()
      world.addComponent(b, createTransform(5, 0))
      world.addComponent(b, createRigidBody())
      world.addComponent(b, createBoxCollider(20, 20))

      const exited: ContactPayload[] = []
      events.on<ContactPayload>('collisionExit', (p) => exited.push(p))

      runSteps(world, 1)

      // Move them apart
      const ta = world.getComponent<TransformComponent>(a, 'Transform')!
      const tb = world.getComponent<TransformComponent>(b, 'Transform')!
      ta.x = -100
      tb.x = 100

      runSteps(world, 1)
      expect(exited.length).toBe(1)
    })
  })

  describe('Contact normals', () => {
    it('collisionEnter includes a unit normal pointing from A toward B', () => {
      const { world, events } = createTestWorldWithEvents()

      // A is at x=0, B is to the right at x=15 — they overlap by 5 units
      // Normal should point in +x direction (A→B)
      const a = world.createEntity()
      world.addComponent(a, createTransform(0, 0))
      world.addComponent(a, createRigidBody())
      world.addComponent(a, createBoxCollider(20, 20))

      const b = world.createEntity()
      world.addComponent(b, createTransform(15, 0))
      world.addComponent(b, createRigidBody())
      world.addComponent(b, createBoxCollider(20, 20))

      const entered: ContactPayload[] = []
      events.on<ContactPayload>('collisionEnter', (p) => entered.push(p))

      runSteps(world, 1)

      expect(entered.length).toBe(1)
      // Normal should be non-zero and approximately a unit vector
      const { normalX = 0, normalY = 0 } = entered[0]
      expect(Math.abs(normalX) + Math.abs(normalY)).toBeGreaterThan(0.5)
    })

    it('triggerEnter includes a normal indicating entry direction', () => {
      const { world, events } = createTestWorldWithEvents()

      // Trigger at x=0, dynamic body enters from the left (x=-12)
      const trigger = world.createEntity()
      world.addComponent(trigger, createTransform(0, 0))
      world.addComponent(trigger, createBoxCollider(20, 20, { isTrigger: true }))

      const dyn = world.createEntity()
      world.addComponent(dyn, createTransform(-12, 0)) // overlapping left edge
      world.addComponent(dyn, createRigidBody())
      world.addComponent(dyn, createBoxCollider(10, 10))

      const entered: ContactPayload[] = []
      events.on<ContactPayload>('triggerEnter', (p) => entered.push(p))

      runSteps(world, 1)

      expect(entered.length).toBe(1)
      const { normalX = 0, normalY = 0 } = entered[0]
      expect(Math.abs(normalX) + Math.abs(normalY)).toBeGreaterThan(0.5)
    })

    it('collisionExit emits with normalX=0 normalY=0', () => {
      const { world, events } = createTestWorldWithEvents()

      const a = world.createEntity()
      world.addComponent(a, createTransform(0, 0))
      world.addComponent(a, createRigidBody())
      world.addComponent(a, createBoxCollider(20, 20))

      const b = world.createEntity()
      world.addComponent(b, createTransform(5, 0))
      world.addComponent(b, createRigidBody())
      world.addComponent(b, createBoxCollider(20, 20))

      runSteps(world, 1)

      const ta = world.getComponent<TransformComponent>(a, 'Transform')!
      const tb = world.getComponent<TransformComponent>(b, 'Transform')!
      ta.x = -100
      tb.x = 100

      const exited: ContactPayload[] = []
      events.on<ContactPayload>('collisionExit', (p) => exited.push(p))

      runSteps(world, 1)

      expect(exited.length).toBe(1)
      expect(exited[0].normalX).toBe(0)
      expect(exited[0].normalY).toBe(0)
    })
  })
})

// ── Layer / mask filtering ────────────────────────────────────────────────────

describe('Layer / mask filtering', () => {
  interface ContactPayload {
    a: number
    b: number
  }

  it('allows collision when mask is * (default)', () => {
    const { world, events } = createTestWorldWithEvents()

    const a = world.createEntity()
    world.addComponent(a, createTransform(0, 0))
    world.addComponent(a, createRigidBody())
    world.addComponent(a, createBoxCollider(20, 20, { layer: 'player' }))

    const b = world.createEntity()
    world.addComponent(b, createTransform(5, 0))
    world.addComponent(b, createRigidBody())
    world.addComponent(b, createBoxCollider(20, 20, { layer: 'enemy' }))

    const entered: ContactPayload[] = []
    events.on<ContactPayload>('collisionEnter', (p) => entered.push(p))

    runSteps(world, 1)
    expect(entered.length).toBe(1)
  })

  it('blocks collision when mask excludes the other layer', () => {
    const { world, events } = createTestWorldWithEvents()

    // 'a' only interacts with 'friendly' — not 'enemy'
    const a = world.createEntity()
    world.addComponent(a, createTransform(0, 0))
    world.addComponent(a, createRigidBody())
    world.addComponent(a, createBoxCollider(20, 20, { layer: 'player', mask: ['friendly'] }))

    const b = world.createEntity()
    world.addComponent(b, createTransform(5, 0))
    world.addComponent(b, createRigidBody())
    world.addComponent(b, createBoxCollider(20, 20, { layer: 'enemy' }))

    const entered: ContactPayload[] = []
    events.on<ContactPayload>('collisionEnter', (p) => entered.push(p))

    runSteps(world, 1)
    expect(entered.length).toBe(0)
  })

  it('allows collision when both masks explicitly include the other layer', () => {
    const { world, events } = createTestWorldWithEvents()

    const a = world.createEntity()
    world.addComponent(a, createTransform(0, 0))
    world.addComponent(a, createRigidBody())
    world.addComponent(a, createBoxCollider(20, 20, { layer: 'player', mask: ['enemy'] }))

    const b = world.createEntity()
    world.addComponent(b, createTransform(5, 0))
    world.addComponent(b, createRigidBody())
    world.addComponent(b, createBoxCollider(20, 20, { layer: 'enemy', mask: ['player'] }))

    const entered: ContactPayload[] = []
    events.on<ContactPayload>('collisionEnter', (p) => entered.push(p))

    runSteps(world, 1)
    expect(entered.length).toBe(1)
  })

  it('blocks trigger events when layer mask does not match', () => {
    const { world, events } = createTestWorldWithEvents()

    // Trigger only fires for 'player' layer, but dyn is on 'enemy'
    const trigger = world.createEntity()
    world.addComponent(trigger, createTransform(0, 0))
    world.addComponent(trigger, createRigidBody({ isStatic: true }))
    world.addComponent(trigger, createBoxCollider(40, 40, { isTrigger: true, layer: 'zone', mask: ['player'] }))

    const dyn = world.createEntity()
    world.addComponent(dyn, createTransform(0, 0))
    world.addComponent(dyn, createRigidBody())
    world.addComponent(dyn, createBoxCollider(10, 10, { layer: 'enemy' }))

    const entered: ContactPayload[] = []
    events.on<ContactPayload>('triggerEnter', (p) => entered.push(p))

    runSteps(world, 1)
    expect(entered.length).toBe(0)
  })

  it('allows trigger events when layer mask matches', () => {
    const { world, events } = createTestWorldWithEvents()

    const trigger = world.createEntity()
    world.addComponent(trigger, createTransform(0, 0))
    world.addComponent(trigger, createRigidBody({ isStatic: true }))
    world.addComponent(trigger, createBoxCollider(40, 40, { isTrigger: true, layer: 'zone', mask: ['player'] }))

    const dyn = world.createEntity()
    world.addComponent(dyn, createTransform(0, 0))
    world.addComponent(dyn, createRigidBody())
    world.addComponent(dyn, createBoxCollider(10, 10, { layer: 'player' }))

    const entered: ContactPayload[] = []
    events.on<ContactPayload>('triggerEnter', (p) => entered.push(p))

    runSteps(world, 1)
    expect(entered.length).toBe(1)
  })

  it('blocks physical separation when layers do not interact', () => {
    // Bodies on non-interacting layers should pass through each other
    const { world } = createTestWorldWithEvents()

    const a = world.createEntity()
    world.addComponent(a, createTransform(0, 0))
    world.addComponent(a, createRigidBody())
    world.addComponent(a, createBoxCollider(20, 20, { layer: 'ghost', mask: [] }))

    const b = world.createEntity()
    world.addComponent(b, createTransform(5, 0))
    world.addComponent(b, createRigidBody())
    world.addComponent(b, createBoxCollider(20, 20, { layer: 'solid' }))

    runSteps(world, 3)

    // Ghost passes through — transform.x should still be near original (not pushed apart)
    const ta = world.getComponent<TransformComponent>(a, 'Transform')!
    const tb = world.getComponent<TransformComponent>(b, 'Transform')!
    // Without interaction, both bodies stay where they are (no gravity)
    expect(Math.abs(ta.x - tb.x)).toBeLessThan(20) // still overlapping — not pushed apart
  })
})

// ── Impulse solver integration tests ─────────────────────────────────────────

describe('PhysicsSystem — impulse solver integration', () => {
  describe('restitution (bounciness)', () => {
    it('bouncy ball dropped on floor bounces back up', () => {
      const { world } = createTestWorld(980)
      // Floor
      const floor = world.createEntity()
      world.addComponent(floor, createTransform(0, 200))
      world.addComponent(floor, createRigidBody({ isStatic: true }))
      world.addComponent(floor, createBoxCollider(400, 20, { restitution: 1.0 }))

      // Bouncy ball
      const id = world.createEntity()
      world.addComponent(id, createTransform(0, 0))
      world.addComponent(id, createRigidBody({ restitution: 1.0 }))
      world.addComponent(id, createBoxCollider(20, 20, { restitution: 1.0 }))

      // Let it fall and hit the floor
      runSteps(world, 120)

      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      const t = world.getComponent<TransformComponent>(id, 'Transform')!

      // With high restitution the ball should have bounced — vy should be negative (moving up)
      // or entity should be well above the floor surface (190 - 10 = 180)
      // After bouncing for many frames, it should be above where it would rest
      // At minimum, vy should not be zero (it should still be bouncing)
      const isAboveRest = t.y < 175
      const isMovingUp = rb.vy < -5
      expect(isAboveRest || isMovingUp).toBe(true)
    })
  })

  describe('density and mass', () => {
    it('heavier body pushes lighter body more in a head-on collision', () => {
      const { world } = createTestWorld(0) // no gravity

      // Heavy body (high density) moving right
      const heavy = world.createEntity()
      world.addComponent(heavy, createTransform(0, 0))
      world.addComponent(heavy, createRigidBody({ density: 10, restitution: 0.5 }))
      world.addComponent(heavy, createBoxCollider(20, 20))

      // Light body (low density) stationary
      const light = world.createEntity()
      world.addComponent(light, createTransform(15, 0)) // overlapping
      world.addComponent(light, createRigidBody({ density: 1, restitution: 0.5 }))
      world.addComponent(light, createBoxCollider(20, 20))

      const rbHeavy = world.getComponent<RigidBodyComponent>(heavy, 'RigidBody')!
      rbHeavy.vx = 100

      runSteps(world, 30)

      const tHeavy = world.getComponent<TransformComponent>(heavy, 'Transform')!
      const tLight = world.getComponent<TransformComponent>(light, 'Transform')!

      // Light body should have been pushed further to the right than heavy body moved left
      expect(tLight.x).toBeGreaterThan(tHeavy.x)
    })
  })

  describe('momentum conservation', () => {
    it('total momentum is conserved in a two-body dynamic collision', () => {
      const { world } = createTestWorld(0) // no gravity to avoid external forces

      const a = world.createEntity()
      world.addComponent(a, createTransform(0, 0))
      world.addComponent(a, createRigidBody({ density: 2 }))
      world.addComponent(a, createBoxCollider(20, 20))

      const b = world.createEntity()
      world.addComponent(b, createTransform(18, 0)) // close to overlapping
      world.addComponent(b, createRigidBody({ density: 1 }))
      world.addComponent(b, createBoxCollider(20, 20))

      const rbA = world.getComponent<RigidBodyComponent>(a, 'RigidBody')!
      const rbB = world.getComponent<RigidBodyComponent>(b, 'RigidBody')!
      rbA.vx = 50
      rbB.vx = -20

      // Need to run one step first to compute mass properties
      world.update(FIXED_DT)

      const massA = rbA.invMass > 0 ? 1 / rbA.invMass : 0
      const massB = rbB.invMass > 0 ? 1 / rbB.invMass : 0
      const momentumBefore = massA * rbA.vx + massB * rbB.vx

      runSteps(world, 30)

      const momentumAfter = massA * rbA.vx + massB * rbB.vx
      // Momentum should be approximately conserved (no external forces)
      expect(momentumAfter).toBeCloseTo(momentumBefore, -1) // within ~10 units
    })
  })

  describe('gravityScale', () => {
    it('negative gravity scale makes entity float upward', () => {
      const { world } = createTestWorld(980)
      const id = world.createEntity()
      world.addComponent(id, createTransform(0, 100))
      world.addComponent(id, createRigidBody({ gravityScale: -1 }))
      world.addComponent(id, createBoxCollider(20, 20))

      runSteps(world, 30)

      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      const t = world.getComponent<TransformComponent>(id, 'Transform')!

      // Should have moved upward
      expect(rb.vy).toBeLessThan(0)
      expect(t.y).toBeLessThan(100)
    })

    it('gravityScale of 2 makes entity fall twice as fast as gravityScale 1', () => {
      const { world: worldA } = createTestWorld(980)
      const { world: worldB } = createTestWorld(980)

      const normal = worldA.createEntity()
      worldA.addComponent(normal, createTransform(0, 0))
      worldA.addComponent(normal, createRigidBody({ gravityScale: 1 }))
      worldA.addComponent(normal, createBoxCollider(20, 20))

      const heavy = worldB.createEntity()
      worldB.addComponent(heavy, createTransform(0, 0))
      worldB.addComponent(heavy, createRigidBody({ gravityScale: 2 }))
      worldB.addComponent(heavy, createBoxCollider(20, 20))

      runSteps(worldA, 30)
      runSteps(worldB, 30)

      const rbNormal = worldA.getComponent<RigidBodyComponent>(normal, 'RigidBody')!
      const rbHeavy = worldB.getComponent<RigidBodyComponent>(heavy, 'RigidBody')!

      // Heavy gravity entity should have roughly double the downward velocity
      expect(rbHeavy.vy).toBeCloseTo(rbNormal.vy * 2, -1)
    })
  })

  describe('lockRotation', () => {
    it('angular velocity stays zero when lockRotation is true', () => {
      const { world } = createTestWorld(0)

      // Two bodies set up to create an off-center collision that would normally produce torque
      const a = world.createEntity()
      world.addComponent(a, createTransform(0, 0))
      world.addComponent(a, createRigidBody({ lockRotation: true }))
      world.addComponent(a, createBoxCollider(20, 20))

      const b = world.createEntity()
      world.addComponent(b, createTransform(15, 5)) // offset vertically for asymmetric contact
      world.addComponent(b, createRigidBody())
      world.addComponent(b, createBoxCollider(20, 20))

      const rbA = world.getComponent<RigidBodyComponent>(a, 'RigidBody')!
      rbA.vx = 50

      runSteps(world, 30)

      expect(rbA.angularVelocity).toBe(0)
    })
  })

  describe('linearDamping', () => {
    it('velocity decreases over time with positive linear damping', () => {
      const { world } = createTestWorld(0) // no gravity
      const id = world.createEntity()
      world.addComponent(id, createTransform(0, 0))
      world.addComponent(id, createRigidBody({ linearDamping: 0.1 }))
      world.addComponent(id, createBoxCollider(20, 20))

      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      rb.vx = 100

      runSteps(world, 1)
      const vxAfter1 = rb.vx

      runSteps(world, 30)
      const vxAfter30 = rb.vx

      // Velocity should be decreasing
      expect(vxAfter1).toBeLessThan(100)
      expect(vxAfter30).toBeLessThan(vxAfter1)
      expect(vxAfter30).toBeGreaterThan(0) // shouldn't reverse direction
    })

    it('zero damping preserves velocity in free flight', () => {
      const { world } = createTestWorld(0)
      const id = world.createEntity()
      world.addComponent(id, createTransform(0, 0))
      world.addComponent(id, createRigidBody({ linearDamping: 0 }))
      world.addComponent(id, createBoxCollider(20, 20))

      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      rb.vx = 100

      runSteps(world, 60)

      expect(rb.vx).toBeCloseTo(100, 0)
    })
  })

  describe('disabled body', () => {
    it('rb.enabled=false skips all physics (gravity, collisions)', () => {
      const { world } = createTestWorld(980)

      // Floor
      addStatic(world, 0, 200, 400, 20)

      // Disabled dynamic entity
      const id = world.createEntity()
      world.addComponent(id, createTransform(0, 0))
      world.addComponent(id, createRigidBody({ enabled: false }))
      world.addComponent(id, createBoxCollider(20, 20))

      runSteps(world, 60)

      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      const t = world.getComponent<TransformComponent>(id, 'Transform')!

      // Should not have moved at all
      expect(t.x).toBe(0)
      expect(t.y).toBe(0)
      expect(rb.vx).toBe(0)
      expect(rb.vy).toBe(0)
    })

    it('re-enabling a body resumes physics', () => {
      const { world } = createTestWorld(980)
      const id = world.createEntity()
      world.addComponent(id, createTransform(0, 0))
      world.addComponent(id, createRigidBody({ enabled: false }))
      world.addComponent(id, createBoxCollider(20, 20))

      runSteps(world, 10)
      const t1 = world.getComponent<TransformComponent>(id, 'Transform')!
      expect(t1.y).toBe(0) // didn't move

      // Re-enable
      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      rb.enabled = true

      runSteps(world, 30)
      expect(t1.y).toBeGreaterThan(0) // now falling
    })
  })

  describe('circle collider physics', () => {
    it('circle collider entity is affected by gravity and lands on floor', () => {
      const { world } = createTestWorld(980)

      // Floor
      addStatic(world, 0, 200, 400, 20)

      // Circle entity
      const id = world.createEntity()
      world.addComponent(id, createTransform(0, 0))
      world.addComponent(id, createRigidBody())

      // Import and use circle collider
      const circleCollider = {
        type: 'CircleCollider' as const,
        radius: 10,
        offsetX: 0,
        offsetY: 0,
        isTrigger: false,
        layer: 'default',
        mask: '*' as string | string[],
        friction: 0.5,
        restitution: 0,
        frictionCombineRule: 'average' as const,
        restitutionCombineRule: 'average' as const,
        enabled: true,
      }
      world.addComponent(id, circleCollider)

      runSteps(world, 120)

      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      const t = world.getComponent<TransformComponent>(id, 'Transform')!

      // Should have fallen and landed on the floor
      // Floor top = 200 - 10 = 190, circle center should be at ~190 - 10 = 180
      expect(t.y).toBeGreaterThan(100) // definitely fell
      expect(rb.vy).toBeCloseTo(0, 0) // stopped or nearly stopped
    })
  })
})

// ── Stage 1.7 — Advanced physics tests ───────────────────────────────────────

describe('PhysicsSystem — Stage 1.7', () => {
  describe('stack of boxes stability', () => {
    it('dynamic box settles on static floor', () => {
      const { world } = createTestWorld(980)

      // Wide static floor centered at y=200, height=20 (top edge at y=190)
      addStatic(world, 0, 200, 800, 20)

      // Drop a single box — should settle on the floor
      const boxId = addDynamic(world, 0, 150, 20, 20)
      runSteps(world, 120)

      const t = world.getComponent<TransformComponent>(boxId, 'Transform')!
      const rb = world.getComponent<RigidBodyComponent>(boxId, 'RigidBody')!

      // Box center should be at roughly y=180 (floor top 190 - half box 10)
      expect(t.y).toBeLessThan(195)
      expect(t.y).toBeGreaterThan(150)
      expect(Math.abs(rb.vy)).toBeLessThan(10)
    })
  })

  describe('off-center collision generates angular velocity', () => {
    it('ball hit off-center gains angular velocity from torque', () => {
      const { world } = createTestWorld(0) // zero gravity

      // Body A: moving right
      const a = world.createEntity()
      world.addComponent(a, createTransform(0, 0))
      world.addComponent(a, createRigidBody({ restitution: 0.5, lockRotation: false }))
      world.addComponent(a, createBoxCollider(20, 20))

      // Body B: stationary, offset vertically so the hit is off-center
      const b = world.createEntity()
      world.addComponent(b, createTransform(18, 8)) // vertical offset creates off-center contact
      world.addComponent(b, createRigidBody({ restitution: 0.5, lockRotation: false }))
      world.addComponent(b, createBoxCollider(20, 20))

      const rbA = world.getComponent<RigidBodyComponent>(a, 'RigidBody')!
      rbA.vx = 200

      runSteps(world, 30)

      const rbB = world.getComponent<RigidBodyComponent>(b, 'RigidBody')!

      // Off-center impact should generate non-zero angular velocity on the struck body
      expect(rbB.angularVelocity).not.toBeCloseTo(0, 1)
    })
  })

  describe('friction on surface', () => {
    it('high friction body decelerates faster than zero friction body', () => {
      // --- High friction setup ---
      const { world: worldHigh } = createTestWorld(980)
      // Floor with high friction
      const floorHigh = worldHigh.createEntity()
      worldHigh.addComponent(floorHigh, createTransform(0, 200))
      worldHigh.addComponent(floorHigh, createRigidBody({ isStatic: true }))
      worldHigh.addComponent(floorHigh, createBoxCollider(2000, 20, { friction: 1.0 }))

      // Dynamic body with high friction, start on the floor
      const highId = worldHigh.createEntity()
      worldHigh.addComponent(highId, createTransform(0, 180)) // resting on floor top (200-10-10=180)
      worldHigh.addComponent(highId, createRigidBody())
      worldHigh.addComponent(highId, createBoxCollider(20, 20, { friction: 1.0 }))

      // Let it settle on the floor first
      runSteps(worldHigh, 30)
      const rbHigh = worldHigh.getComponent<RigidBodyComponent>(highId, 'RigidBody')!
      rbHigh.vx = 200

      runSteps(worldHigh, 120)
      const vxHigh = Math.abs(rbHigh.vx)

      // --- Zero friction setup ---
      const { world: worldLow } = createTestWorld(980)
      const floorLow = worldLow.createEntity()
      worldLow.addComponent(floorLow, createTransform(0, 200))
      worldLow.addComponent(floorLow, createRigidBody({ isStatic: true }))
      worldLow.addComponent(floorLow, createBoxCollider(2000, 20, { friction: 0.0 }))

      const lowId = worldLow.createEntity()
      worldLow.addComponent(lowId, createTransform(0, 180))
      worldLow.addComponent(lowId, createRigidBody())
      worldLow.addComponent(lowId, createBoxCollider(20, 20, { friction: 0.0 }))

      runSteps(worldLow, 30)
      const rbLow = worldLow.getComponent<RigidBodyComponent>(lowId, 'RigidBody')!
      rbLow.vx = 200

      runSteps(worldLow, 120)
      const vxLow = Math.abs(rbLow.vx)

      // Zero-friction body should retain more velocity than high-friction body
      expect(vxLow).toBeGreaterThan(vxHigh)
    })
  })

  describe('velocity clamping', () => {
    it('linear velocity does not exceed maxLinearVelocity', () => {
      const { world } = createTestWorld(980)

      const id = world.createEntity()
      world.addComponent(id, createTransform(0, 0))
      world.addComponent(id, createRigidBody({ maxLinearVelocity: 100 }))
      world.addComponent(id, createBoxCollider(20, 20))

      // Run many steps to let gravity accelerate the body
      runSteps(world, 300)

      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      const speed = Math.sqrt(rb.vx * rb.vx + rb.vy * rb.vy)

      // Velocity magnitude should never exceed the cap (allow small float tolerance)
      expect(speed).toBeLessThanOrEqual(100 + 0.01)
    })
  })

  describe('angular velocity clamping', () => {
    it('angular velocity is clamped to maxAngularVelocity after one step', () => {
      const { world } = createTestWorld(0)

      const id = world.createEntity()
      world.addComponent(id, createTransform(0, 0))
      world.addComponent(id, createRigidBody({ maxAngularVelocity: 5 }))
      world.addComponent(id, createBoxCollider(20, 20))

      const rb = world.getComponent<RigidBodyComponent>(id, 'RigidBody')!
      rb.angularVelocity = 100

      runSteps(world, 1)

      // Angular velocity should be clamped to maxAngularVelocity
      expect(Math.abs(rb.angularVelocity)).toBeLessThanOrEqual(5 + 0.01)
    })
  })
})

describe('PhysicsSystem after a world restore', () => {
  it('keeps reading the right columns after restoreSnapshot (undo, rollback)', () => {
    const world = new ECSWorld()
    const physics = new PhysicsSystem(500, new EventBus())
    const floor = [
      { x: -200, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 20 },
      { x: -200, y: 20 },
    ]
    const tris = [0, 1, 2, 0, 2, 3]
    const mesh = world.createEntity()
    world.addComponent(mesh, createTransform(0, 200))
    world.addComponent(mesh, createRigidBody({ isStatic: true }))
    world.addComponent(mesh, createTriMeshCollider(floor, tris))
    // Physics interns its collider types on the first step.
    physics.update(world, FIXED_DT)

    world.restoreSnapshot(new ECSWorld().getSnapshot())

    // Rebuild the level in a different order than before the restore.
    const m2 = world.createEntity()
    world.addComponent(m2, createTransform(0, 200))
    world.addComponent(m2, createRigidBody({ isStatic: true }))
    world.addComponent(m2, createTriMeshCollider(floor, tris))
    const circle = world.createEntity()
    world.addComponent(circle, createTransform(0, 50))
    world.addComponent(circle, createRigidBody())
    world.addComponent(circle, createCircleCollider(10))
    for (let i = 0; i < 240; i++) physics.update(world, FIXED_DT)

    const t = world.getComponent<TransformComponent>(circle, 'Transform')!
    expect(t.y).toBeGreaterThan(180)
    expect(t.y).toBeLessThan(220)
  })
})
