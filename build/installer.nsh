; Custom NSIS macros pour vMux : ajoute le dossier d'install au PATH user
; pour que `vmux` soit accessible depuis n'importe quel terminal.

!include "WinMessages.nsh"

!macro customInstall
  ; Ajoute le dossier d'install au PATH user (HKCU\Environment\PATH).
  ; On vérifie d'abord que le dossier n'est pas déjà présent pour éviter
  ; les doublons en cas de réinstallation.
  ReadRegStr $0 HKCU "Environment" "PATH"
  ${If} $0 == ""
    WriteRegExpandStr HKCU "Environment" "PATH" "$INSTDIR"
  ${Else}
    ; Vérifie si $INSTDIR est déjà dans $0
    ${StrLoc} $1 "$0" "$INSTDIR" ">"
    ${If} $1 == ""
      WriteRegExpandStr HKCU "Environment" "PATH" "$0;$INSTDIR"
    ${EndIf}
  ${EndIf}
  ; Notifie tous les processus pour qu'ils rafraîchissent leur env (les
  ; nouveaux terminaux verront vmux dans leur PATH immédiatement).
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  ; Retire le dossier d'install du PATH user.
  ReadRegStr $0 HKCU "Environment" "PATH"
  ${If} $0 != ""
    ${WordReplace} "$0" ";$INSTDIR" "" "+" $1
    ${WordReplace} "$1" "$INSTDIR;" "" "+" $2
    ${WordReplace} "$2" "$INSTDIR" "" "+" $3
    WriteRegExpandStr HKCU "Environment" "PATH" "$3"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend
