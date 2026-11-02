<#
  Builds the shadow Electron tree that the island window runs from.

  DSH ships its own Electron; instead of downloading another ~250 MB we hard-link
  that binary and its support files into a directory we control, then point that
  tree's resources\app at dsh-island-desktop. Same volume => links are instant and
  take no extra space.

  -Src  folder that holds "DeepSeek Harness.exe" (the DSH install root).
        Omitted => tries a few common locations.
  -Dst  where the shadow tree goes (default: %LOCALAPPDATA%\dsh-island-win).
#>
param(
  [string]$Src = '',
  [string]$Dst = (Join-Path $env:LOCALAPPDATA 'dsh-island-win')
)

$ErrorActionPreference = 'Stop'

if (-not $Src) {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    (Join-Path $env:ProgramFiles 'dsh')
  )
  $Src = $candidates | Where-Object {
    $_ -and (Test-Path (Join-Path $_ 'DeepSeek Harness.exe'))
  } | Select-Object -First 1
  if (-not $Src) {
    throw "Could not find 'DeepSeek Harness.exe'. Pass -Src <path to the DSH install folder>."
  }
}

if (-not (Test-Path (Join-Path $Src 'DeepSeek Harness.exe'))) {
  throw "No 'DeepSeek Harness.exe' under $Src"
}

Write-Host "source: $Src"
Write-Host "target: $Dst"

if (Test-Path $Dst) { Remove-Item -Recurse -Force $Dst }
New-Item -ItemType Directory -Path $Dst | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Dst 'resources\app') | Out-Null

# Mirror every root-level support file as a hard link (same volume: instant, no copy).
Get-ChildItem -Path $Src -File | Where-Object {
  $_.Name -notlike 'Uninstall*' -and
  $_.Name -notlike '7zip*' -and
  $_.Name -notlike 'LICENSE*' -and
  $_.Name -ne 'DeepSeek Harness.exe'
} | ForEach-Object {
  cmd /c mklink /H "`"$Dst\$($_.Name)`"" "`"$($_.FullName)`"" | Out-Null
}

# The exe under our own name, so no window class / taskbar identity collides.
cmd /c mklink /H "`"$Dst\dsh-island.exe`"" "`"$Src\DeepSeek Harness.exe`"" | Out-Null

# Directory junction for the shared bulk folder.
if (Test-Path (Join-Path $Src 'locales')) {
  cmd /c mklink /J "`"$Dst\locales`"" "`"$Src\locales`"" | Out-Null
}

Write-Host ''
Write-Host 'shadow tree:'
Get-ChildItem $Dst | Select-Object Name, Length | Format-Table -AutoSize

Write-Host 'next: point resources\app at dsh-island-desktop with a junction, e.g.'
Write-Host ('  cmd /c rmdir "' + (Join-Path $Dst 'resources\app') + '"')
Write-Host ('  cmd /c mklink /J "' + (Join-Path $Dst 'resources\app') + '" "<repo>\dsh-island-desktop"')
