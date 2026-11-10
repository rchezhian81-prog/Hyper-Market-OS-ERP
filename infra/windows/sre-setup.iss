; SRE-Setup.exe — the store computer's one setup program (CR-01 step 2 · OI-01 · ADR-0032).
;
; Built by the store-pc-setup job in .github/workflows/ci.yml from the release folder that
; scripts/build-store-pc-release.mjs writes:
;   ISCC.exe /DStageDir=<release folder> /DAppVersion=<version> /DOutDir=<folder> infra\windows\sre-setup.iss
;
; It copies the release into Program Files, then runs the store-computer tool's `setup` with the Node that comes with it:
; this PC's settings (made once with a new tenant id, or KEPT when this PC already has them), the till, and the shop
; database, office API and till as Windows services. Nothing is downloaded on the shop's PC. No secret is in this file.
;
; Run by a person: the usual Windows setup screens. Run silently (tests, or a technician):
;   SRE-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DATADRIVE=D:
; The exit code is 0 only when the setup step said SETUP DONE; its words are in C:\ProgramData\SRE\setup.log.
; Uninstalling removes the program and the three services; the shop's data folder is NEVER touched.

#ifndef StageDir
  #error StageDir must name the release folder (/DStageDir=...)
#endif
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef OutDir
  #define OutDir "."
#endif

[Setup]
AppId={{6C1E8B0A-5B7E-4E43-9C3E-5352452D4F53}
AppName=SRE Retail OS
AppVersion={#AppVersion}
AppPublisher=SRE Hyper Market
DefaultDirName={autopf}\SRE Retail OS
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutDir}
OutputBaseFilename=SRE-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=SRE Retail OS
SetupLogging=yes
; The services are stopped by PrepareToInstall below; Windows' own "close the applications" step is not needed.
CloseApplications=no

[Messages]
; A person's run: the first-run screens are opened in their browser; the shortcut is the way back to them.
FinishedLabelNoIcons=The program is copied. The setup screens are open in your browser. If you cannot see them, double-click "Finish SRE setup" on your desktop.
FinishedLabel=The program is copied. The setup screens are open in your browser. If you cannot see them, double-click "Finish SRE setup" on your desktop.

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[UninstallRun]
; The three services go; the shop's data folder, its settings, its database and its logs stay.
Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\scripts\store-computer.mjs"" remove-services"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveServices"

[Code]
var
  SetupResult: Integer;

function DataDriveArg(): String;
var
  Drive: String;
begin
  Drive := ExpandConstant('{param:DATADRIVE|}');
  if Drive = '' then
    Result := ''
  else
    Result := ' --data-drive ' + Drive;
end;

// Run again (a repair, or an update later): the three services hold this program's files open, and Windows refuses to
// replace a file in use. So they are stopped first — the till, then the office API, then the database — and the setup
// step below starts them again. A service that is not there is simply not stopped. Nothing of the shop's data is touched.
//
// Then anything still running from this program's own Node is stopped too: an earlier run's setup screens (seen on the
// owner's PC, 2026-11-09: the screens' server held node.exe and the second run was refused, "DeleteFile failed; code 5").
// Only a node.exe whose file is THIS program's runtime\node\node.exe is stopped — never another program's.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  NodeExe: String;
begin
  Exec(ExpandConstant('{sys}\net.exe'), 'stop SRE-Till /y', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\net.exe'), 'stop SRE-API /y', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\net.exe'), 'stop SRE-Database /y', '', SW_HIDE, ewWaitUntilTerminated, Code);
  NodeExe := ExpandConstant('{app}\runtime\node\node.exe');
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
       '-NoProfile -NonInteractive -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ''' + NodeExe + ''' } | Stop-Process -Force; Start-Sleep -Seconds 2"',
       '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;

// The screens' address, from the shortcut their server writes once it is listening; '' if it has not come in 60 seconds.
function ScreensAddress(const Shortcut: String): String;
var
  Lines: TArrayOfString;
  I, Tries: Integer;
begin
  Result := '';
  for Tries := 1 to 120 do
  begin
    if FileExists(Shortcut) and LoadStringsFromFile(Shortcut, Lines) then
      for I := 0 to GetArrayLength(Lines) - 1 do
        if Pos('URL=', Lines[I]) = 1 then
        begin
          Result := Copy(Lines[I], 5, Length(Lines[I]) - 4);
          exit;
        end;
    Sleep(500);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Shortcut, Address: String;
begin
  if CurStep = ssPostInstall then
  begin
    // Run by a person: the first-run screens open in the browser (CR-01 step 2b, OI-02) and do the setup there; this
    // program's part is done once its files are copied. Run silently (a technician, the tests): the setup runs here.
    // This program runs as administrator, and so does the screens' server: it opens no browser itself (an administrator's
    // browser did not appear on the owner's PC). It writes its address into "Finish SRE setup" on the desktop, and this
    // program opens that address AS THE PERSON who started it. Its words go into the setup log.
    if not WizardSilent() then
    begin
      SetupResult := 0;
      Shortcut := ExpandConstant('{userdesktop}\Finish SRE setup.url');
      DeleteFile(Shortcut);
      ForceDirectories(ExpandConstant('{commonappdata}\SRE'));
      WizardForm.StatusLabel.Caption := 'Opening the setup screens in your browser...';
      if not Exec(ExpandConstant('{app}\runtime\node\node.exe'),
                  '"' + ExpandConstant('{app}\scripts\dist\setup-server.js') + '" --shortcut "' + Shortcut + '" --log "' + ExpandConstant('{commonappdata}\SRE\setup.log') + '"',
                  ExpandConstant('{app}'), SW_HIDE, ewNoWait, Code) then
      begin
        MsgBox('The setup screens could not be started. Restart the PC and run SRE-Setup.exe again. If it happens again, send a photo of the last lines of C:\ProgramData\SRE\setup.log.', mbError, MB_OK);
        exit;
      end;
      Address := ScreensAddress(Shortcut);
      if Address = '' then
        MsgBox('The setup screens did not start. Restart the PC and run SRE-Setup.exe again. If it happens again, send a photo of the last lines of C:\ProgramData\SRE\setup.log.', mbError, MB_OK)
      else if not ShellExecAsOriginalUser('open', Address, '', '', SW_SHOWNORMAL, ewNoWait, Code) then
        MsgBox('Your browser did not open. Double-click "Finish SRE setup" on your desktop to open the setup screens.', mbInformation, MB_OK);
      exit;
    end;
    WizardForm.StatusLabel.Caption := 'Setting up the shop database, the office and the till. This takes a few minutes...';
    if not Exec(ExpandConstant('{app}\runtime\node\node.exe'),
                '"' + ExpandConstant('{app}\scripts\store-computer.mjs') + '" setup' + DataDriveArg(),
                ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) then
      Code := 1;
    SetupResult := Code;
    if (Code <> 0) and (not WizardSilent()) then
      MsgBox('The setup did not finish. What it said is in C:\ProgramData\SRE\setup.log. Send a photo of that file''s last lines.', mbError, MB_OK);
  end;
end;

function GetCustomSetupExitCode(): Integer;
begin
  if SetupResult <> 0 then
    Result := 10 + SetupResult
  else
    Result := 0;
end;
