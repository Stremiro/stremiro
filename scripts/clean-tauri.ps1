$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$paths = @(
  (Join-Path $root 'dist'),
  (Join-Path $root 'src-tauri\target')
)

foreach ($path in $paths) {
  if (Test-Path $path) {
    Remove-Item $path -Recurse -Force
    Write-Host "Removed $path"
  }
}

Write-Host 'Tauri build artifacts cleaned.'