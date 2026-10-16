// Throwaway scout repros (NOT committed).
import { describe, it, expect } from 'vitest'
import { ECSWorld, EventBus, createTransform } from '@xip/core'
import { PhysicsSystem } from '../physicsSystem'
import { createRigidBody } from '../components/rigidbody'
import { createCircleCollider } from '../components/circleCollider'
import { createTriMeshCollider } from '../components/triMeshCollider'

const FLOOR = [
  { x: -200, y: 0 },
  { x: 200, y: 0 },
  { x: 200, y: 20 },
  { x: -200, y: 20 },
]
const TRIS = [0, 1, 2, 0, 2, 3]

function stepN(system: PhysicsSystem, world: ECSWorld, n: number) {
  for (let i = 0; i < n; i++) system.update(world, 1 / 60)
}

describe('scout XB physics repros', () => {
  it('XB-h a TriMesh that moves keeps colliding at its first-step position', () => {
    const world = new ECSWorld()
    const physics = new PhysicsSystem(500, new EventBus())
    const mesh = world.createEntity()
    world.addComponent(mesh, createTransform(0, 200))
    world.addComponent(mesh, createRigidBody({ isStatic: true }))
    world.addComponent(mesh, createTriMeshCollider(FLOOR, TRIS))
    stepN(physics, world, 1) // BVH is built here, at x=0

    // Move the platform (e.g. a kinematic/static mover) to x=1000.
    ;(world.getComponent(mesh, 'Transform') as any).x = 1000

    const circle = world.createEntity()
    world.addComponent(circle, createTransform(1000, 170))
    world.addComponent(circle, createRigidBody())
    world.addComponent(circle, createCircleCollider(10))
    stepN(physics, world, 120)

    const t = world.getComponent(circle, 'Transform') as any
    expect(t.y).toBeGreaterThan(180)
    expect(t.y).toBeLessThan(220)
  })

  it('XB-i physics still reads the right columns after restoreSnapshot (undo/rollback)', () => {
    const world = new ECSWorld()
    const physics = new PhysicsSystem(500, new EventBus())
    const mesh = world.createEntity()
    world.addComponent(mesh, createTransform(0, 200))
    world.addComponent(mesh, createRigidBody({ isStatic: true }))
    world.addComponent(mesh, createTriMeshCollider(FLOOR, TRIS))
    stepN(physics, world, 1) // physics caches numeric column ids (CircleCollider not yet interned)

    world.restoreSnapshot(new ECSWorld().getSnapshot()) // undo to an empty level

    // Rebuild the same level in the same order: physics must still work.
    const m2 = world.createEntity()
    world.addComponent(m2, createTransform(0, 200))
    world.addComponent(m2, createRigidBody({ isStatic: true }))
    world.addComponent(m2, createTriMeshCollider(FLOOR, TRIS))
    const circle = world.createEntity()
    world.addComponent(circle, createTransform(0, 50))
    world.addComponent(circle, createRigidBody())
    world.addComponent(circle, createCircleCollider(10))
    stepN(physics, world, 240)

    const t = world.getComponent(circle, 'Transform') as any
    expect(t.y).toBeGreaterThan(180)
    expect(t.y).toBeLessThan(220)
  })

  it('XB-j a TriMesh created after an id is recycled (restore) uses its own geometry', () => {
    const world = new ECSWorld()
    const physics = new PhysicsSystem(500, new EventBus())
    const mesh = world.createEntity() // id 0
    world.addComponent(mesh, createTransform(0, 200))
    world.addComponent(mesh, createRigidBody({ isStatic: true }))
    world.addComponent(mesh, createTriMeshCollider(FLOOR, TRIS))
    const c0 = world.createEntity() // id 1, keeps the column order identical below
    world.addComponent(c0, createTransform(0, 50))
    world.addComponent(c0, createRigidBody())
    world.addComponent(c0, createCircleCollider(10))
    stepN(physics, world, 1) // cache BVH under id 0 (floor top at y=200)

    world.restoreSnapshot(new ECSWorld().getSnapshot()) // id 0 is handed out again

    // New level: a lower floor whose top is at y=100.
    const lowFloor = FLOOR.map((v) => ({ x: v.x, y: v.y - 100 }))
    const mesh2 = world.createEntity()
    expect(mesh2).toBe(mesh)
    world.addComponent(mesh2, createTransform(0, 200))
    world.addComponent(mesh2, createRigidBody({ isStatic: true }))
    world.addComponent(mesh2, createTriMeshCollider(lowFloor, TRIS))
    const circle = world.createEntity()
    world.addComponent(circle, createTransform(0, 50))
    world.addComponent(circle, createRigidBody())
    world.addComponent(circle, createCircleCollider(10))
    stepN(physics, world, 240)

    const t = world.getComponent(circle, 'Transform') as any
    // Must rest on the new floor (top y=100, circle centre ~90), not the old one (~190).
    expect(t.y).toBeLessThan(120)
  })

  it('rebuilds a cached BVH when mesh vertices are reshaped in place', () => {
    const world = new ECSWorld()
    const physics = new PhysicsSystem(500, new EventBus())
    const mesh = world.createEntity()
    world.addComponent(mesh, createTransform(0, 200))
    world.addComponent(mesh, createRigidBody({ isStatic: true }))
    const collider = createTriMeshCollider(FLOOR, TRIS)
    world.addComponent(mesh, collider)
    stepN(physics, world, 1) // Cache the original floor geometry.

    for (const vertex of collider.vertices) vertex.y -= 100

    const circle = world.createEntity()
    world.addComponent(circle, createTransform(0, 50))
    world.addComponent(circle, createRigidBody())
    world.addComponent(circle, createCircleCollider(10))
    stepN(physics, world, 240)

    const t = world.getComponent(circle, 'Transform') as any
    expect(t.y).toBeLessThan(120)
  })
})
