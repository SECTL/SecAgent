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

function NormalizeManifestPath(Value: String): String;
begin
  StringChangeEx(Value, '/', '\', True);
  while (Length(Value) > 0) and (Value[1] = '\') do
    Delete(Value, 1, 1);
  Result := LowerCase(Value);
end;

function ManifestHashForPath(const RelativePath: String): String;
var
  Index, Separator: Integer;
  Line, ManifestPath: String;
begin
  Result := '';
  ManifestPath := NormalizeManifestPath(RelativePath);
  for Index := 0 to GetArrayLength(HashManifest) - 1 do begin
    Line := Trim(HashManifest[Index]);
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
  Destination, ApplicationDirectory, RelativePath, ExpectedHash, ExistingHash: String;
begin
  Result := True;
  if not HashManifestLoaded then
    Exit;

  Destination := ExpandConstant(CurrentFileName);
  ApplicationDirectory := AddBackslash(ExpandConstant('{app}'));
  if not PathStartsWith(Destination, ApplicationDirectory, True) then
    Exit;

  RelativePath := Copy(Destination, Length(ApplicationDirectory) + 1, Length(Destination));
  ExpectedHash := ManifestHashForPath(RelativePath);
  if (ExpectedHash = '') or not FileExists(Destination) then
    Exit;

  try
    ExistingHash := LowerCase(GetSHA256OfFile(Destination));
    Result := ExistingHash <> ExpectedHash;
    if not Result then
      Log('Skipping unchanged file: ' + RelativePath);
  except
    Result := True;
  end;
end;

function InitializeSetup: Boolean;
begin
  HashManifestLoaded := False;
  try
    ExtractTemporaryFile('SecAgent.files.sha256');
    HashManifestLoaded := LoadStringsFromFile(ExpandConstant('{tmp}\SecAgent.files.sha256'), HashManifest);
  except
    Log('Unable to load the installer file hash manifest; files will be checked by Inno Setup defaults.');
  end;
  Result := True;
end;
