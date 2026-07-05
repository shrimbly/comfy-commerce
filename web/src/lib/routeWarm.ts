/** Route-chunk warm registry. App.tsx registers each lazy route's preloader;
 * the sidebar fires it on hover/focus so a navigation never starts
 * module-cold. Lives in its own module so Sidebar doesn't import App
 * (AppShell → Sidebar → App would be a cycle). Preloads are idempotent. */
const registry = new Map<string, () => void>()

export function registerRouteWarm(path: string, warm: () => void): void {
  registry.set(path, warm)
}

export function warmRoute(path: string): void {
  registry.get(path)?.()
}
