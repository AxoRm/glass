Option Explicit

Dim shell
Dim fso
Dim repoPath
Dim command
Dim portableExe
Dim unpackedExe
Dim npmCmd
Dim logPath

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

repoPath = fso.GetParentFolderName(WScript.ScriptFullName)
portableExe = repoPath & "\dist\Glass Portable.exe"
unpackedExe = repoPath & "\dist\win-unpacked\Glass.exe"
logPath = repoPath & "\start-glass.log"

Sub AppendLog(message)
    On Error Resume Next
    Dim logFile
    Set logFile = fso.OpenTextFile(logPath, 8, True)
    logFile.WriteLine Now & " - " & message
    logFile.Close
    On Error Goto 0
End Sub

Function ResolveNpmCmd()
    Dim candidates
    Dim i
    candidates = Array( _
        shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\npm.cmd", _
        shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\npm.cmd", _
        shell.ExpandEnvironmentStrings("%AppData%") & "\npm\npm.cmd" _
    )

    For i = 0 To UBound(candidates)
        If fso.FileExists(candidates(i)) Then
            ResolveNpmCmd = """" & candidates(i) & """"
            Exit Function
        End If
    Next

    ResolveNpmCmd = "npm"
End Function

AppendLog("Launcher started.")

If fso.FileExists(portableExe) Then
    command = """" & portableExe & """"
    AppendLog("Using portable exe: " & portableExe)
ElseIf fso.FileExists(unpackedExe) Then
    command = """" & unpackedExe & """"
    AppendLog("Using unpacked exe: " & unpackedExe)
Else
    npmCmd = ResolveNpmCmd()
    command = "cmd /c cd /d """ & repoPath & """& set ELECTRON_RUN_AS_NODE=& set GLASS_DEVTOOLS=0& " & npmCmd & " start >> """ & logPath & """ 2>&1"
    AppendLog("Using source mode via npm start.")
End If

' Run hidden, do not block this script.
AppendLog("Executing command: " & command)
shell.Run command, 0, False
