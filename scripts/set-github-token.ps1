# GitHub kontrol tokenini Windows DPAPI ile sifreleyip saklar (yalnizca bu kullanici cozebilir).
# Bu token Claude'un OAuth tokeni DEGILDIR; yalnizca kontrol deposundaki Issues icin kullanilir.
param([string]$Repo)
$home_ = if ($env:CLAUDE_AGENT_HOME) { $env:CLAUDE_AGENT_HOME } else { Join-Path $env:LOCALAPPDATA 'ClaudeAgent' }
New-Item -ItemType Directory -Force $home_ | Out-Null

$name = if ($Repo) { ($Repo -split '/')[-1] } else { 'kontrol deposu' }
Write-Host ''
Write-Host 'GitHub token gerekli (tek seferlik; ajanin issue yorumlarini okuyup yazabilmesi icin).'
Write-Host '  1. Acin: https://github.com/settings/personal-access-tokens/new'
Write-Host "  2. Repository access: 'Only select repositories' -> $name"
Write-Host "  3. Permissions -> Issues: 'Read and write'  (baska izin vermeyin)"
Write-Host '  4. Generate token -> cikan degeri kopyalayin ve asagiya yapistirin (yazarken gorunmez).'
Write-Host ''
$secure = Read-Host 'GitHub token' -AsSecureString
if ($secure.Length -eq 0) { throw 'Token bos.' }
$secure | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $home_ 'github-token.dpapi') -Encoding ascii
Write-Host 'Token kaydedildi (DPAPI).'
