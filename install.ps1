<#
.SYNOPSIS
  Ensure the dsh-session-insight plugin row is present in the desktop profile's
  patch layer. Idempotent: safe to run any number of times.

.DESCRIPTION
  The desktop profile is managed by the Electron application, so `dsh plugin`
  refuses to touch it ("profile desktop is managed exclusively by the Electron
  application"). This script edits the patch file directly instead.

  Run it BEFORE starting the app if the app overwrote the patch file on a
  previous exit. It reports clearly whether it changed anything.

  To uninstall, run with -Uninstall (removes the block and restores the backup).
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'

$patch = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\cordis.patch.yml"
$backup = "$patch.bak-before-session-insight"
$marker = 'session-insight'
# NOTE: the specifier must point at the entry FILE, not the package directory.
# A `file:` directory specifier fails with ERR_UNSUPPORTED_DIR_IMPORT; the host
# half then never mounts, and dsh-client-modules only scans Loader entries that
# own a fiber — so the browser half would never be served (404 on /plugins/...).
#
# The URL is derived from this script's own location, so the checkout can live
# anywhere (no machine-specific path baked in).
$entry = Join-Path $PSScriptRoot 'index.js'
if (-not (Test-Path $entry)) { throw "plugin entry file not found: $entry" }
$entryUrl = 'file:///' + ($entry -replace '\\', '/')
$block = @"
- insert:
    - id: session-insight
      name: '$entryUrl'
"@

if (-not (Test-Path $patch)) { throw "patch file not found: $patch" }
$text = Get-Content $patch -Raw
$present = $text -match [regex]::Escape($marker)

if ($Uninstall) {
  if (-not $present) { Write-Host "Nothing to do: '$marker' is not present."; return }
  # Keep the original backup as the source of truth when we have one.
  if (Test-Path $backup) {
    Copy-Item $backup $patch -Force
    Write-Host "Restored the pre-install backup over $patch"
  } else {
    $lines = Get-Content $patch
    $kept = $lines | Where-Object { $_ -notmatch [regex]::Escape($marker) -and $_ -notmatch 'Session insight' }
    ($kept -join "`n") | Set-Content $patch -Encoding utf8
    Write-Host "Removed the plugin block from $patch (no backup was available)."
  }
  Write-Host "Restart DSH for the change to take effect."
  return
}

if ($present) {
  Write-Host "Already installed: '$marker' is present in $patch"
  Write-Host "Nothing to do."
  return
}

# Back up only once, so the backup always holds the pristine pre-install state.
if (-not (Test-Path $backup)) {
  Copy-Item $patch $backup -Force
  Write-Host "Backup written: $backup"
}

$appended = $text.TrimEnd() + "`n`n# Session insight (dsh-session-insight) - read-only session-health strip above`n# the composer. Chain: sessionProjections -> wire.view -> useProjection ->`n# conversation.input.dock. To uninstall: run this script with -Uninstall.`n" + $block + "`n"
Set-Content -Path $patch -Value $appended -Encoding utf8 -NoNewline

Write-Host "Installed '$marker' into $patch"
Write-Host "Restart DSH (fully quit the app first) for the change to take effect."
