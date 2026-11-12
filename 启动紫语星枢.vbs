Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
If fso.FileExists(root & "\紫语星枢.exe") Then
  shell.Run """" & root & "\紫语星枢.exe""", 0, False
Else
  shell.Run """" & root & "\node_modules\electron\dist\electron.exe"" """ & root & """", 0, False
End If
