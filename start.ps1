#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$appArguments = $args
try {
    . (Join-Path $PSScriptRoot 'scripts\runtime.ps1')
    $nodeFile = Find-Node24
    if (-not $nodeFile) { throw 'Node.js 24 não encontrado. Execute install.cmd novamente.' }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\mineflayer') -PathType Container)) {
        throw 'Dependências ausentes. Execute install.cmd novamente.'
    }
    $env:PATH = (Split-Path -Parent $nodeFile) + ';' + $env:PATH
    Push-Location -LiteralPath $PSScriptRoot
    try {
        & $nodeFile (Join-Path $PSScriptRoot 'src\index.js') @appArguments
        $appExitCode = $LASTEXITCODE
    } finally { Pop-Location }
    exit $appExitCode
} catch {
    Write-Host "Erro: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
