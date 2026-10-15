; The finish-page checkbox remains available, but creating a desktop link is opt-in.
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
Var CodexOriginalNoShortcutMode

!macro NSIS_HOOK_PREINSTALL
  ; Suppress the template's automatic silent/passive desktop shortcut.
  ; Restore the start-menu choice in POSTINSTALL and the interactive finish-page
  ; choice afterwards; never delete a desktop shortcut the user already has.
  StrCpy $CodexOriginalNoShortcutMode $NoShortcutMode
  StrCpy $NoShortcutMode 1
!macroend

!macro NSIS_HOOK_POSTINSTALL
  StrCpy $NoShortcutMode $CodexOriginalNoShortcutMode
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END
  FileOpen $0 "$INSTDIR\build-kind.json" w
  FileWrite $0 '{"kind":"installed","appId":"dev.codex.speedpet"}'
  FileClose $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\build-kind.json"
!macroend
