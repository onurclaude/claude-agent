# Telefonda onayladiktan sonra ekranda gorunen Claude giris kodunu BU BILGISAYARDA girin.
# Kod GitHub'a gitmez; yalnizca yerel dosya -> Claude CLI stdin yolundan gecer.
$root = Split-Path -Parent $PSScriptRoot
node (Join-Path $root 'src\cli.js') submit-code
