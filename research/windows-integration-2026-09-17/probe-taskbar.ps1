#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$version = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$present = [Windows.Foundation.Metadata.ApiInformation, Windows.Foundation, ContentType=WindowsRuntime]::IsTypePresent('Windows.UI.Shell.Tasks.AppTaskInfo')
$supported = $null
$failure = $null
if ($present) {
    try {
        $supported = [Windows.UI.Shell.Tasks.AppTaskInfo, Windows.UI.Shell, ContentType=WindowsRuntime]::IsSupported()
    } catch {
        $failure = $_.Exception.Message
    }
}
[ordered]@{
    testedAt = [DateTime]::UtcNow.ToString('o')
    windowsVersion = $version.DisplayVersion
    windowsBuild = "$($version.CurrentBuild).$($version.UBR)"
    appTaskTypePresent = $present
    appTaskIsSupported = $supported
    error = $failure
    visibleTaskCreated = $false
    scope = 'Read-only availability check; no package registration, task creation or Explorer modification.'
} | ConvertTo-Json
