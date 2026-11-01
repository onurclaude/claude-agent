$ErrorActionPreference = 'Stop'
Enable-ScheduledTask -TaskName 'ClaudePersistentAgent' | Out-Null
Start-ScheduledTask -TaskName 'ClaudePersistentAgent'
Write-Host 'Baslatildi. Durum icin: scripts\status.ps1'
