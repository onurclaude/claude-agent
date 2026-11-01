# Gorevi ve YALNIZCA bu ajanin surecini durdurur (Claude'un diger surecleri etkilenmez).
$root = Split-Path -Parent $PSScriptRoot
# Devre disi birakilir; aksi halde 5 dakikalik kontrol tetikleyicisi ajani geri baslatir. Tekrar acmak icin start.ps1.
Disable-ScheduledTask -TaskName 'ClaudePersistentAgent' -ErrorAction SilentlyContinue | Out-Null
Stop-ScheduledTask -TaskName 'ClaudePersistentAgent' -ErrorAction SilentlyContinue
node (Join-Path $root 'src\cli.js') stop
