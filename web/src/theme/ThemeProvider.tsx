import { createContext, useCallback, useContext, useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

interface ThemeContextValue {
  preference: ThemePreference
  resolved: 'light' | 'dark'
  setPreference: (pref: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const THEME_KEY = 'cc-theme'

function systemTheme(): 'light' | 'dark' {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem(THEME_KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  })
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    preference === 'system' ? systemTheme() : preference,
  )

  useEffect(() => {
    const apply = () => {
      const next = preference === 'system' ? systemTheme() : preference
      setResolved(next)
      // index.html already wrote the identical value pre-paint; data-theme
      // appears in descendant-affecting selectors, so skip the redundant
      // same-value write rather than risk a full-tree style invalidation.
      if (document.documentElement.dataset.theme !== next) {
        document.documentElement.dataset.theme = next
      }
    }
    apply()
    const media = matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [preference])

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref)
    if (pref === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, pref)
  }, [])

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme outside ThemeProvider')
  return ctx
}
