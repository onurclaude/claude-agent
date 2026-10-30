@echo off
rem Claude Persistent Agent - cift tikla kaldirma.
rem Yalnizca bu ajani kaldirir; diger Claude hesaplarina ve islemlerine dokunmaz.
setlocal
title Claude Persistent Agent - Kaldirma

set "UNINSTALL=%LOCALAPPDATA%\ClaudeAgent\app\scripts\uninstall.ps1"
if not exist "%UNINSTALL%" set "UNINSTALL=%~dp0scripts\uninstall.ps1"
if not exist "%UNINSTALL%" (
  echo Kaldirma betigi bulunamadi. Ajan bu bilgisayarda kurulu olmayabilir.
  goto :end
)

echo Ajan durdurulacak ve oturum acilisinda baslama gorevi silinecek.
echo.
echo Ajanin Claude girisi, ayarlari ve loglari da silinsin mi?
echo   E = Evet, tamamen kaldir (giris cikisi yapilir, %LOCALAPPDATA%\ClaudeAgent silinir)
echo   H = Hayir, yalnizca durdur ve gorevi kaldir (veri korunur)
choice /C EH /N /M "Seciminiz (E/H): "
if errorlevel 2 (set "FLAGS=") else (set "FLAGS=-Logout -PurgeData")

powershell -NoProfile -ExecutionPolicy Bypass -File "%UNINSTALL%" %FLAGS%
if errorlevel 1 (
  echo.
  echo Kaldirma tamamlanamadi. Yukaridaki hata mesajina bakin.
) else (
  echo.
  echo Kaldirma tamamlandi.
)

:end
echo.
pause
endlocal
