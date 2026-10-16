<#
.SYNOPSIS
  Deploy (fresh install or update) the orchestration kit into this Windows user's ~/.claude.

.DESCRIPTION
  Author: maintained with Claude Code for the frontier-model orchestration setup.

  Steps: verify Node >= 18 -> prompt-freeze check (prompts must stay byte-identical during the
  evaluation period) -> claude/global/install.mjs, which replaces every kit-managed file under
  ~/.claude/orchestration, the two subagents, the managed CLAUDE.md block and the permission
  rules (backing up CLAUDE.md and settings.json first). runs/ and telemetry/ are never touched.
  Fresh installs and updates use the same path. Start a new Claude Code session afterwards.

.PARAMETER Check
  Preflight only (Codex CLI, login, configured model ids, codex plugin). Changes nothing.
.PARAMETER DryRun
  Show what would change without changing anything.
.PARAMETER AllowPromptChange
  Skip the prompt-freeze check. Only after the evaluation is closed (then re-baseline with
  'node claude/global/test/prompt-freeze.mjs --update' and commit the golden files).
.PARAMETER Uninstall
  Remove everything the kit installed, keeping runs/ and telemetry/.
.PARAMETER Purge
  With -Uninstall, also delete runs/ and telemetry/.

.EXAMPLE
  .\deploy.ps1 -Check
  .\deploy.ps1
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$DryRun,
  [switch]$AllowPromptChange,
  [switch]$Uninstall,
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
$Installer = Join-Path $RepoRoot 'claude\global\install.mjs'
$PromptFreeze = Join-Path $RepoRoot 'claude\global\test\prompt-freeze.mjs'
$MinimumNodeMajor = 18

function Assert-NodeVersion {
  # Input: none. Output: none; throws when node is missing or older than $MinimumNodeMajor,
  # because install.mjs and the wrapper use syntax Node 10-16 cannot parse.
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) { throw "node not found on PATH. Install Node.js $MinimumNodeMajor+ first." }
  $version = (& node --version).Trim()
  $major = [int]($version.TrimStart('v').Split('.')[0])
  if ($major -lt $MinimumNodeMajor) { throw "node $version is too old; Node.js $MinimumNodeMajor+ is required." }
  Write-Host "node $version ($($node.Source))"
}

function Invoke-NodeStep {
  # Input: step label and node arguments. Output: none; throws on a non-zero exit code so the
  # deploy stops before touching ~/.claude when a check fails.
  param([string]$Label, [string[]]$NodeArgs)
  Write-Host "== $Label"
  & node @NodeArgs
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)." }
}

Assert-NodeVersion
$commit = (& git -C $RepoRoot rev-parse --short HEAD 2>$null)
if ($commit) { Write-Host "kit commit $commit" }

if ($Uninstall) {
  $uninstallArgs = @($Installer, '--uninstall')
  if ($Purge) { $uninstallArgs += '--purge' }
  if ($DryRun) { $uninstallArgs += '--dry-run' }
  Invoke-NodeStep -Label 'uninstall' -NodeArgs $uninstallArgs
  exit 0
}

if ($Check) {
  Invoke-NodeStep -Label 'preflight' -NodeArgs @($Installer, '--check')
  exit 0
}

if ($AllowPromptChange) {
  Write-Warning 'Prompt-freeze check skipped (-AllowPromptChange).'
} else {
  Invoke-NodeStep -Label 'prompt freeze' -NodeArgs @($PromptFreeze)
}

$installArgs = @($Installer)
if ($DryRun) { $installArgs += '--dry-run' }
Invoke-NodeStep -Label 'install' -NodeArgs $installArgs

if (-not $DryRun) {
  # USERPROFILE, not $HOME: it is what Node's os.homedir() (and so install.mjs) resolves on Windows.
  Invoke-NodeStep -Label 'effective model selection' -NodeArgs @((Join-Path $env:USERPROFILE '.claude\orchestration\scripts\codex-delegate.mjs'), 'models')
  Write-Host 'Deployed. Start a NEW Claude Code session so the agents and CLAUDE.md block reload.'
}
