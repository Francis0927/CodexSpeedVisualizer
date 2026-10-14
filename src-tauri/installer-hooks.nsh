!macro NSIS_HOOK_POSTINSTALL
  FileOpen $0 "$INSTDIR\build-kind.json" w
  FileWrite $0 '{"kind":"installed","appId":"dev.codex.speedpet"}'
  FileClose $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\build-kind.json"
!macroend
