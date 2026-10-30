import { useId, type ReactNode } from 'react'
import type { Activity } from '../../shared/activity'
import type { PreferencesPatch, SettingsSnapshot } from '../../shared/preferences'
import type { SettingsPage } from '../../shared/settings-nav'
import type { Capability, Tone } from '../../shared/settings-summary'
import { agentAppearance } from './agent-appearance'
import { ClaudeIcon, CodexIcon, CursorIcon, GeminiIcon } from './agent-icons'

export interface PageProps {
  snapshot: SettingsSnapshot
  activities: Activity[]
  busy: boolean
  remoteDirty: boolean
  run: (action: () => Promise<unknown>, success?: string) => Promise<void>
  update: (patch: PreferencesPatch) => void
  setSnapshot: (snapshot: SettingsSnapshot) => void
  navigate: (page: SettingsPage) => void
}

export function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
}

/** Reuses the island's drawn agent marks; settings only changes their tile shape. */
export function AgentMark({ agent, large = false }: { agent: string; large?: boolean }) {
  const appearance = agentAppearance(agent)
  const gradient = useId().replace(/:/g, '')
  return <span className={`agent-badge agent-${appearance.key} settings-mark${large ? ' settings-mark-large' : ''}`} aria-hidden="true">
    {appearance.key === 'claude' && <ClaudeIcon />}
    {appearance.key === 'codex' && <CodexIcon />}
    {appearance.key === 'gemini' && <GeminiIcon id={gradient} />}
    {appearance.key === 'cursor' && <CursorIcon />}
    {appearance.key === 'custom' && appearance.mark}
  </span>
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className="status-dot" data-tone={tone} aria-hidden="true" />
}

export function Group({ title, titleId, aside, footer, className, children }: {
  title?: ReactNode; titleId?: string; aside?: ReactNode; footer?: ReactNode; className?: string; children: ReactNode
}) {
  const generated = useId()
  const id = titleId ?? `${generated}-title`
  return <section className={`settings-group${className ? ` ${className}` : ''}`} aria-labelledby={title ? id : undefined}>
    {title && <h2 className="settings-group-label" id={id}>{title}</h2>}
    {aside && <span className="settings-group-aside">{aside}</span>}
    <div className="settings-card">{children}</div>
    {footer && <p className="settings-group-foot">{footer}</p>}
  </section>
}

export function Row({ title, description, htmlFor, titleId, descriptionId, children, className }: {
  title: ReactNode; description?: ReactNode; htmlFor?: string; titleId?: string; descriptionId?: string; children?: ReactNode; className?: string
}) {
  return <div className={`setting-row${className ? ` ${className}` : ''}`}>
    <div className="setting-copy">{htmlFor ? <label htmlFor={htmlFor} id={titleId}>{title}</label> : <strong id={titleId}>{title}</strong>}
      {description && <p id={descriptionId}>{description}</p>}</div>
    {children !== undefined && <div className="setting-control">{children}</div>}
  </div>
}

export function Switch({ id, title, description, checked, disabled, onChange }: {
  id?: string; title: string; description: ReactNode; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void
}) {
  const generated = useId()
  const control = id ?? generated
  return <Row title={title} description={description} htmlFor={control} titleId={`${control}-label`} descriptionId={`${control}-description`}>
    <button id={control} className="setting-switch" type="button" role="switch" aria-checked={checked} aria-labelledby={`${control}-label`}
      aria-describedby={`${control}-description`} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
  </Row>
}

export function LinkRow({ lead, title, description, value, tone, onClick }: {
  lead?: ReactNode; title: ReactNode; description?: ReactNode; value?: ReactNode; tone?: Tone; onClick: () => void
}) {
  return <button type="button" className="setting-row setting-link" onClick={onClick}>
    {lead}
    <span className="setting-copy"><strong>{title}</strong>{description && <span className="setting-description">{description}</span>}</span>
    {value && <span className="setting-value" data-tone={tone}>{value}</span>}
    <span className="setting-chevron" aria-hidden="true">›</span>
  </button>
}

export function Capabilities({ items }: { items: Capability[] }) {
  return <ul className="capability-list">{items.map(item => <li key={item.title} className="setting-row" data-available={item.available}>
    <span className="capability-mark" aria-hidden="true">{item.available ? '✓' : '–'}</span>
    <span className="setting-copy"><strong>{item.title}<span className="sr-only">{item.available ? '：可用' : '：暂不可用'}</span></strong>
      <span className="setting-description">{item.detail}</span></span>
  </li>)}</ul>
}

export function Hero({ mark, title, description, status, tone }: { mark: ReactNode; title: string; description: string; status?: string; tone?: Tone }) {
  return <header className="settings-hero">
    {mark}
    <h1>{title}</h1>
    <p>{description}</p>
    {status && <span className="settings-pill" data-tone={tone}><Dot tone={tone ?? 'off'} />{status}</span>}
  </header>
}

export function Notice({ tone = 'warn', children, action }: { tone?: 'warn' | 'error'; children: ReactNode; action?: ReactNode }) {
  return <div className="settings-notice" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}><p>{children}</p>{action}</div>
}
