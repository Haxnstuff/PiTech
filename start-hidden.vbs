' PiTech by Haxnstuff — hidden launcher. wscript runs this with no visible window;
' window style 0 keeps the node server's console hidden too.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "cmd /c node server.js >> server.log 2>&1", 0, False
