#!/usr/bin/env bash
# Build the Comfy Commerce desktop app on BOTH platforms, in parallel:
#   - macOS, locally            (pnpm --filter @comfy-commerce/desktop dist:mac)
#   - Windows, on the build box  (over SSH → scripts/build-win-remote.ps1)
#
# Builds the current WORKING TREE (uncommitted changes included) — no commit or
# GitHub push required. The Windows source is synced as a tarball of the tree
# (node_modules / build output / secrets excluded), so the box stays in lockstep
# with whatever is on this Mac.
#
# Prereqs:
#   - `comfy-win` SSH alias in ~/.ssh/config → the Tailscale Windows box
#   - that box already bootstrapped (OpenSSH + key) with Node/pnpm/git/MSVC
#     (see the "windows-desktop-build-box" memory / desktop/README.md)
#
# Usage:  pnpm dist:desktop:all      (or)   bash scripts/build-all.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIN_HOST="comfy-win"
TMP="${TMPDIR:-/tmp}"
BUNDLE="$TMP/comfy-src.tgz"
MAC_LOG="$TMP/comfy-build-mac.log"
WIN_LOG="$TMP/comfy-build-win.log"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }

build_mac() {
  cd "$REPO"
  pnpm --filter @comfy-commerce/desktop dist:mac
}

build_windows() {
  cd "$REPO"
  # Pack the working tree — exclude deps, build output, and anything secret.
  tar czf "$BUNDLE" \
    --exclude='*/node_modules' --exclude='*/node_modules/*' \
    --exclude='*/.git' --exclude='*/.git/*' \
    --exclude='*/dist' --exclude='*/dist/*' \
    --exclude='*/out' --exclude='*/out/*' \
    --exclude='*/data' --exclude='*/data/*' \
    --exclude='*secret.key' --exclude='*.env' --exclude='*/.env' \
    --exclude='*.sqlite' --exclude='*.sqlite-journal' --exclude='*.db' \
    --exclude='*.log' --exclude='*.DS_Store' \
    -C "$(dirname "$REPO")" "$(basename "$REPO")"
  scp -q "$BUNDLE" "$WIN_HOST:comfy-src.tgz"
  scp -q "$REPO/scripts/build-win-remote.ps1" "$WIN_HOST:build-win-remote.ps1"
  ssh "$WIN_HOST" 'powershell -NoProfile -ExecutionPolicy Bypass -File $HOME\build-win-remote.ps1'
}

bold "▶ building macOS (local) + Windows ($WIN_HOST) in parallel…"
build_mac     >"$MAC_LOG" 2>&1 &
MAC_PID=$!
build_windows >"$WIN_LOG" 2>&1 &
WIN_PID=$!

wait "$MAC_PID"; MAC_RC=$?
wait "$WIN_PID"; WIN_RC=$?

echo
bold "================ BUILD SUMMARY ================"
if [ "$MAC_RC" -eq 0 ]; then
  echo "macOS   : PASS"
  ls -1 "$REPO"/desktop/dist/*.dmg "$REPO"/desktop/dist/*.zip 2>/dev/null | sed 's/^/          /'
else
  echo "macOS   : FAIL (rc=$MAC_RC) — tail:"
  tail -n 12 "$MAC_LOG" | sed 's/^/          /'
fi
if [ "$WIN_RC" -eq 0 ]; then
  echo "Windows : PASS"
  ssh "$WIN_HOST" "Get-ChildItem 'C:\dev\comfy-shopify\desktop\dist\*.exe' | ForEach-Object { '          {0:N0} bytes  {1}' -f \$_.Length, \$_.Name }" 2>/dev/null | grep -v CLIXML
else
  echo "Windows : FAIL (rc=$WIN_RC) — tail:"
  tail -n 15 "$WIN_LOG" | sed 's/^/          /'
fi
echo
echo "Full logs:  $MAC_LOG  |  $WIN_LOG"

# Combined exit status: non-zero unless BOTH platforms built.
[ "$MAC_RC" -eq 0 ] && [ "$WIN_RC" -eq 0 ]
