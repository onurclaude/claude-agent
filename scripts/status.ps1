$root = Split-Path -Parent $PSScriptRoot
Get-ScheduledTask -TaskName 'ClaudePersistentAgent' -ErrorAction SilentlyContinue | Select-Object TaskName, State | Format-Table -AutoSize
node (Join-Path $root 'src\cli.js') status
