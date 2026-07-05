import { spawn } from 'node:child_process'

import { buildApp } from './app.js'
import { loadEnv, type Env } from './env.js'

const TTY = process.stdout.isTTY
const paint = (code: string, s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = (s: string) => paint('1', s)
const dim = (s: string) => paint('2', s)
const accent = (s: string) => paint('38;5;173', s) // soft copper — nods to the brand accent

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const visibleLen = (s: string) => [...stripAnsi(s)].length

/** Wrap pre-colored content lines in a rounded, auto-sized box. */
function box(lines: string[]): string[] {
  const width = Math.max(...lines.map(visibleLen))
  const rule = '─'.repeat(width + 2)
  const side = accent('│')
  return [
    `  ${accent(`╭${rule}╮`)}`,
    ...lines.map((l) => `  ${side} ${l}${' '.repeat(width - visibleLen(l))} ${side}`),
    `  ${accent(`╰${rule}╯`)}`,
  ]
}

/** A clean, framed startup notice instead of raw JSON log lines. */
function printStartupNotice(
  env: Env,
  stores: ReadonlyArray<{ domain: string; status: string }>,
): void {
  const shopify =
    stores.length === 0
      ? dim('no store connected — add one in the UI')
      : stores.length === 1
        ? `${stores[0]!.domain}${stores[0]!.status === 'connected' ? '' : dim(` (${stores[0]!.status})`)}`
        : `${stores.length} stores connected`
  const lines = [
    `${accent('◆')}  ${bold('Comfy Commerce')}`,
    `   ${dim('Product media studio · self-hosted')}`,
    '',
    // "Studio" is always the URL to open. In prod the broker serves it itself;
    // in dev it's the Vite dev server, with the broker's API shown alongside.
    `${dim('Studio ')}  ${accent(env.serveWeb ? env.appUrl : env.webOrigin)}`,
  ]
  if (!env.serveWeb) lines.push(`${dim('API    ')}  ${dim(env.appUrl)}`)
  lines.push(`${dim('Shopify')}  ${shopify}`)
  console.log('\n' + box(lines).join('\n') + '\n')
}

/** Open the studio in the default browser (prod mode, interactive terminals only). */
function openStudio(env: Env): void {
  if (!env.serveWeb || !TTY) return // never hijack a headless / CI / cron run
  const optOut = (process.env.OPEN_BROWSER ?? '').toLowerCase()
  if (optOut === '0' || optOut === 'false' || optOut === 'no') return

  const url = env.appUrl
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
    console.log(`  ${dim('Opening your browser…')}\n`)
  } catch {
    /* opening a browser is best-effort — the URL is printed above regardless */
  }
}

const env = loadEnv()
const { app, ctx } = await buildApp(env)

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return // SIGINT then SIGTERM, or a double Ctrl-C
  shuttingDown = true
  console.log(`\n  ${dim(`Shutting down (${signal})…`)}`)
  // Force-exit if a clean close hangs (e.g. a wedged provider request).
  const force = setTimeout(() => process.exit(1), env.shutdownTimeoutMs)
  force.unref()
  try {
    await app.close() // stop accepting connections, drain in-flight requests
    // Aborts + records interrupted state synchronously, then bounded-awaits
    // executor teardown so cloud poll loops can fire their cancel POSTs.
    await ctx.runService.shutdown()
    ctx.db.$client.close() // checkpoint the WAL and release the SQLite handle
  } catch (err) {
    app.log.error(err)
  }
  clearTimeout(force)
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await app.listen({ port: env.port, host: env.host })
  // Warm the provider-availability cache off the request path, so the studio's
  // first /api/providers call answers from cache instead of awaiting probes.
  void ctx.providers.listInfo().catch(() => {})
  printStartupNotice(env, ctx.storeService.list())
  openStudio(env)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
