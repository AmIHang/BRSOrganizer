; Tauri NSIS hooks. The daemon (amineeded-node.exe) keeps running after the app window closes and
; locks its files, so an update or uninstall would fail to replace/remove them. Stop it first;
; the app starts it again on its next launch. SQLite (WAL) survives a hard stop.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /IM amineeded-node.exe'
  Pop $0
  Sleep 1000
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM amineeded-node.exe'
  Pop $0
  Sleep 1000
!macroend
