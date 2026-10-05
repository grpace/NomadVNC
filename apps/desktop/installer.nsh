; NomadVNC NSIS additions. Included by electron-builder for the
; assisted installer and its uninstaller.
;
; Install already asks for per-user vs all-users and the folder.
; Uninstall asks whether to delete this account's NomadVNC data.
; Silent uninstalls and in-place updates must not ask and must not delete it.

!include LogicLib.nsh

!macro customUnInstall
  ${if} ${isUpdated}
  ${orIf} ${Silent}
    Goto nomadDeleteDataDone
  ${endif}

  MessageBox MB_YESNO|MB_ICONQUESTION "Remove NomadVNC settings and saved machines for this Windows account?$\r$\n$\r$\nThe program is removed either way." /SD IDNO IDYES nomadDeleteDataYes IDNO nomadDeleteDataDone
  nomadDeleteDataYes:
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  nomadDeleteDataDone:
!macroend
