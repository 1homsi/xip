// Per-frame simulation passes (camera follow/shake, animator, clip playback,
// squash/stretch, particle update, trail update) used by the Canvas2D render
// system. They mirror the passes in webglRenderSystem.ts, which still carries
// its own copy; the two should be unified once that file settles.

import type { ECSWorld, EntityId, TransformComponent } from '@xip/core'
import { clampCameraToBounds, type Camera2DComponent } from './components/camera2d'
import { hasPointOrSpriteFollow, resolveCameraFollowTarget, type CameraFollowPoint } from './cameraFollow'
import type { AnimationStateComponent } from './components/animationState'
import type { AnimatorComponent, AnimatorTransition } from './components/animator'
import type { SquashStretchComponent } from './components/squashStretch'
import type { ParticlePoolComponent, Particle } from './components/particle'
import type { SpriteComponent } from './components/sprite'
import type { TrailComponent } from './components/trail'
import type { AnimationClipDefinition } from './components/animationState'
import type { AnimatorCondition } from './components/animator'
import { parseCSSColor } from './colorParser'

interface RigidBodyShape {
  type: 'RigidBody'
  vx: number
  vy: number
}

/** Scratch follow target, reused every frame (no per-frame allocation). */
const followTarget: CameraFollowPoint = { x: 0, y: 0 }

export interface CameraFrame {
  x: number
  y: number
  zoom: number
  background: string
  shakeX: number
  shakeY: number
}

/** Follow, clamp, shake and pixel-snap the Camera2D entity; fills `out`. */
export function updateCamera(
  world: ECSWorld,
  entityIds: Map<string, EntityId>,
  dt: number,
  W: number,
  H: number,
  Wl: number,
  Hl: number,
  defaultBackground: string,
  out: CameraFrame,
): void {
  let camX = 0,
    camY = 0,
    zoom = 1
  let background = defaultBackground
  let shakeX = 0,
    shakeY = 0

  const camId = world.queryOne('Camera2D')
  if (camId !== undefined) {
    const cam = world.getComponent<Camera2DComponent>(camId, 'Camera2D')!
    background = cam.background

    // A NaN/Infinity camera (set by hand, or poisoned earlier) would stay NaN for good: reset it.
    if (!Number.isFinite(cam.x)) cam.x = 0
    if (!Number.isFinite(cam.y)) cam.y = 0
    if (!(cam.zoom > 0) || !Number.isFinite(cam.zoom)) cam.zoom = 1
    let hasTarget = false
    let tx = 0
    let ty = 0
    if (hasPointOrSpriteFollow(cam)) {
      // followPoint > followSprite > followEntity; a missing target holds the camera
      if (resolveCameraFollowTarget(cam, followTarget)) {
        hasTarget = true
        tx = followTarget.x
        ty = followTarget.y
      }
    } else if (cam.followEntityId) {
      const targetId = entityIds.get(cam.followEntityId)
      const t = targetId !== undefined ? world.getComponent<TransformComponent>(targetId, 'Transform') : undefined
      if (t) {
        hasTarget = true
        tx = t.x
        ty = t.y
      }
    }
    if (hasTarget) {
      tx += cam.followOffsetX ?? 0
      ty += cam.followOffsetY ?? 0
      // A non-finite target (blown-up transform, bad offset) holds the camera instead of poisoning it.
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) hasTarget = false
    }
    if (hasTarget) {
      if (cam.deadZone) {
        const halfW = cam.deadZone.w / 2
        const halfH = cam.deadZone.h / 2
        const dx = tx - cam.x,
          dy = ty - cam.y
        if (dx > halfW) cam.x = tx - halfW
        else if (dx < -halfW) cam.x = tx + halfW
        if (dy > halfH) cam.y = ty - halfH
        else if (dy < -halfH) cam.y = ty + halfH
      } else if (cam.smoothing > 0) {
        const distSq = (tx - cam.x) ** 2 + (ty - cam.y) ** 2
        // Snap instantly when target teleports (>400px jump)
        if (distSq > 160000) {
          cam.x = tx
          cam.y = ty
        } else {
          // Same response as a per-frame lerp at 60 fps, at any frame rate.
          const k = 1 - Math.pow(cam.smoothing, dt * 60)
          cam.x += (tx - cam.x) * k
          cam.y += (ty - cam.y) * k
        }
      } else {
        cam.x = tx
        cam.y = ty
      }
    }

    if (cam.bounds) clampCameraToBounds(cam, Wl / (2 * cam.zoom), Hl / (2 * cam.zoom))

    if (cam.shakeTimer > 0) {
      cam.shakeTimer -= dt
      if (cam.shakeTimer < 0) cam.shakeTimer = 0
      const progress = cam.shakeDuration > 0 ? cam.shakeTimer / cam.shakeDuration : 0
      shakeX = (world.rng() * 2 - 1) * cam.shakeIntensity * progress
      shakeY = (world.rng() * 2 - 1) * cam.shakeIntensity * progress
    }

    camX = cam.x
    camY = cam.y
    zoom = cam.zoom
    if (cam.pixelSnap) {
      // Whole device pixels so pixel art does not shimmer while panning.
      const s = zoom * (W / Wl)
      camX = (W / 2 - Math.round(W / 2 - camX * s)) / s
      camY = (H / 2 - Math.round(H / 2 - camY * s)) / s
      const dpr = W / Wl
      shakeX = Math.round(shakeX * dpr) / dpr
      shakeY = Math.round(shakeY * dpr) / dpr
    }
  }
  out.x = camX
  out.y = camY
  out.zoom = zoom
  out.background = background
  out.shakeX = shakeX
  out.shakeY = shakeY
}

const emptyTransitions: AnimatorTransition[] = []
const sortedTransitionsMap = new WeakMap<AnimatorTransition[], AnimatorTransition[]>()

function sortedTransitions(stateDef: { transitions?: AnimatorTransition[] }): AnimatorTransition[] {
  const list = stateDef.transitions
  if (!list || list.length === 0) return emptyTransitions
  let sorted = sortedTransitionsMap.get(list)
  if (!sorted) {
    sorted = [...list].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    sortedTransitionsMap.set(list, sorted)
  }
  return sorted
}

/** Animator state machines, then clip playback, then squash/stretch. */
export function updateAnimation(world: ECSWorld, dt: number): void {
  // ── Animator evaluation pass (runs before animation so clips are resolved) ──
  for (const id of world.query('Animator', 'AnimationState')) {
    const animator = world.getComponent<AnimatorComponent>(id, 'Animator')!
    const anim = world.getComponent<AnimationStateComponent>(id, 'AnimationState')!
    if (!animator.playing) continue

    // Ensure valid state
    if (!animator.states[animator.currentState]) {
      animator.currentState = animator.initialState
      animator._entered = false
    }

    const stateDef = animator.states[animator.currentState]
    if (!stateDef) continue

    // Enter state: set clip and fire onEnter
    if (!animator._entered) {
      anim.currentClip = stateDef.clip
      animator._entered = true
      stateDef.onEnter?.()
    }

    // Blend timer: count down and complete deferred state transition
    if (animator._blendTimer != null && animator._blendTimer > 0) {
      animator._blendTimer -= dt
      if (animator._blendTimer <= 0 && animator._blendToState) {
        stateDef.onExit?.()
        animator.currentState = animator._blendToState
        animator._entered = false
        animator._blendTimer = undefined
        animator._blendToState = undefined
      }
      // Skip evaluating new transitions while blending
    } else {
      // Evaluate transitions
      if (stateDef.transitions && stateDef.transitions.length > 0) {
        // Sorted by priority descending (cached per state definition —
        // re-sorting a fresh copy every frame per entity dominated animator cost).
        const sorted = sortedTransitions(stateDef)
        for (const trans of sorted) {
          // exitTime check
          if (trans.exitTime != null && anim.frames.length > 0) {
            const progress = anim.currentIndex / anim.frames.length
            if (progress < trans.exitTime) continue
          }
          // Evaluate all conditions (AND)
          if (evaluateConditions(trans.when, animator.params)) {
            if (trans.blendDuration && trans.blendDuration > 0) {
              // Deferred transition: old clip keeps playing during blend
              animator._blendTimer = trans.blendDuration
              animator._blendToState = trans.to
            } else {
              // Instant transition
              stateDef.onExit?.()
              animator.currentState = trans.to
              animator._entered = false
            }
            break
          }
        }
      }
    }
  }

  // ── Animation clip resolution + playback pass ─────────────────────────────
  for (const id of world.query('AnimationState', 'Sprite')) {
    const anim = world.getComponent<AnimationStateComponent>(id, 'AnimationState')!
    const sprite = world.getComponent<SpriteComponent>(id, 'Sprite')!

    // Resolve named clip if changed
    if (anim.clips && anim.currentClip && anim._resolvedClip !== anim.currentClip) {
      const clip = anim.clips[anim.currentClip]
      if (clip) {
        resolveClip(anim, clip)
        anim._resolvedClip = anim.currentClip
      }
    }

    if (!anim.playing || anim.frames.length === 0) continue
    anim.timer += dt
    const frameDuration = 1 / anim.fps
    while (anim.timer >= frameDuration) {
      anim.timer -= frameDuration
      anim.currentIndex++
      if (anim.currentIndex >= anim.frames.length) {
        if (anim.loop) {
          anim.currentIndex = 0
        } else {
          anim.currentIndex = anim.frames.length - 1
          anim.playing = false
          if (anim.onComplete && !anim._completed) {
            anim._completed = true
            anim.onComplete()
          }
          // Auto-transition to next clip
          if (anim.clips && anim.currentClip) {
            const currentClipDef = anim.clips[anim.currentClip]
            if (currentClipDef?.next && anim.clips[currentClipDef.next]) {
              anim.currentClip = currentClipDef.next
              // Will be resolved next frame (or this frame via _resolvedClip check above)
            }
          }
        }
      }
      // Fire frame event for the new frame index (0-based position in frames array)
      anim.frameEvents?.[anim.currentIndex]?.()
    }
    sprite.frameIndex = anim.frames[anim.currentIndex]
  }

  // ── SquashStretch update ─────────────────────────────────────────────────
  for (const id of world.query('SquashStretch')) {
    const ss = world.getComponent<SquashStretchComponent>(id, 'SquashStretch')!
    let tScX: number
    let tScY: number

    if (ss._manualTargetX !== undefined && ss._manualTargetY !== undefined) {
      // Manual trigger takes priority; clear after reading so it only applies once
      tScX = ss._manualTargetX
      tScY = ss._manualTargetY
      ss._manualTargetX = undefined
      ss._manualTargetY = undefined
    } else {
      const rb = world.getComponent<RigidBodyShape>(id, 'RigidBody')
      const spd = rb ? Math.sqrt(rb.vx * rb.vx + rb.vy * rb.vy) : 0
      tScX = rb && rb.vy < -100 ? 1 + ss.intensity * 0.4 : spd > 50 ? 1 - ss.intensity * 0.3 : 1
      tScY = rb && rb.vy < -100 ? 1 - ss.intensity * 0.4 : spd > 50 ? 1 + ss.intensity * 0.3 : 1
    }

    ss.currentScaleX += (tScX - ss.currentScaleX) * ss.recovery * dt
    ss.currentScaleY += (tScY - ss.currentScaleY) * ss.recovery * dt
  }
}

const colorTransitionCache = new WeakMap<
  ParticlePoolComponent,
  { from: string; to: string; r0: number; g0: number; b0: number; r1: number; g1: number; b1: number }
>()

/** Advance, expire and emit the particles of one pool at `t`. */
export function updateParticlePool(
  world: ECSWorld,
  pool: ParticlePoolComponent,
  t: TransformComponent,
  dt: number,
): void {
  if (pool.targetColor && pool._colorTransitionFrom !== undefined) {
    pool._colorTransitionElapsed = (pool._colorTransitionElapsed ?? 0) + dt
    const dur = pool.colorTransitionDuration ?? 0.5
    const ct = Math.min((pool._colorTransitionElapsed ?? 0) / dur, 1)
    const ease = ct * ct * (3 - 2 * ct)
    let parsed = colorTransitionCache.get(pool)
    if (!parsed || parsed.from !== pool._colorTransitionFrom || parsed.to !== pool.targetColor) {
      const [r0, g0, b0] = parseCSSColor(pool._colorTransitionFrom)
      const [r1, g1, b1] = parseCSSColor(pool.targetColor)
      parsed = { from: pool._colorTransitionFrom, to: pool.targetColor, r0, g0, b0, r1, g1, b1 }
      colorTransitionCache.set(pool, parsed)
    }
    const { r0: cr0, g0: cg0, b0: cb0, r1: cr1, g1: cg1, b1: cb1 } = parsed
    const ri = Math.round((cr0 + (cr1 - cr0) * ease) * 255)
    const gi = Math.round((cg0 + (cg1 - cg0) * ease) * 255)
    const bi = Math.round((cb0 + (cb1 - cb0) * ease) * 255)
    pool.color = `rgb(${ri},${gi},${bi})`
    if (ct >= 1) {
      pool._colorTransitionFrom = undefined
      pool._colorTransitionElapsed = undefined
    }
  }

  const isFormation = pool.mode === 'formation'

  // Update a single particle in place; returns whether it survives.
  // Defined once per pool per frame (not per particle) and applied via
  // an in-place compaction pass below — avoids both a per-particle
  // closure allocation and the fresh array `filter()` would allocate
  // every frame for every pool even when nothing expired.
  const updateParticle = (p: Particle): boolean => {
    if (isFormation) {
      // Seek toward formation target
      if (p.targetX !== undefined && p.targetY !== undefined) {
        const seek = pool.seekStrength ?? 0.055
        p.x += (p.targetX - p.x) * seek
        p.y += (p.targetY - p.y) * seek
      }
      // Attractor/repulsion: direct positional push applied after seek
      // so it visibly overrides the pull. strength < 0 = repulsion.
      if (pool.attractors) {
        for (const attr of pool.attractors) {
          const adx = p.x - attr.x
          const ady = p.y - attr.y
          const dist = Math.sqrt(adx * adx + ady * ady)
          if (dist < attr.radius && dist > 0) {
            const magnitude = -attr.strength * (1 - dist / attr.radius) * dt
            p.x += (adx / dist) * magnitude
            p.y += (ady / dist) * magnitude
          }
        }
      }
      return true // formation particles never expire
    }

    p.life -= dt
    // Attractor forces (supports negative strength = repulsion)
    if (pool.attractors) {
      for (const attr of pool.attractors) {
        const adx = attr.x - p.x
        const ady = attr.y - p.y
        const dist = Math.sqrt(adx * adx + ady * ady)
        if (dist < attr.radius && dist > 0) {
          const force = attr.strength * (1 - dist / attr.radius)
          p.vx += (adx / dist) * force * dt
          p.vy += (ady / dist) * force * dt
        }
      }
    }
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.vy += p.gravity * dt
    if (p.rotationSpeed !== undefined) p.rotation = (p.rotation ?? 0) + p.rotationSpeed * dt
    return p.life > 0
  }

  const particles = pool.particles
  let writeIdx = 0
  for (let readIdx = 0; readIdx < particles.length; readIdx++) {
    const p = particles[readIdx]
    if (updateParticle(p)) particles[writeIdx++] = p
  }
  particles.length = writeIdx

  // Emit new particles
  if (isFormation) {
    // Formation mode: spawn one persistent particle per formation point
    const fp = pool.formationPoints ?? []
    while (pool.particles.length < fp.length) {
      const idx = pool.particles.length
      const startSize = pool.sizeOverLife?.start ?? pool.particleSize
      const endSize = pool.sizeOverLife?.end ?? pool.particleSize
      pool.particles.push({
        x: t.x + (world.rng() - 0.5) * 20,
        y: t.y + (world.rng() - 0.5) * 20,
        vx: 0,
        vy: 0,
        life: 1,
        maxLife: 1,
        size: startSize,
        startSize,
        endSize,
        color: pool.color,
        gravity: 0,
        rotation: 0,
        targetX: fp[idx].x,
        targetY: fp[idx].y,
      })
    }
  } else if (pool.active && pool.particles.length < pool.maxParticles) {
    let spawnCount: number
    if (pool.burstCount != null && pool.burstCount > 0) {
      spawnCount = pool.burstCount
      pool.active = false
    } else {
      pool.timer += dt
      spawnCount = Math.floor(pool.timer * pool.rate)
      pool.timer -= spawnCount / pool.rate
    }
    for (let i = 0; i < spawnCount && pool.particles.length < pool.maxParticles; i++) {
      const angle = pool.angle + (world.rng() - 0.5) * pool.spread
      const speed = pool.speed * (0.5 + world.rng() * 0.5)
      let ox = 0
      let oy = 0
      const shape = pool.emitShape ?? 'point'
      if (shape === 'circle') {
        const r = (pool.emitRadius ?? 0) * Math.sqrt(world.rng())
        const a = world.rng() * Math.PI * 2
        ox = Math.cos(a) * r
        oy = Math.sin(a) * r
      } else if (shape === 'box') {
        ox = (world.rng() - 0.5) * (pool.emitWidth ?? 0)
        oy = (world.rng() - 0.5) * (pool.emitHeight ?? 0)
      }
      const startSize = pool.sizeOverLife?.start ?? pool.particleSize
      const endSize = pool.sizeOverLife?.end ?? pool.particleSize
      let rotSpeed: number | undefined
      if (pool.enableRotation && pool.rotationSpeedRange) {
        const [mn, mx] = pool.rotationSpeedRange
        rotSpeed = mn + world.rng() * (mx - mn)
      }
      pool.particles.push({
        x: t.x + ox,
        y: t.y + oy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: pool.particleLife,
        maxLife: pool.particleLife,
        size: startSize,
        startSize,
        endSize,
        color: pool.color,
        gravity: pool.gravity,
        rotation: pool.enableRotation ? world.rng() * Math.PI * 2 : 0,
        rotationSpeed: rotSpeed,
      })
    }
  }
}

/** Record the current position of a trail and trim it to its length. */
export function updateTrail(trail: TrailComponent, t: TransformComponent): void {
  trail.points.unshift({ x: t.x, y: t.y })
  if (trail.points.length > trail.length) trail.points.length = trail.length
}

// Local copies: importing renderSystem.ts would put the Canvas2D chunk's dependencies in the main bundle.
function resolveClip(anim: AnimationStateComponent, clip: AnimationClipDefinition): void {
  anim.frames = clip.frames
  anim.fps = clip.fps ?? 12
  anim.loop = clip.loop ?? true
  anim.onComplete = clip.onComplete
  anim.frameEvents = clip.frameEvents
  anim.currentIndex = 0
  anim.timer = 0
  anim._completed = false
  anim.playing = true
}

function evaluateConditions(conditions: AnimatorCondition[], params: Record<string, unknown>): boolean {
  for (const cond of conditions) {
    const val = params[cond.param]
    if (val === undefined) return false
    switch (cond.op) {
      case '==':
        if (val !== cond.value) return false
        break
      case '!=':
        if (val === cond.value) return false
        break
      case '>':
        if ((val as number) <= (cond.value as number)) return false
        break
      case '>=':
        if ((val as number) < (cond.value as number)) return false
        break
      case '<':
        if ((val as number) >= (cond.value as number)) return false
        break
      case '<=':
        if ((val as number) > (cond.value as number)) return false
        break
    }
  }
  return true
}
