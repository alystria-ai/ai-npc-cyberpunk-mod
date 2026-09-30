$ErrorActionPreference = 'Stop'

function Resolve-DevelopmentPath([string]$Root, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or
        $Relative -match '(^|[\\/])\.\.([\\/]|$)') { throw 'Unsafe development manifest path.' }
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    $result = [IO.Path]::GetFullPath((Join-Path $prefix $Relative))
    if (-not $result.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Development path escaped its root.' }
    return $result
}

function Get-DevelopmentManifest([string]$ProjectDirectory) {
    $path = Join-Path $ProjectDirectory 'scripts/development-files.json'
    $manifest = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($manifest.version -ne 1 -or -not $manifest.files -or -not $manifest.retiredNative) { throw 'Invalid development manifest.' }
    $seen = @{}
    foreach ($file in $manifest.files) {
        $null = Resolve-DevelopmentPath $ProjectDirectory $file.source
        $null = Resolve-DevelopmentPath $ProjectDirectory $file.target
        if ($seen.ContainsKey($file.target)) { throw 'Duplicate development target.' }
        $seen[$file.target] = $true
    }
    # Quarantine is deliberately limited to this retired, crash-prone component.
    # An edited manifest must never authorize moving arbitrary game files.
    if (@($manifest.retiredNative).Count -ne 1 -or
        $manifest.retiredNative[0] -cne 'r6/scripts/CyberpunkConvai/KnowledgeState.reds') {
        throw 'Unrecognized retired native component.'
    }
    return $manifest
}

function Get-DevelopmentFiles([string]$ProjectDirectory, [string]$GameDirectory, [switch]$LuaOnly) {
    $manifest = Get-DevelopmentManifest $ProjectDirectory
    foreach ($file in $manifest.files) {
        if ($LuaOnly -and [IO.Path]::GetExtension($file.source) -notin @('.lua', '.json')) { continue }
        [pscustomobject]@{
            From = (Resolve-DevelopmentPath $ProjectDirectory $file.source)
            To = (Resolve-DevelopmentPath $GameDirectory $file.target)
            Relative = $file.target
            Source = $file.source
        }
    }
}

function Copy-DevelopmentNativeStage([string]$ProjectDirectory, [string]$ScriptsDirectory) {
    $manifest = Get-DevelopmentManifest $ProjectDirectory
    $prefix = 'r6/scripts/CyberpunkConvai/'
    $stage = Resolve-DevelopmentPath $ScriptsDirectory 'CyberpunkConvai'
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    # Keep the copied third-party scripts, but replace only our staged source
    # set. No delete or move is performed in the actual game directory here.
    foreach ($file in @(Get-ChildItem -LiteralPath $stage -File -Filter '*.reds')) {
        Remove-Item -LiteralPath $file.FullName
    }
    foreach ($file in $manifest.files) {
        if (-not $file.target.StartsWith($prefix, [StringComparison]::Ordinal)) { continue }
        $source = Resolve-DevelopmentPath $ProjectDirectory $file.source
        $destination = Resolve-DevelopmentPath $stage $file.target.Substring($prefix.Length)
        if (-not [IO.File]::Exists($source)) { throw "Missing native source: $($file.source)" }
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
}

Export-ModuleMember -Function Resolve-DevelopmentPath, Get-DevelopmentManifest, Get-DevelopmentFiles, Copy-DevelopmentNativeStage
