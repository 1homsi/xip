/**
 * TriMesh collision detection using BVH acceleration.
 *
 * For each query (circle or AABB), the BVH narrows down candidate triangles,
 * then individual triangle-shape tests generate contact manifolds.
 */

import type { ContactPoint } from './contactManifold'
import type { BVH, Triangle2D } from './bvh'
import { queryBVH, queryBVHCircle } from './bvh'
import { closestPointOnSegment } from './satManifold'

// ── Triangle-Circle contact ──────────────────────────────────────────────────

function closestPointOnTriangle(px: number, py: number, tri: Triangle2D): { x: number; y: number } {
  // Check each edge and the interior
  const p1 = closestPointOnSegment(px, py, tri.ax, tri.ay, tri.bx, tri.by)
  const p2 = closestPointOnSegment(px, py, tri.bx, tri.by, tri.cx, tri.cy)
  const p3 = closestPointOnSegment(px, py, tri.cx, tri.cy, tri.ax, tri.ay)

  // Also check if point is inside the triangle
  const inside = pointInTriangle(px, py, tri)

  if (inside) return { x: px, y: py }

  const d1 = (px - p1.x) ** 2 + (py - p1.y) ** 2
  const d2 = (px - p2.x) ** 2 + (py - p2.y) ** 2
  const d3 = (px - p3.x) ** 2 + (py - p3.y) ** 2

  if (d1 <= d2 && d1 <= d3) return p1
  if (d2 <= d3) return p2
  return p3
}

function pointInTriangle(px: number, py: number, tri: Triangle2D): boolean {
  const d1 = sign(px, py, tri.ax, tri.ay, tri.bx, tri.by)
  const d2 = sign(px, py, tri.bx, tri.by, tri.cx, tri.cy)
  const d3 = sign(px, py, tri.cx, tri.cy, tri.ax, tri.ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

function sign(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  return (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2)
}

function triangleNormal(tri: Triangle2D): { x: number; y: number } {
  // Compute outward normal of the triangle (perpendicular to the "winding")
  // For a 2D triangle, we use the cross product sign to determine winding
  const cross = (tri.bx - tri.ax) * (tri.cy - tri.ay) - (tri.by - tri.ay) * (tri.cx - tri.ax)
  // If cross > 0, CCW winding → normal points "up" (out of screen), but for 2D physics
  // we need a surface normal. We'll compute per-contact from the closest point direction.
  // For a thin triangle used as static geometry, the normal is determined by the contact direction.
  return { x: 0, y: cross >= 0 ? -1 : 1 } // fallback
}

/**
 * Generate contact manifold between a triangle mesh and a circle.
 */
export function generateTriMeshCircleManifold(
  bvh: BVH,
  meshCx: number,
  meshCy: number,
  circleCx: number,
  circleCy: number,
  circleR: number,
): { normalX: number; normalY: number; points: ContactPoint[] } | null {
  const localCircleX = circleCx - meshCx
  const localCircleY = circleCy - meshCy
  const candidates = queryBVHCircle(bvh, localCircleX, localCircleY, circleR)
  if (candidates.length === 0) return null

  let bestPen = 0
  let bestContact: ContactPoint | null = null
  let bestNx = 0,
    bestNy = 0

  for (const idx of candidates) {
    const tri = bvh.triangles[idx]
    const closest = closestPointOnTriangle(localCircleX, localCircleY, tri)
    const dx = localCircleX - closest.x
    const dy = localCircleY - closest.y
    const distSq = dx * dx + dy * dy

    if (distSq >= circleR * circleR) continue

    const dist = Math.sqrt(distSq)
    let nx: number, ny: number
    if (dist < 1e-8) {
      // Circle center is on the triangle — use triangle normal
      const tn = triangleNormal(tri)
      nx = tn.x
      ny = tn.y
    } else {
      nx = dx / dist
      ny = dy / dist
    }

    const penetration = circleR - dist
    if (penetration > bestPen) {
      bestPen = penetration
      bestNx = nx
      bestNy = ny

      const contactOnCircleX = circleCx - nx * circleR
      const contactOnCircleY = circleCy - ny * circleR

      bestContact = {
        worldAx: closest.x + meshCx,
        worldAy: closest.y + meshCy,
        worldBx: contactOnCircleX,
        worldBy: contactOnCircleY,
        rAx: closest.x,
        rAy: closest.y,
        rBx: contactOnCircleX - circleCx,
        rBy: contactOnCircleY - circleCy,
        penetration,
        normalImpulse: 0,
        tangentImpulse: 0,
        featureId: 600 + idx,
      }
    }
  }

  if (!bestContact) return null

  return {
    normalX: bestNx, // from mesh (A) toward circle (B): direction from closest point on mesh toward circle
    normalY: bestNy,
    points: [bestContact],
  }
}

/**
 * Generate contact manifold between a triangle mesh and an AABB.
 */
export function generateTriMeshBoxManifold(
  bvh: BVH,
  meshCx: number,
  meshCy: number,
  boxCx: number,
  boxCy: number,
  boxHw: number,
  boxHh: number,
): { normalX: number; normalY: number; points: ContactPoint[] } | null {
  const localBoxCx = boxCx - meshCx
  const localBoxCy = boxCy - meshCy
  const candidates = queryBVH(bvh, {
    minX: localBoxCx - boxHw,
    minY: localBoxCy - boxHh,
    maxX: localBoxCx + boxHw,
    maxY: localBoxCy + boxHh,
  })
  if (candidates.length === 0) return null

  let bestPen = 0
  let bestContact: ContactPoint | null = null
  let bestNx = 0,
    bestNy = 0

  // Box corners
  const corners = [
    { x: localBoxCx - boxHw, y: localBoxCy - boxHh },
    { x: localBoxCx + boxHw, y: localBoxCy - boxHh },
    { x: localBoxCx + boxHw, y: localBoxCy + boxHh },
    { x: localBoxCx - boxHw, y: localBoxCy + boxHh },
  ]

  for (const idx of candidates) {
    const tri = bvh.triangles[idx]

    // Check each box corner against the triangle
    for (let ci = 0; ci < corners.length; ci++) {
      const corner = corners[ci]
      if (!pointInTriangle(corner.x, corner.y, tri)) continue

      // Corner is inside triangle — compute penetration
      // Find closest edge of triangle to push the corner out
      const edges = [
        { ax: tri.ax, ay: tri.ay, bx: tri.bx, by: tri.by },
        { ax: tri.bx, ay: tri.by, bx: tri.cx, by: tri.cy },
        { ax: tri.cx, ay: tri.cy, bx: tri.ax, by: tri.ay },
      ]

      let minDist = Infinity
      let bestEdgeNx = 0,
        bestEdgeNy = 0
      for (const e of edges) {
        const cp = closestPointOnSegment(corner.x, corner.y, e.ax, e.ay, e.bx, e.by)
        const dx = corner.x - cp.x
        const dy = corner.y - cp.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < minDist) {
          minDist = dist
          if (dist < 1e-8) {
            const ex = e.bx - e.ax
            const ey = e.by - e.ay
            const len = Math.sqrt(ex * ex + ey * ey)
            bestEdgeNx = len > 0 ? ey / len : 0
            bestEdgeNy = len > 0 ? -ex / len : -1
          } else {
            bestEdgeNx = dx / dist
            bestEdgeNy = dy / dist
          }
        }
      }

      if (minDist > bestPen) {
        bestPen = minDist
        bestNx = bestEdgeNx
        bestNy = bestEdgeNy
        bestContact = {
          worldAx: corner.x - bestEdgeNx * minDist + meshCx,
          worldAy: corner.y - bestEdgeNy * minDist + meshCy,
          worldBx: corner.x + meshCx,
          worldBy: corner.y + meshCy,
          rAx: corner.x - bestEdgeNx * minDist,
          rAy: corner.y - bestEdgeNy * minDist,
          rBx: corner.x - localBoxCx,
          rBy: corner.y - localBoxCy,
          penetration: minDist,
          normalImpulse: 0,
          tangentImpulse: 0,
          featureId: 620 + idx * 4 + ci,
        }
      }
    }
  }

  if (!bestContact) return null

  return {
    normalX: bestNx,
    normalY: bestNy,
    points: [bestContact],
  }
}
