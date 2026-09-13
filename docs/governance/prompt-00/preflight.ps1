[CmdletBinding()]
param(
    [string]$WorkspacePath = 'C:\Proyectos JAVARIEL\RoyalPerformanceTracker',
    [switch]$CheckVersions
)

# Read-only inventory. Does not initialize Git, install dependencies, read secrets,
# contact providers, or certify that any production gate has passed.
$ErrorActionPreference = 'Stop'
$toolNames = @('git', 'node', 'npm.cmd', 'pnpm.cmd', 'flutter', 'dart', 'rustc', 'cargo', 'docker', 'psql', 'gh')
$toolResults = foreach ($toolName in $toolNames) {
    $command = Get-Command $toolName -ErrorAction SilentlyContinue | Select-Object -First 1
    $version = $null
    $versionExitCode = $null
    if ($CheckVersions -and $command -and $toolName -in @('git', 'node', 'npm.cmd', 'pnpm.cmd')) {
        $version = ((& $command.Source --version 2>&1) | Out-String).Trim()
        $versionExitCode = $LASTEXITCODE
    }
    [ordered]@{
        name = $toolName
        available_on_path = [bool]$command
        executable = if ($command) { $command.Source } else { $null }
        version = $version
        version_exit_code = $versionExitCode
    }
}

$exists = Test-Path -LiteralPath $WorkspacePath -PathType Container
$gitPresent = $exists -and (Test-Path -LiteralPath (Join-Path $WorkspacePath '.git'))
$branch = $null
$head = $null
$gitStatus = @()
$gitInspectionError = $null
if ($gitPresent -and (Get-Command git -ErrorAction SilentlyContinue)) {
    $branch = (& git -C $WorkspacePath branch --show-current 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0) {
        $head = (& git -C $WorkspacePath rev-parse --verify HEAD 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { $head = $null }
        # --no-optional-locks avoids an incidental index refresh write.
        $gitStatus = @(& git --no-optional-locks -C $WorkspacePath status --porcelain=v1 --untracked-files=normal 2>&1)
        if ($LASTEXITCODE -ne 0) { $gitInspectionError = 'Git status failed'; $gitStatus = @() }
    } else {
        $gitInspectionError = 'The .git entry exists but the repository could not be inspected'
        $branch = $null
    }
}

$rootEntries = if ($exists) {
    @(Get-ChildItem -LiteralPath $WorkspacePath -Force | ForEach-Object {
        [ordered]@{ name = $_.Name; is_directory = $_.PSIsContainer }
    })
} else { @() }
$sensitiveRootNames = @($rootEntries | Where-Object {
    $_.name -match '^(\.env(?:\..*)?|credentials(?:\..*)?|secrets(?:\..*)?)$|\.(pem|key|pfx|p12|jks|keystore)$'
} | ForEach-Object { $_.name })

[ordered]@{
    checked_at = (Get-Date).ToString('o')
    operation = 'read_only_preflight'
    workspace = [ordered]@{
        requested_path = $WorkspacePath
        exists = $exists
        resolved_path = if ($exists) { (Resolve-Path -LiteralPath $WorkspacePath).Path } else { $null }
        root_entries = @($rootEntries)
        git_present = $gitPresent
        branch = $branch
        head = $head
        git_status = $gitStatus
        git_inspection_error = $gitInspectionError
        potential_sensitive_root_filenames = $sensitiveRootNames
        sensitive_scan_scope = 'Root filenames only; no file contents read. Not a full secret scan.'
    }
    tools = @($toolResults)
    limitations = @(
        'An executable on PATH does not certify a working build or compatibility.',
        'A missing executable on PATH does not prove it is uninstalled.',
        'No provider accounts, credentials, branch protection, CI, RLS, restore, or legal approvals are tested.'
    )
} | ConvertTo-Json -Depth 8
