' PiTech by Haxnstuff — hidden launcher. wscript runs this with no visible window;
' window style 0 keeps the node server's console hidden too.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
' Refresh PATH from registry so freshly installed toolchains are visible without reboot
machinePath = sh.RegRead("HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path")
On Error Resume Next
userPath = sh.RegRead("HKCU\Environment\Path")
On Error Goto 0
sh.Run "cmd /c set PATH=" & machinePath & ";" & userPath & ";%PATH% && node server.js >> server.log 2>&1", 0, False
