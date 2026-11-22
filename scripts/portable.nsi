; TryDesk's own copy of electron-builder's portable.nsi (app-builder-lib/templates/nsis), put in place before each
; Windows build by scripts/patch-portable.mjs (npm "prebuild"). Two changes, owner 19 Nov 2026 ("setiap buka TryDesk
; portable muncul firewall TryDesk baru terus ... bikin numpuk di windows firewall"):
;  1. One fixed folder, %TEMP%\TryDesk-Portable, instead of a new random one on every start. Windows Firewall keeps its
;     rules by the program's path, so every start asked again and left one more "trydesk.exe" rule behind.
;  2. A fixed folder must never be emptied under a TryDesk that runs from it (opened a second time, or the copy started
;     by "Jalankan sebagai administrator" while the old one is still closing): tested 19 Nov, the stock template deleted
;     the running copy's files. So when TryDesk.exe there is in use, this start only hands over to it (the app's single-
;     instance lock brings the running window up) and touches nothing; and the folder is cleared on exit only when
;     nothing runs from it any more.
;  3. Security audit 22 Nov: started as administrator (Jalankan sebagai administrator), the fixed folder above is never
;     used: it sits in the user's own %TEMP%, so any program of that user could put its own TryDesk.exe or a DLL there
;     and have it run as administrator. The admin start unpacks into a new folder of its own under %WINDIR%\Temp that
;     only administrators and SYSTEM can change (other users may only read it), made fresh each time (it must not exist
;     already) and removed when TryDesk closes.
!include "common.nsh"
!include "extractAppPackage.nsh"

# https://github.com/electron-userland/electron-builder/issues/3972#issuecomment-505171582
CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}

Var inUse
Var elevated

; $elevated = "1" when this launcher runs as administrator (UAC "Yes"). Then $INSTDIR becomes a new, locked folder:
; %WINDIR%\Temp\ns????.tmp, owner Administrators (an elevated process's default owner), DACL protected (SYSTEM + Administrators full, Users read/run only).
; Normal users can't rename, replace or add to it (they have no delete-child right on %WINDIR%\Temp either). Anything
; that goes wrong stops the start: nothing runs from a folder we didn't make.
Function MakeAdminDir
  GetTempFileName $R9 "$WINDIR\Temp"
  StrCmp $R9 "" fail
  System::Call 'kernel32::DeleteFileW(w "$R9")'   ; not "Delete": it lists the folder first, which users may not do there
  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)", i 1, *p .r1, p 0) i .r0'
  IntCmp $0 0 fail
  System::Call '*(&l4, p r1, i 0) p .r2'
  System::Call 'kernel32::CreateDirectoryW(w "$R9", p r2) i .r0'
  System::Free $2
  System::Call 'kernel32::LocalFree(p r1)'
  IntCmp $0 0 fail
  ; CreateDirectoryW made it just now (it fails on anything already there), so it can't be a link; checked anyway.
  System::Call 'kernel32::GetFileAttributesW(w "$R9") i .r0'
  IntOp $0 $0 & 0x400
  IntCmp $0 0 0 fail fail
  StrCpy $INSTDIR $R9
  Return
  fail:
  MessageBox MB_ICONSTOP|MB_OK "TryDesk could not prepare a safe folder to run as administrator. Start TryDesk normally." /SD IDOK
  SetErrorLevel 5
  Quit
FunctionEnd

Function .onInit
  !ifndef SPLASH_IMAGE
    SetSilent silent
  !endif

  !insertmacro check64BitAndSetRegView
FunctionEnd

Function .onGUIInit
  InitPluginsDir

  !ifdef SPLASH_IMAGE
    File /oname=$PLUGINSDIR\splash.bmp "${SPLASH_IMAGE}"
    BgImage::SetBg $PLUGINSDIR\splash.bmp
    BgImage::Redraw
  !endif
FunctionEnd

; $inUse = "1" when TryDesk.exe in the folder can't be opened for writing (a TryDesk runs from it)
Function CheckInUse
  StrCpy $inUse "0"
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 done
  ClearErrors
  FileOpen $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
  IfErrors 0 +3
    StrCpy $inUse "1"
    Goto done
  FileClose $0
  done:
FunctionEnd

Section
  !ifdef SPLASH_IMAGE
    HideWindow
  !endif

  StrCpy $elevated "0"
  System::Call 'shell32::IsUserAnAdmin() i .r0'
  IntCmp $0 0 normalStart
  StrCpy $elevated "1"
  Call MakeAdminDir
  Goto extract
  normalStart:
  StrCpy $INSTDIR "$TEMP\TryDesk-Portable"
  Call CheckInUse
  StrCmp $inUse "1" launch

  RMDir /r $INSTDIR
  extract:
  SetOutPath $INSTDIR

  !ifdef APP_DIR_64
    !ifdef APP_DIR_ARM64
      !ifdef APP_DIR_32
        ${if} ${IsNativeARM64}
          File /r "${APP_DIR_ARM64}\*.*"
        ${elseif} ${RunningX64}
          File /r "${APP_DIR_64}\*.*"
        ${else}
          File /r "${APP_DIR_32}\*.*"
        ${endIf}
      !else
        ${if} ${IsNativeARM64}
          File /r "${APP_DIR_ARM64}\*.*"
        ${else}
          File /r "${APP_DIR_64}\*.*"
        {endIf}
      !endif
    !else
      !ifdef APP_DIR_32
        ${if} ${RunningX64}
          File /r "${APP_DIR_64}\*.*"
        ${else}
          File /r "${APP_DIR_32}\*.*"
        ${endIf}
      !else
        File /r "${APP_DIR_64}\*.*"
      !endif
    !endif
  !else
    !ifdef APP_DIR_32
      File /r "${APP_DIR_32}\*.*"
    !else
      !insertmacro extractEmbeddedAppPackage
    !endif
  !endif

  launch:
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'
  ${StdUtils.GetAllParameters} $R0 0

  !ifdef SPLASH_IMAGE
    BgImage::Destroy
  !endif

	ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" $R0' $0
  SetErrorLevel $0

  SetOutPath $EXEDIR
  ; cleared only when no TryDesk runs from it any more (the elevated copy may have taken over meanwhile). TryDesk's
  ; helper processes close a moment after the main one: wait for them first, or the folder stayed behind.
  Sleep 3000
  StrCmp $elevated "1" 0 normalEnd
  RMDir /r $INSTDIR      ; the admin start's own folder (only administrators can change it)
  Goto ended
  normalEnd:
  Call CheckInUse
  StrCmp $inUse "1" ended
  RMDir /r $INSTDIR
  ended:
SectionEnd
