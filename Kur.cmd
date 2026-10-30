@echo off
rem Claude Persistent Agent - cift tikla kurulum.
rem Bu dosyayi tek basina indirip calistirabilirsiniz: guncel kurulum betigini GitHub'dan alir,
rem eksik Node.js / Claude Code'u kurar, ajani %LOCALAPPDATA%\ClaudeAgent altina yukler.
rem Zaten kuruluysa hicbir sey degistirmez. Guncellemek icin: Kur.cmd -Update
setlocal
title Claude Persistent Agent - Kurulum
set "BOOT=%TEMP%\claude-agent-bootstrap.ps1"

echo Kurulum dosyasi indiriliyor...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/onurclaude/claude-agent/main/scripts/bootstrap.ps1' -OutFile '%BOOT%'"
if errorlevel 1 (
  echo.
  echo Indirme basarisiz. Internet baglantinizi kontrol edip tekrar deneyin.
  goto :end
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%BOOT%" %*
if errorlevel 1 (
  echo.
  echo Kurulum tamamlanamadi. Yukaridaki hata mesajina bakin.
) else (
  echo.
  echo Islem bitti.
)

:end
echo.
pause
endlocal
