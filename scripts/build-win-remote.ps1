# Remote Windows half of the dual-platform desktop build.
#
# Invoked by scripts/build-all.sh over SSH. Expects the source bundle
# (comfy-src.tgz, produced by build-all.sh) already scp'd to the home dir.
# Extracts it, installs deps, builds the NSIS installer, and exits non-zero on
# any failure so the caller can tell macOS from Windows outcomes.
$ErrorActionPreference = 'Stop'

$bundle = Join-Path $HOME 'comfy-src.tgz'
$repo   = 'C:\dev\comfy-shopify'

Write-Host '[win] extracting source bundle...'
if (-not (Test-Path 'C:\dev')) { New-Item -ItemType Directory -Path 'C:\dev' | Out-Null }
tar -xzf $bundle -C 'C:\dev'
if ($LASTEXITCODE -ne 0) { Write-Host '[win] extract FAILED'; exit 1 }

Set-Location $repo

# Stop any running instance first — a live app holds a lock on dist\win-unpacked
# and electron-builder fails with "EBUSY: resource busy or locked, rmdir".
Get-Process -Name 'Comfy Commerce' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

corepack enable 2>$null | Out-Null

Write-Host '[win] pnpm install...'
pnpm install
if ($LASTEXITCODE -ne 0) { Write-Host '[win] pnpm install FAILED'; exit 1 }

Write-Host '[win] building dist:win...'
pnpm --filter '@comfy-commerce/desktop' dist:win
$rc = $LASTEXITCODE

if ($rc -eq 0) {
  $exe = Get-Item "$repo\desktop\dist\Comfy Commerce Setup 0.1.0.exe" -ErrorAction SilentlyContinue
  if ($exe) { Write-Host ('[win] OK  {0:N0} bytes  {1}' -f $exe.Length, $exe.FullName) }
  else { Write-Host '[win] build reported success but installer not found'; $rc = 1 }
} else {
  Write-Host "[win] dist:win FAILED (rc=$rc)"
}
exit $rc
