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
SolidCompression=yes
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

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\SecAgent"; Filename: "{app}\SecAgent.exe"; Tasks: startmenu
Name: "{autodesktop}\SecAgent"; Filename: "{app}\SecAgent.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\SecAgent.exe"; Description: "启动 SecAgent"; Flags: nowait postinstall skipifsilent
