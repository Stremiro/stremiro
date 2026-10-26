!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "Stremiro"

  ReadRegStr $R0 SHCTX "Software\stremiro\Stremiro" ""
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\stremiro" "" "URL:Stremiro link"
  WriteRegStr SHCTX "Software\Classes\stremiro" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\stremiro\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\stremiro\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\stremiro"
!macroend
