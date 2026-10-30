# Tek komutla kurulum: eksik on kosullari (Node.js 20+, Claude Code) kurar, projeyi indirir ve install.ps1'i calistirir.
# git GEREKMEZ. GitHub hesabinizla giris GEREKMEZ (yalnizca kontrol deposu icin dar bir token girilir).
#
#   powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/onurclaude/claude-agent/main/scripts/bootstrap.ps1 -OutFile $env:TEMP\ca-bootstrap.ps1; & $env:TEMP\ca-bootstrap.ps1 -Repo onurclaude/claude-agent-control -AllowedUser onurclaude"
#
# Depoyu zaten indirdiyseniz: scripts\bootstrap.ps1 -Repo SAHIP/DEPO
param(
    [string]$Repo,
    [int]$Issue,
    [string]$AllowedUser,
    [string]$Source = 'https://github.com/onurclaude/claude-agent/archive/refs/heads/main.zip',
    [switch]$NoStart,
    [switch]$Update   # zaten kuruluysa projeyi yeniden indirip gunceller (ayarlar/veri/giris korunur)
)
$ErrorActionPreference = 'Stop'

# Kurulu = gorev kayitli VE gorevin gosterdigi run.ps1 diskte var. Gorev var ama dosya yoksa "bozuk" sayilir ve yeniden kurulur.
function Get-Installed {
    $t = Get-ScheduledTask -TaskName 'ClaudePersistentAgent' -ErrorAction SilentlyContinue
    if (-not $t) { return $null }
    $m = [regex]::Match(([string]($t.Actions | Select-Object -First 1).Arguments), '-File "([^"]+run\.ps1)"')
    if (-not $m.Success -or -not (Test-Path $m.Groups[1].Value)) { return $null }
    [pscustomobject]@{ Task = $t; Root = (Split-Path -Parent (Split-Path -Parent $m.Groups[1].Value)) }
}

$existing = Get-Installed
if ($existing -and -not $Update) {
    Write-Host "Claude Persistent Agent zaten kurulu: $($existing.Root)"
    Write-Host "Gorev durumu: $($existing.Task.State)"
    if ($existing.Task.State -ne 'Running') { Start-ScheduledTask -TaskName 'ClaudePersistentAgent'; Write-Host 'Gorev calismiyordu; baslatildi.' }
    Write-Host 'Hicbir sey degistirilmedi. Guncellemek icin: -Update   |   Durum: scripts\status.ps1'
    exit 0
}
if (-not $existing -and (Get-ScheduledTask -TaskName 'ClaudePersistentAgent' -ErrorAction SilentlyContinue)) {
    Write-Host 'Kayitli gorev var ama dosyalari eksik/bozuk; yeniden kuruluyor.'
}

function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $env:APPDATA 'npm')
}
function Node-Ok {
    if (-not (Has node)) { return $false }
    return [version]((node --version).TrimStart('v')) -ge [version]'20.0'
}

Write-Host '== Claude Persistent Agent kurulumu =='

# 1) Node.js 20+
if (-not (Node-Ok)) {
    if (-not (Has winget)) { throw 'winget bulunamadi. Node.js 20+ kurun: https://nodejs.org' }
    Write-Host 'Node.js LTS kuruluyor (yonetici onayi isteyebilir)...'
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
    if (-not (Node-Ok)) { throw 'Node.js kuruldu ama bu pencerede gorunmuyor. Yeni bir PowerShell acip komutu tekrar calistirin.' }
}
Write-Host ("Node.js {0} tamam." -f (node --version))

# 2) Claude Code
if (-not (Has claude)) {
    Write-Host 'Claude Code kuruluyor (npm)...'
    npm install -g '@anthropic-ai/claude-code'
    Refresh-Path
    if (-not (Has claude)) { throw 'claude komutu bulunamadi. Yeni bir PowerShell acip komutu tekrar calistirin.' }
}
Write-Host ("Claude Code {0} tamam." -f (claude --version))

# 3) Proje dizini: depodan calisiyorsa onu kullan, degilse indir (veri dizininden ayri 'app' klasoru)
$root = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\src\cli.js'))) {
    $root = Split-Path -Parent $PSScriptRoot
} else {
    $dataDir = if ($env:CLAUDE_AGENT_HOME) { $env:CLAUDE_AGENT_HOME } else { Join-Path $env:LOCALAPPDATA 'ClaudeAgent' }
    $root = Join-Path $dataDir 'app'
    $tmp = Join-Path $env:TEMP ('claude-agent-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
        Write-Host 'Proje indiriliyor...'
        $zip = Join-Path $tmp 'src.zip'
        Invoke-WebRequest -Uri $Source -OutFile $zip -UseBasicParsing
        Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
        $top = Get-ChildItem $tmp -Directory | Select-Object -First 1
        if (-not $top -or -not (Test-Path (Join-Path $top.FullName 'src\cli.js'))) { throw 'Indirilen arsiv beklenen projeyi icermiyor.' }
        # Eski surumu yalnizca yeni arsiv dogrulandiktan sonra degistir (veri/ayarlar ayri dizinde, korunur)
        Get-ScheduledTask -TaskName 'ClaudePersistentAgent' -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
        if (Test-Path (Join-Path $root 'src\cli.js')) { node (Join-Path $root 'src\cli.js') stop }
        if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force }
        New-Item -ItemType Directory -Force (Split-Path -Parent $root) | Out-Null
        Move-Item -LiteralPath $top.FullName -Destination $root
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Write-Host "Proje dizini: $root"

# 4) Asil kurulum (yapilandirma, token, izolasyon dogrulamasi, otomatik baslatma)
$installArgs = @{}
if ($Repo) { $installArgs.Repo = $Repo }
if ($Issue) { $installArgs.Issue = $Issue }
if ($AllowedUser) { $installArgs.AllowedUser = $AllowedUser }
if ($NoStart) { $installArgs.NoStart = $true }
$installArgs.Force = $true   # kurulu-mu kontrolu yukarida yapildi; buraya gelindiyse kurulum/guncelleme istenmistir
& (Join-Path $root 'scripts\install.ps1') @installArgs
