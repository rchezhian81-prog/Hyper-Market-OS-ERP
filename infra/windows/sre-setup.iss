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
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\net.exe'), 'stop SRE-Till /y', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\net.exe'), 'stop SRE-API /y', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\net.exe'), 'stop SRE-Database /y', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep = ssPostInstall then
  begin
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
