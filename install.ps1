<#
.SYNOPSIS
  opendeck installer for Windows (PowerShell 5.1 and 7).

.EXAMPLE
  irm https://raw.githubusercontent.com/ptthien97/opencode-opendeck/master/install.ps1 | iex

.EXAMPLE
  .\install.ps1 -Dir "$env:LOCALAPPDATA\opencode-opendeck" -Ref master

.EXAMPLE
  .\install.ps1 -Uninstall -Yes
#>
[CmdletBinding()]
param(
  [string]$Dir = "",
  [string]$Ref = "master",
  [switch]$Dev,
  [switch]$Uninstall,
  [switch]$Yes,
  # Advanced: clone from another URL or local path.
  [string]$Repo = "https://github.com/ptthien97/opencode-opendeck.git"
)

$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Get-ConfigDir {
  $cfg = $null
  if (Get-Command opencode -ErrorAction SilentlyContinue) {
    try {
      $lines = & opencode debug paths 2>$null
      foreach ($line in $lines) {
        if ($line -match '^\s*config\s+(.+?)\s*$') { $cfg = $Matches[1]; break }
      }
    } catch {
      $cfg = $null
    }
  }
  if (-not $cfg) {
    if ($env:XDG_CONFIG_HOME) {
      $cfg = Join-Path $env:XDG_CONFIG_HOME "opencode"
    } else {
      $cfg = Join-Path $env:USERPROFILE ".config\opencode"
    }
  }
  return $cfg
}

function Update-CliJson {
  param(
    [string]$Action,
    [string]$Path,
    [string]$Value
  )

  $data = $null
  if (Test-Path -LiteralPath $Path) {
    $raw = [System.IO.File]::ReadAllText($Path)
    if ($raw.Trim().Length -gt 0) {
      try {
        $data = $raw | ConvertFrom-Json
      } catch {
        throw "cannot parse $Path as JSON: $($_.Exception.Message)"
      }
    }
  }

  if ($null -eq $data) {
    $data = New-Object psobject
    $data | Add-Member -NotePropertyName '$schema' -NotePropertyValue "https://opencode.ai/v2/cli.json"
    $data | Add-Member -NotePropertyName "plugins" -NotePropertyValue @()
  }
  if ($data -is [System.Array]) {
    throw "$Path is not a JSON object"
  }

  $plugins = @()
  if ($data.PSObject.Properties["plugins"] -and $null -ne $data.plugins) {
    $plugins = @($data.plugins)
  }

  $matched = $false
  $kept = New-Object System.Collections.ArrayList
  foreach ($entry in $plugins) {
    $isSame = $false
    if ($entry -is [string]) {
      if ($entry -eq $Value) { $isSame = $true }
    } elseif ($entry -and $entry.PSObject.Properties["package"] -and $entry.package -eq $Value) {
      $isSame = $true
    }
    if ($isSame) {
      $matched = $true
    } else {
      [void]$kept.Add($entry)
    }
  }
  if ($Action -eq "Add" -and -not $matched) {
    [void]$kept.Add($Value)
  }

  $newPlugins = $kept.ToArray()
  if ($data.PSObject.Properties["plugins"]) {
    $data.plugins = $newPlugins
  } else {
    $data | Add-Member -NotePropertyName "plugins" -NotePropertyValue $newPlugins
  }

  if (Test-Path -LiteralPath $Path) {
    $stamp = Get-Date -Format "yyyyMMddHHmmss"
    $backup = "$Path.bak-$stamp"
    Copy-Item -LiteralPath $Path -Destination $backup -Force
    Write-Host "backup: $backup"
  }

  $json = $data | ConvertTo-Json -Depth 20
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $utf8)
}

if (-not $Dir) {
  $Dir = Join-Path $env:LOCALAPPDATA "opencode-opendeck"
}

$configDir = Get-ConfigDir
if (-not $configDir) { throw "could not determine the OpenCode config directory" }
$cliJson = Join-Path $configDir "cli.json"

if ($Uninstall) {
  if (-not (Test-Path -LiteralPath $cliJson)) {
    Write-Host "no $cliJson - nothing to remove"
  } else {
    $pluginPath = $Dir
    if (Test-Path -LiteralPath $Dir) {
      $pluginPath = (Resolve-Path -LiteralPath $Dir).Path -replace '\\', '/'
    }
    Update-CliJson -Action "Remove" -Path $cliJson -Value $pluginPath
    Write-Host "removed $pluginPath from $cliJson"
  }

  if (Test-Path -LiteralPath $Dir) {
    $delete = $true
    if (-not $Yes) {
      $answer = Read-Host "Delete $Dir? [y/N]"
      if ($answer -notmatch '^(y|yes)$') { $delete = $false }
    }
    if ($delete) {
      Remove-Item -LiteralPath $Dir -Recurse -Force
      Write-Host "deleted $Dir"
    } else {
      Write-Host "kept $Dir"
    }
  }

  Write-Host "Restart OpenCode."
  exit 0
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required - install git and re-run"
}
if ($Dev -and -not (Get-Command bun -ErrorAction SilentlyContinue)) {
  throw "bun is required with -Dev - install it from https://bun.sh then re-run"
}

$gitDir = Join-Path $Dir ".git"
if (Test-Path -LiteralPath $gitDir) {
  Write-Host "updating $Dir"
  & git -C $Dir fetch --tags --prune origin
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
  & git -C $Dir checkout $Ref
  if ($LASTEXITCODE -ne 0) { throw "git checkout $Ref failed" }
  & git -C $Dir symbolic-ref -q HEAD 2>$null
  if ($LASTEXITCODE -eq 0) {
    & git -C $Dir pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed" }
  }
} elseif (Test-Path -LiteralPath $Dir) {
  throw "$Dir exists but is not a git checkout"
} else {
  Write-Host "cloning $Repo into $Dir"
  $parent = Split-Path -Parent $Dir
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  & git clone $Repo $Dir
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
  & git -C $Dir checkout $Ref
  if ($LASTEXITCODE -ne 0) { throw "git checkout $Ref failed" }
}

if ($Dev) {
  Push-Location -LiteralPath $Dir
  try {
    & bun install
    if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
    & bun run bundle
    if ($LASTEXITCODE -ne 0) { throw "bun run bundle failed" }
  } finally {
    Pop-Location
  }
}

$dist = Join-Path $Dir "dist\index.js"
if (-not (Test-Path -LiteralPath $dist)) {
  throw "$dist is missing - re-run with -Dev to build it"
}

$pluginPath = (Resolve-Path -LiteralPath $Dir).Path -replace '\\', '/'
if (-not (Test-Path -LiteralPath $configDir)) {
  New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

Update-CliJson -Action "Add" -Path $cliJson -Value $pluginPath
Write-Host "added $pluginPath to $cliJson"

Write-Host "Restart OpenCode, then type /opendeck"
