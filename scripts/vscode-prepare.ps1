#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectDir = Split-Path -Parent $PSScriptRoot

try {
    . (Join-Path $PSScriptRoot 'runtime.ps1')
    Write-Host 'Preparando o Minimini Bot para execução pelo VS Code...'
    $nodeFile = Find-Node24
    if (-not $nodeFile) {
        Write-Host 'Node.js 24 não foi encontrado. O instalador completo será executado agora.'
        & (Join-Path $projectDir 'install.ps1') -Yes -NoStart
        if ($LASTEXITCODE -ne 0) { throw 'O instalador não conseguiu preparar o ambiente.' }
        $nodeFile = Find-Node24
        if (-not $nodeFile) { throw 'O Node.js 24 não ficou disponível após a instalação.' }
    }

    $nodeDir = Split-Path -Parent $nodeFile
    $npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
    $nodeModulesLock = Join-Path $projectDir 'node_modules\.package-lock.json'
    $packageFile = Join-Path $projectDir 'package.json'
    $lockFile = Join-Path $projectDir 'package-lock.json'
    Write-Host "Node.js encontrado: $(& $nodeFile --version)"
    Write-Host 'Verificando todas as dependências do package.json...'

    $needsInstall = -not (Test-Path -LiteralPath $nodeModulesLock -PathType Leaf)
    if (-not $needsInstall) {
        $installedAt = (Get-Item -LiteralPath $nodeModulesLock).LastWriteTimeUtc
        $needsInstall = (Get-Item -LiteralPath $packageFile).LastWriteTimeUtc -gt $installedAt -or
            (Get-Item -LiteralPath $lockFile).LastWriteTimeUtc -gt $installedAt
    }
    if (-not $needsInstall) {
        Push-Location -LiteralPath $projectDir
        try {
            & $nodeFile $npmCli ls --all --silent *> $null
            $needsInstall = $LASTEXITCODE -ne 0
        } finally { Pop-Location }
    }

    if ($needsInstall) {
        Write-Host 'Dependências ausentes, inválidas ou desatualizadas. Executando npm ci...'
        Push-Location -LiteralPath $projectDir
        try {
            & $nodeFile $npmCli ci --no-fund --no-audit
            if ($LASTEXITCODE -ne 0) { throw 'npm ci não conseguiu instalar as dependências.' }
            & $nodeFile $npmCli ls --all --silent *> $null
            if ($LASTEXITCODE -ne 0) { throw 'A árvore de dependências continuou inválida após npm ci.' }
        } finally { Pop-Location }
        Write-Host 'Todas as dependências foram instaladas e validadas.'
    } else {
        Write-Host 'Todas as dependências já estão instaladas e válidas.'
    }
    Write-Host 'Preparação concluída. O bot será aberto no terminal integrado do VS Code.'
} catch {
    Write-Host "Erro: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
