#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Yes,
    [switch]$NoStart,
    [switch]$Help
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectDir = $PSScriptRoot
$tempDir = $null

function Confirm-Step {
    param([string]$Message)
    Write-Host "`n$Message"
    if ($Yes) {
        Write-Host 'Confirmado automaticamente por -Yes.'
        return $true
    }
    $answer = Read-Host 'Continuar? [S/n]'
    return ($answer -match '^(|s|sim|y|yes)$')
}

function Get-Download {
    param([string]$Url, [string]$Destination)
    Write-Host "Baixando $Url"
    # UseBasicParsing evita a dependência do Internet Explorer no PowerShell 5.1.
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 180
}

if ($Help) {
    Write-Host @'
Minimini Bot — instalação para Windows
Uso: powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [-Yes] [-NoStart]
  -Yes      Aceita as etapas automaticamente (a configuração do bot continua interativa).
  -NoStart  Prepara o ambiente sem iniciar o bot.
Baixe e extraia primeiro o ZIP completo do projeto. Não é necessário instalar Git.
'@
    exit 0
}

try {
    foreach ($required in @('package.json', 'package-lock.json', 'scripts\runtime.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $projectDir $required) -PathType Leaf)) {
            throw 'Extraia o ZIP completo do projeto antes de executar install.cmd ou install.ps1.'
        }
    }
    . (Join-Path $projectDir 'scripts\runtime.ps1')
    if (-not (Confirm-Step "Etapa 1/4 — verificar o Windows e as ferramentas. Projeto: $projectDir")) { exit 0 }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Este instalador é para Windows. No Linux/macOS, use bash install.sh.'
    }
    if ([Environment]::OSVersion.Version.Major -lt 10) {
        throw 'O Node.js 24 exige Windows 10/Server 2016 ou superior.'
    }
    # PROCESSOR_ARCHITEW6432 identifica o SO quando PowerShell é um processo x86.
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    switch ($architecture) {
        'AMD64' { $nodeArch = 'x64' }
        'ARM64' { $nodeArch = 'arm64' }
        default { throw "Arquitetura $architecture não suportada; use Windows x64 ou arm64." }
    }
    Write-Host "Sistema detectado: Windows / $nodeArch."
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $nodeFile = Find-Node24
    if ($nodeFile) {
        $nodeVersion = & $nodeFile --version
        if (-not (Confirm-Step "Etapa 2/4 — reutilizar Node.js $nodeVersion de $nodeFile.")) { exit 0 }
    } else {
        $nodeDest = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.minimini-bot\runtime\node'
        if (-not (Confirm-Step "Etapa 2/4 — baixar Node.js 24 oficial, conferir SHA-256 e instalar em $nodeDest. Não é necessário ser administrador.")) { exit 0 }
        $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('minimini-install-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tempDir | Out-Null
        $manifestFile = Join-Path $tempDir 'SHASUMS256.txt'
        Get-Download 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' $manifestFile
        $manifestEntry = Get-Content -LiteralPath $manifestFile | Where-Object {
            $_ -match ( '^([a-fA-F0-9]{64})\s+(node-(v24\.\d+\.\d+)-win-' + $nodeArch + '\.zip)$' )
        } | Select-Object -First 1
        if (-not $manifestEntry -or $manifestEntry -notmatch ( '^([a-fA-F0-9]{64})\s+(node-(v24\.\d+\.\d+)-win-' + $nodeArch + '\.zip)$' )) {
            throw 'Não foi possível localizar um pacote Node.js 24 para este Windows.'
        }
        $expectedHash = $Matches[1]
        $archiveName = $Matches[2]
        $nodeVersion = $Matches[3]
        $archiveFile = Join-Path $tempDir $archiveName
        Get-Download "https://nodejs.org/dist/$nodeVersion/$archiveName" $archiveFile
        Write-Host 'Conferindo SHA-256 do arquivo baixado...'
        $actualHash = (Get-FileHash -LiteralPath $archiveFile -Algorithm SHA256).Hash
        if ($actualHash -ne $expectedHash) { throw 'SHA-256 incorreto; o arquivo baixado não será utilizado. Execute novamente.' }
        Expand-Archive -LiteralPath $archiveFile -DestinationPath $tempDir
        $extractedDir = Join-Path $tempDir ([IO.Path]::GetFileNameWithoutExtension($archiveName))
        if (-not (Test-Node24 (Join-Path $extractedDir 'node.exe'))) {
            throw 'O Node.js baixado não executou. Verifique os requisitos do Windows em docs/installation.md.'
        }
        if (-not (Test-Path -LiteralPath (Join-Path $extractedDir 'node_modules\npm\bin\npm-cli.js'))) {
            throw 'O pacote baixado não contém npm.'
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $nodeDest) -Force | Out-Null
        if (Test-Path -LiteralPath $nodeDest) {
            $nodeBackup = $nodeDest + '.backup-' + [Guid]::NewGuid().ToString('N')
            Move-Item -LiteralPath $nodeDest -Destination $nodeBackup
            Write-Host "Runtime anterior preservado em $nodeBackup."
        }
        Move-Item -LiteralPath $extractedDir -Destination $nodeDest
        $nodeFile = Join-Path $nodeDest 'node.exe'
    }
    $env:PATH = (Split-Path -Parent $nodeFile) + ';' + $env:PATH
    $npmCli = Join-Path (Split-Path -Parent $nodeFile) 'node_modules\npm\bin\npm-cli.js'
    $nodeVersion = & $nodeFile --version
    $npmVersion = & $nodeFile $npmCli --version
    if ($LASTEXITCODE -ne 0) { throw 'O npm não executou corretamente.' }
    Write-Host "Node.js: $nodeVersion | npm: $npmVersion"
    if (-not (Confirm-Step 'Etapa 3/4 — instalar as dependências exatas do package-lock.json com npm ci (a pasta node_modules será recriada).')) { exit 0 }
    Push-Location -LiteralPath $projectDir
    try {
        & $nodeFile $npmCli ci --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependências com npm ci. Verifique as mensagens acima e sua conexão.' }
    } finally { Pop-Location }
    Write-Host 'Dependências instaladas.'
    if ($NoStart) {
        Write-Host "`nEtapa 4/4 — inicialização adiada por -NoStart."
        Write-Host "Inicie quando quiser usando: $projectDir\start.cmd"
    } elseif (Confirm-Step 'Etapa 4/4 — iniciar o Minimini Bot. Na primeira execução, o terminal solicitará o servidor, nome do bot e demais configurações.') {
        & (Join-Path $projectDir 'start.ps1')
        $appExitCode = $LASTEXITCODE
        if ($appExitCode -ne 0) {
            Write-Host "`nO ambiente foi instalado corretamente, mas o bot não pôde iniciar. Corrija a mensagem do aplicativo acima e execute: $projectDir\start.cmd" -ForegroundColor Yellow
            exit $appExitCode
        }
        Write-Host "`nO Minimini Bot foi encerrado. O ambiente continua instalado."
    } else {
        Write-Host "Ambiente pronto. Inicie com: $projectDir\start.cmd"
    }
} catch {
    Write-Host "`nErro: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($tempDir -and (Test-Path -LiteralPath $tempDir)) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force
    }
}
