; TryDesk Setup (electron-builder NSIS include, see package.json build.nsis.include).
; Installs the TryDesk Windows service, as AnyDesk does: the PC stays reachable after a restart and while an RDP
; session is disconnected, under the same ID. One UAC prompt; declining it leaves TryDesk working without the service
; (Settings -> Security -> Install service does it later). An update reinstalls it, which refreshes the service's
; copy in Program Files; only a real uninstall removes it.

; In-app update (src/updater.js runs this Setup with /S --updated): the service is refreshed only when this PC has it.
; A PC that said no to the service at install time gets no Windows permission prompt on every update.
; A build without the service helper (audit 19 Nov, TD-VULN-05a: a build where the C++ step didn't run) asks for no
; Windows permission at all: there is nothing to install.
!macro customInstall
  IfFileExists "$INSTDIR\resources\app.asar.unpacked\src\native\trydesk-service.exe" 0 tdServiceDone
  ${if} ${isUpdated}
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\TryDeskService" "ImagePath"
    ${if} $0 == ""
      Goto tdServiceDone
    ${endIf}
  ${endIf}
  ExecShellWait "runas" "$INSTDIR\resources\app.asar.unpacked\src\native\trydesk-service.exe" 'install "$INSTDIR\${APP_EXECUTABLE_FILENAME}"' SW_HIDE
  tdServiceDone:
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
  ${andIf} ${FileExists} "$INSTDIR\resources\app.asar.unpacked\src\native\trydesk-service.exe"
    ExecShellWait "runas" "$INSTDIR\resources\app.asar.unpacked\src\native\trydesk-service.exe" "uninstall" SW_HIDE
  ${endIf}
!macroend
