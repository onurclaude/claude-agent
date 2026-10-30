# Kaldirma: yalnizca bu ajanin gorevi ve sureci. Baska Claude hesaplarina/sureclerine dokunmaz.
param(
    [switch]$PurgeData,   # veri dizinini (izole claude-config dahil) siler
    [switch]$Logout       # silmeden once YALNIZCA izole hesaptan cikis yapar
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'ClaudePersistentAgent'
$home_ = if ($env:CLAUDE_AGENT_HOME) { $env:CLAUDE_AGENT_HOME } else { Join-Path $env:LOCALAPPDATA 'ClaudeAgent' }

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host 'Gorev kaldirildi.'
}
node (Join-Path $root 'src\cli.js') stop

if ($Logout) {
    $env:CLAUDE_CONFIG_DIR = Join-Path $home_ 'claude-config'
    claude auth logout
    Remove-Item Env:CLAUDE_CONFIG_DIR
}
if ($PurgeData) {
    $full = [IO.Path]::GetFullPath($home_)
    $globalClaude = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.claude'))
    if ($full.StartsWith($globalClaude, [StringComparison]::OrdinalIgnoreCase) -or $full.TrimEnd('\') -ieq $env:USERPROFILE.TrimEnd('\')) { throw 'Guvenlik: bu dizin silinmez.' }
    if ((Split-Path -Leaf $full) -ne 'ClaudeAgent' -and -not $env:CLAUDE_AGENT_HOME) { throw 'Beklenmeyen veri dizini; silinmedi.' }
    # Betik veri dizinindeki 'app' klasorunden calisiyor olabilir; gecerli dizin silinemeyecegi icin once ayrilin.
    Set-Location -LiteralPath $env:TEMP
    Remove-Item -LiteralPath $full -Recurse -Force
    Write-Host "Veri dizini silindi: $full"
}
