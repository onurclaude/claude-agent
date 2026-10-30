# Kurulum: veri dizini, yapilandirma, GitHub tokeni, oturum acilisinda otomatik baslatma (Gorev Zamanlayici).
# Yonetici yetkisi GEREKMEZ. Global Claude yapilandirmasina (~\.claude) DOKUNMAZ.
param(
    [string]$Repo,
    [int]$Issue,
    [string]$AllowedUser,
    [switch]$NoStart,
    [switch]$Force    # zaten kuruluysa yeniden kayit/guncelleme
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'ClaudePersistentAgent'

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask -and -not $Force) {
    $m = [regex]::Match(([string]($existingTask.Actions | Select-Object -First 1).Arguments), '-File "([^"]+run\.ps1)"')
    if ($m.Success -and (Test-Path $m.Groups[1].Value)) {
        Write-Host "Zaten kurulu ($($existingTask.State)): $(Split-Path -Parent (Split-Path -Parent $m.Groups[1].Value)). Hicbir sey degistirilmedi. Yeniden kurmak icin -Force."
        exit 0
    }
}
$home_ = if ($env:CLAUDE_AGENT_HOME) { $env:CLAUDE_AGENT_HOME } else { Join-Path $env:LOCALAPPDATA 'ClaudeAgent' }

foreach ($tool in 'node', 'claude') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool bulunamadi. Once kurun (claude: npm i -g @anthropic-ai/claude-code)." }
}
if ([version](node --version).TrimStart('v') -lt [version]'20.0') { throw 'Node.js 20+ gerekli.' }

$globalClaude = Join-Path $env:USERPROFILE '.claude'
if ($home_.StartsWith($globalClaude, [StringComparison]::OrdinalIgnoreCase)) { throw 'Veri dizini global .claude icinde olamaz.' }

New-Item -ItemType Directory -Force $home_, (Join-Path $home_ 'logs'), (Join-Path $home_ 'claude-config'), (Join-Path $home_ 'workspace') | Out-Null
Write-Host "Veri dizini: $home_"

# --- config.json (mevcutsa korunur) ---
$cfgPath = Join-Path $home_ 'config.json'
if (-not (Test-Path $cfgPath)) {
    if (-not $Repo) { $Repo = Read-Host 'GitHub kontrol deposu (sahip/depo, OZEL depo olmali; bos = GitHub kontrolu kapali)' }
    $cfg = Get-Content (Join-Path $root 'config.example.json') -Raw | ConvertFrom-Json
    if ($Repo) {
        if (-not $Issue) { $Issue = [int](Read-Host 'Kontrol konusunun (issue) numarasi (bos/0 = bu bilgisayar icin otomatik yeni issue acilir)') }
        if (-not $AllowedUser) { $AllowedUser = ($Repo -split '/')[0] }
        $cfg.github.repo = $Repo; $cfg.github.issue = $(if ($Issue) { $Issue } else { $null }); $cfg.github.allowedUsers = @($AllowedUser)
    } else { $cfg.github.repo = $null; $cfg.github.issue = $null; $cfg.github.allowedUsers = @() }
    [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    Write-Host "Yapilandirma yazildi: $cfgPath"
}

# --- GitHub tokeni (DPAPI) ---
$tokenPath = Join-Path $home_ 'github-token.dpapi'
if (-not (Test-Path $tokenPath) -and ((Get-Content $cfgPath -Raw | ConvertFrom-Json).github.repo)) {
    Write-Host 'GitHub tokeni: yalnizca bu depodaki Issues (read/write) iznine sahip fine-grained token olusturun.'
    & (Join-Path $PSScriptRoot 'set-github-token.ps1')
}

# --- Issue yoksa bu bilgisayar icin otomatik ac (her bilgisayarin kendi issue'su olur) ---
$cur = Get-Content $cfgPath -Raw | ConvertFrom-Json
if ($cur.github.repo -and -not $cur.github.issue) {
    node (Join-Path $root 'src\cli.js') init-github
    if ($LASTEXITCODE -ne 0) { throw 'Kontrol issue''su acilamadi (token izni: Issues read/write).' }
}

# --- Izolasyon dogrulamasi (kurulumu burada durdurur) ---
node (Join-Path $root 'src\cli.js') verify
if ($LASTEXITCODE -ne 0) { throw 'Izolasyon dogrulanamadi; otomatik baslatma kurulmadi.' }

# --- Oturum acilisinda otomatik baslatma ---
$runScript = Join-Path $PSScriptRoot 'run.ps1'
# conhost --headless: pencere/flash olmadan calisir (Windows 11).
$runArgs = '--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $runScript
if ($env:CLAUDE_AGENT_HOME) { $runArgs += (' -AgentHome "{0}"' -f $env:CLAUDE_AGENT_HOME) }
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $runArgs -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Gorev kaydedildi: $taskName (oturum acildiginda baslar)"

if (-not $NoStart) { Start-ScheduledTask -TaskName $taskName; Write-Host 'Ajan baslatildi. Durum: scripts\status.ps1' }
Write-Host ''
Write-Host 'Ilk giris: GitHub kontrol konusuna "/login" yazin (veya: node src\cli.js request-login).'
