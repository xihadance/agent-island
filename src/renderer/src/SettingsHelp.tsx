import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export function SettingsHelp({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [open])
  return <div className="settings-heading-help" ref={root}>
    <div className="settings-help-heading"><h2>{title}</h2><div className="settings-help-anchor" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="settings-help-toggle" aria-label={`查看${title}说明`}
      aria-expanded={open} aria-controls={id} aria-describedby={open ? id : undefined} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
    </button>
      <div id={id} role="tooltip" className="settings-help-panel" hidden={!open}><strong>提示</strong>{children}</div>
    </div></div>
  </div>
}
