# GitHub kontrol tokenini Windows DPAPI ile sifreleyip saklar (yalnizca bu kullanici cozebilir).
# Bu token Claude'un OAuth tokeni DEGILDIR; yalnizca kontrol deposundaki Issues icin kullanilir.
$home_ = if ($env:CLAUDE_AGENT_HOME) { $env:CLAUDE_AGENT_HOME } else { Join-Path $env:LOCALAPPDATA 'ClaudeAgent' }
New-Item -ItemType Directory -Force $home_ | Out-Null
$secure = Read-Host 'GitHub fine-grained token (gorunmez)' -AsSecureString
if ($secure.Length -eq 0) { throw 'Token bos.' }
$secure | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $home_ 'github-token.dpapi') -Encoding ascii
Write-Host 'Token kaydedildi (DPAPI).'
