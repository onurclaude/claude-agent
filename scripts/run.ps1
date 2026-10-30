# Gozetmen dongusu: Node ajani cokerse yeniden baslatir. Gorev Zamanlayici bunu gizli pencerede calistirir.
# Cikis kodlari: 3 = izolasyon dogrulanamadi (YENIDEN BASLATMA YOK), 4 = zaten calisiyor.
param([string]$AgentHome)
$ErrorActionPreference = 'Continue'
if ($AgentHome) { $env:CLAUDE_AGENT_HOME = $AgentHome }
$root = Split-Path -Parent $PSScriptRoot
$home_ = if ($env:CLAUDE_AGENT_HOME) { $env:CLAUDE_AGENT_HOME } else { Join-Path $env:LOCALAPPDATA 'ClaudeAgent' }
$logDir = Join-Path $home_ 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$wlog = Join-Path $logDir 'watchdog.log'
function Log($m) { Add-Content -LiteralPath $wlog -Value ("{0} {1}" -f (Get-Date -Format o), $m) }

# "stop" bu PID'yi (komut satirini dogrulayarak) bulup bekcinin tum agacini kapatir.
Set-Content -LiteralPath (Join-Path $home_ 'watchdog.pid') -Value $PID -Encoding ascii

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Log 'node bulunamadi'; exit 1 }

$delay = 5
while ($true) {
    $started = Get-Date
    Log "ajan baslatiliyor"
    & $node (Join-Path $root 'src\cli.js') run
    $code = $LASTEXITCODE
    Log "ajan cikti (kod $code)"
    if ($code -eq 3) { Log 'izolasyon hatasi: yeniden baslatma devre disi'; exit 3 }
    if ($code -eq 4) { Log 'baska ornek calisiyor'; exit 0 }
    if (((Get-Date) - $started).TotalSeconds -gt 300) { $delay = 5 } else { $delay = [Math]::Min($delay * 2, 120) }
    Start-Sleep -Seconds $delay
}
