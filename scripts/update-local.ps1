<#
.SYNOPSIS
    Rebuild this fork from source and reinstall it into the DSH desktop profile.

.DESCRIPTION
    DeepSeek Harness Desktop owns its `desktop` profile: the CLI refuses it while
    the app is running, so this script must run with DSH fully quit. It builds the
    plugin with the Node/pnpm runtime shipped inside the DSH installation, then
    installs the resulting directory into the profile as a local dependency.

    Order of operations (fail-fast, each step verified):
      1. refuse to run while DSH is alive;
      2. back up the profile manifests and this repo's `lib/`;
      3. BOM gate, typecheck, server build, client build, release promote;
      4. install into the profile with the installation-owned pnpm;
      5. re-read the installed manifest and assert the expected version;
      6. on any failure, restore the backup and report what was rolled back.

.PARAMETER Profile
    DSH profile to update. Defaults to `desktop`.

.PARAMETER DshHome
    Harness home. Defaults to $env:DSH_HOME, else ~/.dsh.

.PARAMETER Force
    Skip the "is DSH running?" guard. Only use when you know the app is closed.

.PARAMETER SkipInstall
    Build and verify only; do not touch the DSH profile.

.PARAMETER SkipTests
    Skip the vitest suite (build + typecheck + BOM still run).

.EXAMPLE
    .\scripts\update-local.ps1
    Build the fork and install it into the desktop profile.

.EXAMPLE
    .\scripts\update-local.ps1 -SkipTests -Verbose
    Quick rebuild without the full test suite.
#>
[CmdletBinding()]
param(
    [string]$Profile = "desktop",
    [string]$DshHome,
    [switch]$Force,
    [switch]$SkipInstall,
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# ---------------------------------------------------------------- constants --
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PackageName = "dsh-coding-subscription-oauth"

function Write-Step([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "  [fail] $Text" -ForegroundColor Red }

# ------------------------------------------------------- locate the runtime --
function Resolve-DshInstall {
    # The desktop app is per-user installed; the app directory holds the runtime.
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness"),
        (Join-Path ${env:ProgramFiles} "DeepSeek Harness")
    )
    foreach ($candidate in $candidates) {
        $runtime = Join-Path $candidate "resources\runtime"
        if (Test-Path $runtime) { return [pscustomobject]@{ App = $candidate; Runtime = $runtime } }
    }
    throw "DeepSeek Harness installation not found. Looked in: $($candidates -join ', ')"
}

function Resolve-Toolchain($runtime) {
    $primary = Join-Path $runtime "primary-runtime\dependencies"
    $node = Join-Path $primary "node\bin\node.exe"
    $pnpm = Join-Path $primary "pnpm\bin\pnpm.mjs"
    if (-not (Test-Path $node)) { throw "Bundled node.exe not found at $node" }
    if (-not (Test-Path $pnpm)) { throw "Bundled pnpm.mjs not found at $pnpm" }
    return [pscustomobject]@{ Node = $node; Pnpm = $pnpm }
}

# The runtime ships the pnpm implementation; ELECTRON_RUN_AS_NODE is what the
# installer itself sets when it drives the same pnpm from the Electron binary.
function Invoke-Pnpm {
    param([string[]]$Arguments, [string]$WorkingDirectory)
    $previous = $env:ELECTRON_RUN_AS_NODE
    $env:ELECTRON_RUN_AS_NODE = "1"
    try {
        Push-Location $WorkingDirectory
        try {
            & $script:Tools.Node $script:Tools.Pnpm @Arguments
            if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
        }
        finally { Pop-Location }
    }
    finally { $env:ELECTRON_RUN_AS_NODE = $previous }
}

function Invoke-Node {
    param([string]$Script, [string[]]$Arguments = @(), [string]$WorkingDirectory = $RepoRoot)
    Push-Location $WorkingDirectory
    try {
        & $script:Tools.Node $Script @Arguments
        if ($LASTEXITCODE -ne 0) { throw "node $Script failed with exit code $LASTEXITCODE" }
    }
    finally { Pop-Location }
}

# ------------------------------------------------------------- DSH is closed --
function Assert-DshStopped {
    $alive = @(Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue)
    if ($alive.Count -eq 0) { Write-Ok "DSH is not running"; return }
    $pids = ($alive | Select-Object -ExpandProperty Id) -join ", "
    if ($Force) { Write-Warn2 "DSH is running (pid $pids); -Force given, continuing anyway"; return }
    throw "DSH is running (pid $pids). Fully quit DeepSeek Harness, then re-run this script. Use -Force only if you are certain it is closed."
}

# ---------------------------------------------------------------- the backup --
function New-Backup {
    $stamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
    $dir = Join-Path $script:ProfileDir "..\..\backups\local-plugin-$stamp"
    $dir = [System.IO.Path]::GetFullPath($dir)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    foreach ($file in @("package.json", "pnpm-lock.yaml", "compatibility.json")) {
        $source = Join-Path $script:ProfileDir $file
        if (Test-Path $source) { Copy-Item $source (Join-Path $dir $file) }
    }

    # `lib/` is what actually runs; a broken build must not stay published.
    $libSource = Join-Path $RepoRoot "lib"
    if (Test-Path $libSource) {
        Copy-Item $libSource (Join-Path $dir "lib") -Recurse
    }
    Write-Ok "backup -> $dir"
    return $dir
}

function Restore-Backup([string]$BackupDir) {
    Write-Warn2 "rolling back from $BackupDir"
    foreach ($file in @("package.json", "pnpm-lock.yaml", "compatibility.json")) {
        $saved = Join-Path $BackupDir $file
        if (Test-Path $saved) { Copy-Item $saved (Join-Path $script:ProfileDir $file) -Force }
    }
    $savedLib = Join-Path $BackupDir "lib"
    if (Test-Path $savedLib) {
        $libTarget = Join-Path $RepoRoot "lib"
        if (Test-Path $libTarget) { Remove-Item $libTarget -Recurse -Force }
        Copy-Item $savedLib $libTarget -Recurse
    }
    Write-Ok "profile manifests and lib/ restored"
}

# ------------------------------------------------------------------ the work --
Write-Host "dsh-coding-subscription-oauth - local update" -ForegroundColor White

$install = Resolve-DshInstall
$script:Tools = Resolve-Toolchain $install.Runtime
Write-Ok "DSH at $($install.App)"
Write-Ok "node $((& $script:Tools.Node --version)) / pnpm $(Get-Content (Join-Path $install.Runtime 'versions.json') -Raw | ConvertFrom-Json | Select-Object -ExpandProperty pnpm)"

if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" } }
$script:ProfileDir = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path (Join-Path $script:ProfileDir "package.json"))) {
    throw "Profile '$Profile' not initialized at $script:ProfileDir (open the app once first)."
}
Write-Ok "profile $Profile at $script:ProfileDir"

Write-Step "1/6 DSH must be closed"
Assert-DshStopped

Write-Step "2/6 backup"
$backup = New-Backup

try {
    Write-Step "3/6 install dependencies"
    Invoke-Pnpm -Arguments @("install", "--ignore-scripts") -WorkingDirectory $RepoRoot
    Write-Ok "dependencies up to date"

    Write-Step "4/6 build and gate"
    Invoke-Node -Script (Join-Path $RepoRoot "build\verify-dsh-bom.mjs")
    Write-Ok "BOM gate passed"

    $tsc = Join-Path $RepoRoot "node_modules\typescript\bin\tsc"
    Invoke-Node -Script $tsc -Arguments @("-b", "tsconfig.host.json", "tsconfig.client.json")
    Write-Ok "typecheck clean"

    Invoke-Node -Script (Join-Path $RepoRoot "build\build-server.mjs")
    Invoke-Node -Script (Join-Path $RepoRoot "build\build-client.mjs")
    Invoke-Node -Script (Join-Path $RepoRoot "build\promote-release.mjs")
    Invoke-Node -Script (Join-Path $RepoRoot "build\verify-release.mjs")
    Write-Ok "release artifacts built and verified"

    if (-not $SkipTests) {
        Write-Step "5/6 tests"
        $vitest = Join-Path $RepoRoot "node_modules\vitest\vitest.mjs"
        # `callback-bridge-bin.spec.ts` builds posix-only LaunchAgent fixture paths
        # with path.join(), so it cannot pass on Windows. Upstream CI is ubuntu-only
        # and never hit this; the exclusion keeps the Windows gate meaningful
        # instead of silently tolerating any failure.
        $arguments = @("run")
        if ($env:OS -eq "Windows_NT") {
            $arguments += @("--exclude", "tests/callback-bridge-bin.spec.ts")
            Write-Warn2 "excluding the macOS LaunchAgent spec (posix paths, cannot pass on Windows)"
        }
        Push-Location $RepoRoot
        try {
            & $script:Tools.Node $vitest @arguments
            if ($LASTEXITCODE -ne 0) { throw "test suite failed" }
        }
        finally { Pop-Location }
        Write-Ok "tests passed"
    }
    else { Write-Step "5/6 tests (skipped)" }

    if ($SkipInstall) {
        Write-Step "6/6 install (skipped)"
        Write-Ok "build finished; the DSH profile was not modified"
        return
    }

    Write-Step "6/6 install into the profile"
    $expected = (Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json).version
    # Use the launcher's own plugin command: it applies the profile's version gate
    # and reconciles the bundle list, with the installation-owned pnpm. It only
    # accepts the reserved desktop profile while the app is not running, which
    # step 1 already guarantees.
    $cli = Join-Path $install.Runtime "cli\bin\dsh.cmd"
    if (-not (Test-Path $cli)) { throw "DSH CLI launcher not found at $cli" }
    & $cli plugin --profile $Profile add "file:$RepoRoot"
    if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

    $installedManifest = Join-Path $script:ProfileDir "node_modules\$PackageName\package.json"
    if (-not (Test-Path $installedManifest)) { throw "install reported success but $installedManifest is missing" }
    $installed = Get-Content $installedManifest -Raw | ConvertFrom-Json
    if ($installed.version -ne $expected) { throw "installed version $($installed.version) does not match built version $expected" }
    Write-Ok "installed $PackageName@$($installed.version) into profile '$Profile'"

    # The profile must now list the plugin, otherwise the next boot silently
    # runs the old code.
    $profileBundles = (Get-Content (Join-Path $script:ProfileDir "package.json") -Raw | ConvertFrom-Json).dsh.profile.bundles
    if ($profileBundles -notcontains $PackageName) {
        Write-Warn2 "$PackageName is not in dsh.profile.bundles; enable it in Settings -> Plugins"
    }
    else { Write-Ok "bundle active in profile" }

    Write-Host "`nDone. Start DeepSeek Harness again." -ForegroundColor Green
    Write-Host "Check Settings -> Coding OAuth for the status card." -ForegroundColor Green
}
catch {
    Write-Fail $_.Exception.Message
    Write-Step "rollback"
    try {
        Restore-Backup $backup
        Write-Fail "update failed; the previous state was restored. Backup kept at $backup"
    }
    catch {
        Write-Fail "rollback also failed: $($_.Exception.Message)"
        Write-Fail "restore manually from $backup"
    }
    exit 1
}
