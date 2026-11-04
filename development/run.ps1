$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$bundledPython = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
if (Test-Path -LiteralPath $bundledPython) {
    & $bundledPython -m aquarium_sim.server @args
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 -m aquarium_sim.server @args
} else {
    & python -m aquarium_sim.server @args
}

