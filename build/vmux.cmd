@echo off
REM Wrapper CLI pour vMux. Lance l'exe en arrière-plan et passe les args.
REM `start ""` titre vide pour ne pas bloquer le terminal et ne pas créer de console.
start "" "%~dp0vMux.exe" %*
