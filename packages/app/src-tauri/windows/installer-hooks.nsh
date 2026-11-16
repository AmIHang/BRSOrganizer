; Tauri NSIS hooks. The daemon (brsorganizer-node.exe) keeps running after the app window closes and
; locks its files, so an update or uninstall would fail to replace/remove them. Stop it first;
; the app starts it again on its next launch. SQLite (WAL) survives a hard stop.

!macro BRS_STOP_PROCESSES
  nsExec::Exec 'taskkill /F /IM brsorganizer-node.exe'
  Pop $0
  ; Former name of the app.
  nsExec::Exec 'taskkill /F /IM amineeded.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM amineeded-node.exe'
  Pop $0
  Sleep 1000
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro BRS_STOP_PROCESSES
  ; Remove an AmINeeded installation (former name) so it no longer autostarts. Its uninstaller only
  ; deletes its own program files; the database stays and the daemon copies it on first start.
  IfFileExists "$LOCALAPPDATA\AmINeeded\uninstall.exe" 0 brs_no_legacy
    ExecWait '"$LOCALAPPDATA\AmINeeded\uninstall.exe" /S _?=$LOCALAPPDATA\AmINeeded'
    Delete "$LOCALAPPDATA\AmINeeded\uninstall.exe"
  brs_no_legacy:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro BRS_STOP_PROCESSES
!macroend
