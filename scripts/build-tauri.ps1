param(
  [switch]$Unsigned,
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$root = Split-Path -Parent $PSScriptRoot
$defaultSigningDirectory = Join-Path $env:LOCALAPPDATA 'Stremiro\signing'
$defaultPrivateKeyPath = Join-Path $defaultSigningDirectory 'tauri-updater.key'
$defaultPasswordPath = Join-Path $defaultSigningDirectory 'tauri-updater-password.txt'
$defaultPasswordDpapiPath = Join-Path $defaultSigningDirectory 'tauri-updater-password.dpapi'
$injectedPrivateKey = $false
$injectedPrivateKeyPassword = $false

function Resolve-SigningPath {
  param(
    [string]$OverridePath,
    [string]$DefaultPath
  )

  # An explicit env override is a promise: it must name an existing file.
  # Falling back to a different file would silently sign with the wrong
  # key material, so a missing override fails instead.
  if (-not [string]::IsNullOrWhiteSpace($OverridePath)) {
    if (Test-Path -LiteralPath $OverridePath -PathType Leaf) {
      return $OverridePath
    }
    throw "Explicit signing path does not exist or is not a file: $OverridePath"
  }

  if (-not [string]::IsNullOrWhiteSpace($DefaultPath) -and (Test-Path -LiteralPath $DefaultPath -PathType Leaf)) {
    return $DefaultPath
  }

  return $null
}

function Read-SigningKeyText {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  # Trim like the password path, then validate: a truncated or wrong-format
  # key file should fail here, not mid-build inside the signer.
  $content = (Get-Content -Raw $Path).Trim()
  if ([string]::IsNullOrWhiteSpace($content)) {
    throw "Updater signing key file is empty: $Path"
  }

  try {
    [void][Convert]::FromBase64String($content)
  } catch {
    throw "Updater signing key file is not valid base64 (expected a 'tauri signer generate' key): $Path"
  }

  return $content
}

function Read-DpapiProtectedText {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $encoded = (Get-Content -Raw $Path).Trim()
  if ([string]::IsNullOrWhiteSpace($encoded)) {
    return $null
  }

  $protectedBytes = [Convert]::FromBase64String($encoded)
  $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protectedBytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )

  return [System.Text.Encoding]::UTF8.GetString($plainBytes)
}

function Assert-NativeRuntimePair {
  # Single verified libmpv/wrapper pair: lib/ is the packaged set
  # (tauri.conf resources ship lib/*.dll). A dev-time root copy may exist,
  # but a hash mismatch means one side is stale and packaging must fail
  # rather than ship or test against mixed natives.
  $stagedDir = Join-Path $root 'src-tauri\lib'
  $stagedMpv = Join-Path $stagedDir 'libmpv-2.dll'
  $stagedWrapper = Join-Path $stagedDir 'libmpv-wrapper.dll'
  $devMpv = Join-Path $root 'src-tauri\libmpv-2.dll'
  $devWrapper = Join-Path $root 'src-tauri\libmpv-wrapper.dll'

  foreach ($required in @($stagedMpv, $stagedWrapper)) {
    if (-not (Test-Path -LiteralPath $required)) {
      throw "Missing native runtime file: $required. Restore the verified libmpv/wrapper pair before packaging."
    }
  }

  $stagedDlls = @(Get-ChildItem -LiteralPath $stagedDir -Filter '*.dll' -ErrorAction Stop)
  if ($stagedDlls.Count -ne 2) {
    throw "Expected exactly one libmpv-2.dll plus one libmpv-wrapper.dll in $stagedDir, found $($stagedDlls.Count). Remove stale duplicates before packaging."
  }

  # Hash each file once: these are ~95 MB natives, so a single pass each.
  $hashes = @{}
  foreach ($candidate in @($stagedMpv, $stagedWrapper, $devMpv, $devWrapper)) {
    if (-not (Test-Path -LiteralPath $candidate)) {
      continue
    }
    try {
      $stream = [System.IO.File]::Open($candidate, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
      $stream.Close()
    } catch {
      throw "Native runtime file is locked (close the running app/dev server first): $candidate"
    }
    $hashes[$candidate] = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
  }

  foreach ($pair in @(@($stagedMpv, $devMpv), @($stagedWrapper, $devWrapper))) {
    if (-not $hashes.ContainsKey($pair[1])) {
      continue
    }
    if ($hashes[$pair[0]] -ne $hashes[$pair[1]]) {
      throw "Stale duplicate native pair: $($pair[1]) hash $($hashes[$pair[1]]) does not match staged $($pair[0]) hash $($hashes[$pair[0]]). Record provenance, sync the verified pair to both locations, then rebuild."
    }
  }

  Write-Host "Native runtime pair verified: libmpv-2.dll $($hashes[$stagedMpv]), libmpv-wrapper.dll $($hashes[$stagedWrapper])"
}

Push-Location $root

try {
  if ($Clean) {
    & (Join-Path $PSScriptRoot 'clean-tauri.ps1')
  }

  Assert-NativeRuntimePair

  if ($Unsigned) {
    # PowerShell 5.1 strips literal quotes from native-command arguments —
    # \" survives CommandLineToArgvW and reaches cargo as real JSON quotes.
    & cargo tauri build --ci --bundles nsis --config '{\"bundle\":{\"createUpdaterArtifacts\":false}}' -- --locked
    exit $LASTEXITCODE
  }

  if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
    $resolvedPrivateKeyPath = Resolve-SigningPath -OverridePath $env:TAURI_SIGNING_PRIVATE_KEY_PATH -DefaultPath $defaultPrivateKeyPath

    if ([string]::IsNullOrWhiteSpace($resolvedPrivateKeyPath)) {
      throw "Signed builds require TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PATH, or a local key at $defaultPrivateKeyPath."
    }

    $env:TAURI_SIGNING_PRIVATE_KEY = Read-SigningKeyText -Path $resolvedPrivateKeyPath
    $injectedPrivateKey = $true
    Write-Host "Updater signing key loaded from $resolvedPrivateKeyPath"
  }

  if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
    # Resolve only the selected branch: an explicit plaintext path wins, then
    # an explicit DPAPI path, then the default plaintext/DPAPI pair. Resolving
    # an unselected override would fail on a file this run never uses.
    $resolvedPasswordPath = $null
    $resolvedDpapiPasswordPath = $null
    if (-not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD_PATH)) {
      $resolvedPasswordPath = Resolve-SigningPath -OverridePath $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD_PATH
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD_DPAPI_PATH)) {
      $resolvedDpapiPasswordPath = Resolve-SigningPath -OverridePath $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD_DPAPI_PATH
    }
    else {
      $resolvedPasswordPath = Resolve-SigningPath -DefaultPath $defaultPasswordPath
      if ([string]::IsNullOrWhiteSpace($resolvedPasswordPath)) {
        $resolvedDpapiPasswordPath = Resolve-SigningPath -DefaultPath $defaultPasswordDpapiPath
      }
    }

    if (-not [string]::IsNullOrWhiteSpace($resolvedPasswordPath)) {
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw $resolvedPasswordPath).Trim()
      $injectedPrivateKeyPassword = $true
      Write-Host "Updater signing password loaded from $resolvedPasswordPath"
    }
    elseif (-not [string]::IsNullOrWhiteSpace($resolvedDpapiPasswordPath)) {
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-DpapiProtectedText -Path $resolvedDpapiPasswordPath
      $injectedPrivateKeyPassword = $true
      Write-Host "Updater signing password loaded from DPAPI file $resolvedDpapiPasswordPath"
    }

    if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
      throw 'Signed builds require TAURI_SIGNING_PRIVATE_KEY_PASSWORD, TAURI_SIGNING_PRIVATE_KEY_PASSWORD_PATH, or TAURI_SIGNING_PRIVATE_KEY_PASSWORD_DPAPI_PATH.'
    }
  }

  & cargo tauri build --ci --bundles nsis -- --locked
  exit $LASTEXITCODE
}
finally {
  if ($injectedPrivateKey) {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
  }

  if ($injectedPrivateKeyPassword) {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  }

  Pop-Location
}