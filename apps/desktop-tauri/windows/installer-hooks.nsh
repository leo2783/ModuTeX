; SPDX-License-Identifier: Apache-2.0
; Finish removing the main executable before NSIS deletes uninstall metadata.
; Scanner/file handles can briefly outlive application exit. Never accept a
; reboot-only removal or continue an uninstall with a locked executable.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  Push $R0
  StrCpy $R0 40
  modutex_delete_main_retry:
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 modutex_delete_main_done
    ClearErrors
    Delete "$INSTDIR\${MAINBINARYNAME}.exe"
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 modutex_delete_main_done
    IntOp $R0 $R0 - 1
    IntCmp $R0 0 modutex_delete_main_failed
    Sleep 250
    Goto modutex_delete_main_retry
  modutex_delete_main_failed:
    Pop $R0
    SetErrorLevel 1
    Abort "ModuTeX executable is locked; close the application and retry uninstall."
  modutex_delete_main_done:
    Pop $R0
!macroend
