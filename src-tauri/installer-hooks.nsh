; The finish-page checkbox remains available, but creating a desktop link is opt-in.
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_CUSTOMFUNCTION_GUIINIT CodexUseInPlaceUpdate
Var CodexOriginalNoShortcutMode

Function CodexUseInPlaceUpdate
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $0
  IfErrors 0 in_place_done
  IfFileExists "$INSTDIR\Codex Speed Pet.exe" 0 in_place_done
  ClearErrors
  FileOpen $0 "$INSTDIR\build-kind.json" r
  IfErrors in_place_done
  FileRead $0 $1
  FileClose $0
  StrCmp $1 '{"kind":"installed","appId":"dev.codex.speedpet"}' 0 in_place_done
  ; Manual upgrades use the same overwrite mode as application-triggered updates.
  ${GetParameters} $0
  ClearErrors
  ExecWait '"$EXEPATH" /P /UPDATE /R /NS $0 /D=$INSTDIR' $1
  IfErrors in_place_failed
  SetErrorLevel $1
  Quit
  in_place_failed:
  MessageBox MB_OK|MB_ICONSTOP "Could not start the in-place update. Please retry." /SD IDOK
  SetErrorLevel 1
  Quit
  in_place_done:
FunctionEnd

!macro CodexRemoveRuntime suffix
  IfFileExists "$INSTDIR\SpeedPet.exe" 0 runtime_done_${suffix}
  ClearErrors
  Delete "$INSTDIR\SpeedPet.exe"
  IfErrors 0 runtime_done_${suffix}
  MessageBox MB_OK|MB_ICONEXCLAMATION "Please exit Codex Drive (SpeedPet.exe), then retry." /SD IDOK
  Abort
  runtime_done_${suffix}:
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CodexRemoveRuntime install
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
  !insertmacro CodexRemoveRuntime uninstall
  Delete "$INSTDIR\build-kind.json"
!macroend
