import { useId, useLayoutEffect, type ReactNode } from 'react'
import type { Theme } from '../../shared/preferences'

const choices: { value: Theme; label: string; icon: ReactNode }[] = [
  { value: 'light', label: '浅色', icon: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> },
  { value: 'dark', label: '深色', icon: <path d="M20.5 13.3A8.7 8.7 0 0 1 10.7 3.5a8.7 8.7 0 1 0 9.8 9.8Z" /> },
  { value: 'system', label: '跟随系统', icon: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></> }
]

export function useSettingsTheme(theme: Theme = 'system'): void {
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => {
      const resolved = theme === 'system' ? media.matches ? 'dark' : 'light' : theme
      document.body.dataset.theme = resolved
      document.documentElement.style.colorScheme = resolved
    }
    sync()
    media.addEventListener('change', sync)
    return () => { media.removeEventListener('change', sync); delete document.body.dataset.theme; document.documentElement.style.removeProperty('color-scheme') }
  }, [theme])
}

/** Native radios keep arrow-key selection; the segmented look is styling only. */
export function ThemePicker({ value, disabled, onChange }: { value: Theme; disabled?: boolean; onChange: (theme: Theme) => void }) {
  const name = useId()
  return <div className="settings-segmented theme-options" role="radiogroup" aria-label="配置页外观">
    {choices.map(choice => <label key={choice.value} className="theme-choice" data-selected={value === choice.value}>
      <input className="sr-only" type="radio" name={name} value={choice.value} checked={value === choice.value} disabled={disabled}
        data-testid={`theme-${choice.value}`} onChange={() => onChange(choice.value)} />
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{choice.icon}</svg>
      <span>{choice.label}</span>
    </label>)}
  </div>
}
