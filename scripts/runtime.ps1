# Compartilhado pelo instalador e iniciador. Compatível com Windows PowerShell 5.1.
function Test-Node24 {
    param([string]$NodePath)
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { return $false }
    try {
        $version = & $NodePath --version 2>$null
        return ($LASTEXITCODE -eq 0 -and $version -match '^v24\.[0-9]+\.[0-9]+$')
    } catch { return $false }
}

function Find-Node24 {
    $localNode = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.minimini-bot\runtime\node\node.exe'
    $candidates = @($localNode)
    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -ne $systemNode) { $candidates += $systemNode.Source }
    foreach ($candidate in $candidates) {
        $npmCli = Join-Path (Split-Path -Parent $candidate) 'node_modules\npm\bin\npm-cli.js'
        if ((Test-Node24 $candidate) -and (Test-Path -LiteralPath $npmCli -PathType Leaf)) {
            return $candidate
        }
    }
    return $null
}
