param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot)
)

# Keep both existing entry points on the same CET encoding and conflict checks.
& (Join-Path $PSScriptRoot 'Set-DevelopmentBindings.ps1') -GameDirectory $GameDirectory
