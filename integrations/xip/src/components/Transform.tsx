import { useEffect, useContext } from 'react'
import { createTransform, type TransformComponent } from '@xip/core'
import { EngineContext, EntityContext } from '../context'

interface TransformProps {
  x?: number
  y?: number
  rotation?: number
  scaleX?: number
  scaleY?: number
}

export function Transform({ x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1 }: TransformProps) {
  const engine = useContext(EngineContext)!
  const entityId = useContext(EntityContext)!

  useEffect(() => {
    engine.ecs.addComponent(entityId, createTransform(x, y, rotation, scaleX, scaleY))
    engine.loop.markDirty()
    return () => engine.ecs.removeComponent(entityId, 'Transform')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync prop changes to component data
  useEffect(() => {
    const comp = engine.ecs.getComponent<TransformComponent>(entityId, 'Transform')
    if (comp) {
      comp.x = x
      comp.y = y
      comp.rotation = rotation
      comp.scaleX = scaleX
      comp.scaleY = scaleY
    }
    // An onDemand loop only repaints when woken; a prop change driven from outside the canvas must wake it.
    engine.loop.markDirty()
  }, [x, y, rotation, scaleX, scaleY, engine, entityId])

  return null
}
