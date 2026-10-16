import React, { useEffect, useRef } from 'react'
import { setVirtualAxis, setVirtualButton } from '../hooks/useVirtualInput'

export interface VirtualJoystickProps {
  /** Diameter of the joystick base in pixels (default 120) */
  size?: number
  /** Screen corner to anchor to (default 'left') */
  position?: 'left' | 'right'
  /** Extra CSS applied to the outer container */
  style?: React.CSSProperties
  /** Show an action button (e.g. jump) alongside the joystick (default false) */
  actionButton?: boolean
  /** Label shown on the action button (default 'A') */
  actionLabel?: string
  /** Name of the virtual button to set (default 'action') */
  actionName?: string
}

/**
 * On-screen virtual joystick for touch / mobile. Place it as a sibling of the
 * `<Game>` canvas (inside a `position: relative` container).
 *
 * Read the joystick state with `useVirtualInput()`.
 *
 * @example
 * <div style={{ position: 'relative' }}>
 *   <Game ...>...</Game>
 *   <VirtualJoystick position="left" actionButton />
 * </div>
 *
 * // Inside an entity:
 * function MobilePlayer() {
 *   const virt = useVirtualInput()
 *   // virt.axisX, virt.axisY, virt.button('action')
 * }
 */
export function VirtualJoystick({
  size = 120,
  position = 'left',
  style,
  actionButton = false,
  actionLabel = 'A',
  actionName = 'action',
}: VirtualJoystickProps) {
  const baseRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef<HTMLDivElement>(null)
  const activePtr = useRef<number | null>(null)
  const activeActionPtr = useRef<number | null>(null)
  const baseCenterRef = useRef({ x: 0, y: 0 })

  const radius = size / 2 - 16

  const applyStickPosition = (dx: number, dy: number) => {
    if (!stickRef.current) return
    stickRef.current.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePtr.current !== null) return
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    activePtr.current = e.pointerId
    const rect = baseRef.current!.getBoundingClientRect()
    baseCenterRef.current = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    }
    updateFromPointer(e.clientX, e.clientY)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (e.pointerId !== activePtr.current) return
    updateFromPointer(e.clientX, e.clientY)
  }

  const handlePointerUp = (e: React.PointerEvent) => {
    if (e.pointerId !== activePtr.current) return
    activePtr.current = null
    setVirtualAxis(0, 0)
    applyStickPosition(0, 0)
  }

  const handleActionDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeActionPtr.current !== null) return
    e.currentTarget.setPointerCapture(e.pointerId)
    activeActionPtr.current = e.pointerId
    setVirtualButton(actionName, true)
  }

  const handleActionEnd = (e: React.PointerEvent) => {
    if (e.pointerId !== activeActionPtr.current) return
    activeActionPtr.current = null
    setVirtualButton(actionName, false)
  }

  useEffect(
    () => () => {
      activePtr.current = null
      setVirtualAxis(0, 0)
      if (stickRef.current) stickRef.current.style.transform = 'translate(-50%, -50%)'
    },
    [],
  )

  useEffect(
    () => () => {
      activeActionPtr.current = null
      setVirtualButton(actionName, false)
    },
    [actionButton, actionName],
  )

  const updateFromPointer = (clientX: number, clientY: number) => {
    const dx = clientX - baseCenterRef.current.x
    const dy = clientY - baseCenterRef.current.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist === 0) {
      setVirtualAxis(0, 0)
      applyStickPosition(0, 0)
      return
    }

    const clamped = Math.min(dist, radius)
    const angle = Math.atan2(dy, dx)
    const sx = Math.cos(angle) * clamped
    const sy = Math.sin(angle) * clamped

    setVirtualAxis(sx / radius, sy / radius)
    applyStickPosition(sx, sy)
  }

  const cornerStyle: React.CSSProperties = position === 'left' ? { left: 24, bottom: 24 } : { right: 24, bottom: 24 }

  const actionCorner: React.CSSProperties = position === 'left' ? { right: 24, bottom: 24 } : { left: 24, bottom: 24 }

  return (
    <>
      {/* Joystick base */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
        style={{
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.12)',
          border: '2px solid rgba(255,255,255,0.25)',
          touchAction: 'none',
          userSelect: 'none',
          cursor: 'pointer',
          ...cornerStyle,
          ...style,
        }}
        ref={baseRef}
      >
        {/* Stick nub */}
        <div
          ref={stickRef}
          style={{
            position: 'absolute',
            width: size * 0.38,
            height: size * 0.38,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.45)',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            transition: 'none',
          }}
        />
      </div>

      {/* Optional action button */}
      {actionButton && (
        <div
          onPointerDown={handleActionDown}
          onPointerUp={handleActionEnd}
          onPointerCancel={handleActionEnd}
          onLostPointerCapture={handleActionEnd}
          style={{
            position: 'absolute',
            width: size * 0.55,
            height: size * 0.55,
            borderRadius: '50%',
            background: 'rgba(255,220,0,0.25)',
            border: '2px solid rgba(255,220,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.7)',
            fontSize: size * 0.18,
            fontWeight: 700,
            fontFamily: 'monospace',
            touchAction: 'none',
            userSelect: 'none',
            cursor: 'pointer',
            ...actionCorner,
          }}
        >
          {actionLabel}
        </div>
      )}
    </>
  )
}
