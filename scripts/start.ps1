$ErrorActionPreference = 'Stop'
Start-ScheduledTask -TaskName 'ClaudePersistentAgent'
Write-Host 'Baslatildi. Durum icin: scripts\status.ps1'
