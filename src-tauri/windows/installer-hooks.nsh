!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "Stremiro"

  ReadRegStr $R0 SHCTX "Software\stremiro\Stremiro" ""
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
  ${EndIf}
!macroend
