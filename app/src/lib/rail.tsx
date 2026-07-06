import { useEffect, useState } from 'react'
import { usePref } from './prefs'

const MIN_WIDTH = 180
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 256

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return isDesktop
}

// Per-rail width + pinned/collapsed state, server-persisted via the prefs store.
// - `pinned`: when true, the rail is docked into the layout taking real estate.
//             when false (default), the rail floats as an overlay drawer that
//             slides in on demand and auto-dismisses (Slack/VS Code pattern).
// - `collapsed`: only meaningful when pinned=true; hides the docked rail while
//                leaving a hamburger to re-expand.
export function useRailState(storageKey: string) {
  const [width, setWidth] = usePref<number>(storageKey + '_width', DEFAULT_WIDTH)
  const [collapsed, setCollapsed] = usePref<boolean>(storageKey + '_collapsed', false)
  const [pinned, setPinned] = usePref<boolean>(storageKey + '_pinned', false)
  return {
    width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width)),
    setWidth: (n: number) => setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n))),
    collapsed,
    setCollapsed,
    pinned,
    setPinned,
  }
}

export function RailResizeHandle({
  width,
  setWidth,
}: {
  width: number
  setWidth: (n: number) => void
}) {
  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    function onMove(ev: MouseEvent) {
      const next = startWidth + (ev.clientX - startX)
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next)))
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  return (
    <div
      onMouseDown={onMouseDown}
      className="hidden md:block w-1 cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)] transition-colors flex-shrink-0"
    />
  )
}
