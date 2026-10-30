# Gorevi ve YALNIZCA bu ajanin surecini durdurur (Claude'un diger surecleri etkilenmez).
$root = Split-Path -Parent $PSScriptRoot
Stop-ScheduledTask -TaskName 'ClaudePersistentAgent' -ErrorAction SilentlyContinue
node (Join-Path $root 'src\cli.js') stop
