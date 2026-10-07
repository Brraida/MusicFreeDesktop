param([Parameter(Mandatory=$true)][string]$Title)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$shell = New-Object -ComObject WScript.Shell
function Read-Link($File) {
    $link = $shell.CreateShortcut($File.FullName)
    [pscustomobject]@{ path = $File.FullName; target = $link.TargetPath; arguments = $link.Arguments }
}
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$programs = [Environment]::GetFolderPath('Programs')
$desktopLinks = @()
$menuLinks = @()
if (Test-Path -LiteralPath $desktop) {
    $desktopLinks = @(Get-ChildItem -LiteralPath $desktop -Filter "$Title.lnk" -File | ForEach-Object { Read-Link $_ })
}
if (Test-Path -LiteralPath $programs) {
    $menuLinks = @(Get-ChildItem -LiteralPath $programs -Filter "$Title.lnk" -File -Recurse | ForEach-Object { Read-Link $_ })
}
[pscustomobject]@{ desktop = $desktopLinks; startMenu = $menuLinks } | ConvertTo-Json -Depth 4 -Compress
