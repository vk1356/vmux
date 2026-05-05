; Custom NSIS macros pour vMux : ajoute le dossier d'install au PATH user
; pour que `vmux` soit accessible depuis n'importe quel terminal.

!include "WinMessages.nsh"
!include "WordFunc.nsh"

!macro customInstall
  ; Lit le PATH user actuel (HKCU\Environment\PATH).
  ReadRegStr $0 HKCU "Environment" "PATH"

  ${If} $0 == ""
    ; PATH user vide → on crée avec INSTDIR.
    WriteRegExpandStr HKCU "Environment" "PATH" "$INSTDIR"
  ${Else}
    ; Vérifie si $INSTDIR est déjà présent dans le PATH (évite doublons à
    ; chaque réinstallation). ${WordFind} renvoie l'index 1-based ou un
    ; message d'erreur si non trouvé.
    ${WordFind} "$0" "$INSTDIR" "E+1{" $1
    IfErrors notFound found
    notFound:
      ClearErrors
      WriteRegExpandStr HKCU "Environment" "PATH" "$0;$INSTDIR"
      Goto done
    found:
    done:
  ${EndIf}

  ; Notifie tous les processus pour qu'ils rafraîchissent leur env (les
  ; nouveaux terminaux verront vmux dans leur PATH immédiatement).
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  ; On ne retire pas $INSTDIR du PATH à l'uninstall : un PATH qui pointe
  ; vers un dossier inexistant est inoffensif, et la manipulation propre
  ; nécessiterait des includes NSIS supplémentaires fragiles. L'user peut
  ; nettoyer manuellement via "Variables d'environnement" si besoin.
!macroend
