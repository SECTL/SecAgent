#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#ifndef SourceDir
  #define SourceDir "..\release\win-unpacked"
#endif

#ifndef OutputDir
  #define OutputDir "..\release\inno"
#endif

#ifndef OutputBaseFilename
  #define OutputBaseFilename "SecAgent-Setup"
#endif

#ifndef ManifestFile
  #define ManifestFile "..\release\SecAgent.files.sha256"
#endif

[Setup]
AppId={{cn.sectl.secagent}
AppName=SecAgent
AppVersion={#AppVersion}
AppPublisher=SECTL
DefaultDirName={autopf}\SecAgent
DefaultGroupName=SecAgent
UninstallDisplayIcon={app}\SecAgent.exe
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
Compression=lzma2
SolidCompression=no
WizardStyle=modern
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
UsePreviousPrivileges=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
Uninstallable=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "startmenu"; Description: "创建开始菜单快捷方式"; GroupDescription: "快捷方式："
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："
Name: "autostart"; Description: "开机时自动启动 SecAgent"; GroupDescription: "其他选项："; Flags: unchecked

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SecAgent"; ValueData: """{app}\SecAgent.exe"" --autostart"; Flags: uninsdeletevalue; Tasks: autostart

[UninstallDelete]
Type: files; Name: "{app}\SecAgent.files.sha256"
Type: files; Name: "{app}\SecAgent.files.sha256.new"

[Files]
Source: "{#ManifestFile}"; DestName: "SecAgent.files.sha256"; Flags: dontcopy noencryption
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs replacesameversion; Check: ShouldInstallFile

[Icons]
Name: "{autoprograms}\SecAgent"; Filename: "{app}\SecAgent.exe"; Tasks: startmenu
Name: "{autodesktop}\SecAgent"; Filename: "{app}\SecAgent.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\SecAgent.exe"; Description: "启动 SecAgent"; Flags: nowait postinstall skipifsilent

[Code]
var
  HashManifest: TArrayOfString;
  HashManifestLoaded: Boolean;
  InstalledHashManifest: TArrayOfString;
  InstalledHashManifestLoaded: Boolean;

function LoadHashManifest(const FileName: String; var Manifest: TArrayOfString): Boolean;
var
  Index, Separator, HashIndex: Integer;
  Line, HashValue, ManifestPath: String;
begin
  Result := False;
  if not FileExists(FileName) then
    Exit;
  try
    if not LoadStringsFromFile(FileName, Manifest) or (GetArrayLength(Manifest) = 0) then
      Exit;
    for Index := 0 to GetArrayLength(Manifest) - 1 do begin
      Line := Trim(Manifest[Index]);
      Separator := Pos('  ', Line);
      if Separator <= 0 then
        Exit;
      HashValue := Trim(Copy(Line, 1, Separator - 1));
      ManifestPath := Trim(Copy(Line, Separator + 2, Length(Line)));
      if (Length(HashValue) <> 64) or (ManifestPath = '') then
        Exit;
      for HashIndex := 1 to Length(HashValue) do
        if not (((HashValue[HashIndex] >= '0') and (HashValue[HashIndex] <= '9')) or
          ((HashValue[HashIndex] >= 'a') and (HashValue[HashIndex] <= 'f')) or
          ((HashValue[HashIndex] >= 'A') and (HashValue[HashIndex] <= 'F'))) then
          Exit;
    end;
    Result := True;
  except
    Result := False;
  end;
end;

function NormalizeManifestPath(Value: String): String;
begin
  StringChangeEx(Value, '/', '\', True);
  while (Length(Value) > 0) and (Value[1] = '\') do
    Delete(Value, 1, 1);
  Result := LowerCase(Value);
end;

function ManifestHashForPath(const Manifest: TArrayOfString; const RelativePath: String): String;
var
  Index, Separator: Integer;
  Line, ManifestPath: String;
begin
  Result := '';
  ManifestPath := NormalizeManifestPath(RelativePath);
  for Index := 0 to GetArrayLength(Manifest) - 1 do begin
    Line := Trim(Manifest[Index]);
    Separator := Pos('  ', Line);
    if Separator <= 0 then
      Continue;
    if NormalizeManifestPath(Copy(Line, Separator + 2, Length(Line))) = ManifestPath then begin
      Result := LowerCase(Trim(Copy(Line, 1, Separator - 1)));
      Exit;
    end;
  end;
end;

function ShouldInstallFile: Boolean;
var
  Destination, ApplicationDirectory, RelativePath, ExpectedHash, InstalledHash: String;
begin
  Result := True;
  if not HashManifestLoaded or not InstalledHashManifestLoaded then
    Exit;

  Destination := ExpandConstant(CurrentFileName);
  ApplicationDirectory := AddBackslash(ExpandConstant('{app}'));
  if not PathStartsWith(Destination, ApplicationDirectory, True) then
    Exit;

  RelativePath := Copy(Destination, Length(ApplicationDirectory) + 1, Length(Destination));
  ExpectedHash := ManifestHashForPath(HashManifest, RelativePath);
  InstalledHash := ManifestHashForPath(InstalledHashManifest, RelativePath);
  if (ExpectedHash = '') or (InstalledHash = '') or not FileExists(Destination) then
    Exit;

  Result := InstalledHash <> ExpectedHash;
  if not Result then begin
    Log('Skipping unchanged file: ' + RelativePath);
  end;
end;

function InitializeSetup: Boolean;
begin
  HashManifestLoaded := False;
  InstalledHashManifestLoaded := False;
  try
    ExtractTemporaryFile('SecAgent.files.sha256');
    HashManifestLoaded := LoadHashManifest(ExpandConstant('{tmp}\SecAgent.files.sha256'), HashManifest);
  except
    Log('Unable to load the installer file hash manifest; files will be checked by Inno Setup defaults.');
  end;
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  InstalledManifestFile, TemporaryManifestFile, NewInstalledManifestFile: String;
begin
  if CurStep = ssInstall then begin
    InstalledManifestFile := ExpandConstant('{app}\SecAgent.files.sha256');
    InstalledHashManifestLoaded := LoadHashManifest(InstalledManifestFile, InstalledHashManifest);
    if InstalledHashManifestLoaded then
      Log('Loaded installed file hash manifest: ' + InstalledManifestFile)
    else
      Log('Installed file hash manifest is missing or invalid; all files will be installed.');
  end else if CurStep = ssPostInstall then begin
    if HashManifestLoaded then begin
      TemporaryManifestFile := ExpandConstant('{tmp}\SecAgent.files.sha256');
      InstalledManifestFile := ExpandConstant('{app}\SecAgent.files.sha256');
      NewInstalledManifestFile := ExpandConstant('{app}\SecAgent.files.sha256.new');
      DeleteFile(NewInstalledManifestFile);
      if CopyFile(TemporaryManifestFile, NewInstalledManifestFile, False) then begin
        DeleteFile(InstalledManifestFile);
        if RenameFile(NewInstalledManifestFile, InstalledManifestFile) then
          Log('Saved installed file hash manifest: ' + InstalledManifestFile)
        else
          Log('Unable to replace installed file hash manifest: ' + InstalledManifestFile);
      end else
        Log('Unable to stage installed file hash manifest: ' + InstalledManifestFile);
    end;
  end;
end;
