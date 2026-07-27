Option Explicit

Dim shell
Dim fso
Dim projectRoot
Dim electronCmd
Dim command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectRoot = fso.GetParentFolderName(WScript.ScriptFullName)
electronCmd = projectRoot & "\node_modules\.bin\electron.cmd"

shell.CurrentDirectory = projectRoot

If Not fso.FileExists(electronCmd) Then
  MsgBox "Electron is not installed. Run npm install first.", vbExclamation, "Persistent Notes"
  WScript.Quit 1
End If

command = shell.ExpandEnvironmentStrings("%COMSPEC%") & " /d /s /c " & Chr(34) & Chr(34) & electronCmd & Chr(34) & " ." & Chr(34)
shell.Run command, 0, False
