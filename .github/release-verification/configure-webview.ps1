param([Parameter(Mandatory)][string]$ExecutableName,[Parameter(Mandatory)][string]$DataDir,[Parameter(Mandatory)][int]$Port)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $ExecutableName -ne 'taskcalendar-plus.exe' -or $Port -lt 9481 -or $Port -gt 9485){throw 'Only ephemeral release verification is supported'}
$full=[IO.Path]::GetFullPath($DataDir)
$temp=[IO.Path]::GetFullPath($env:RUNNER_TEMP)+[IO.Path]::DirectorySeparatorChar
if(-not $full.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)){throw 'Profile must be in runner temp'}
$base='HKLM:\Software\Policies\Microsoft\Edge\WebView2'
$result=@(@{hostElevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)})
foreach($item in @(@{key='AdditionalBrowserArguments';value="--remote-debugging-port=$Port"},@{key='UserDataFolder';value=$full})){
 $key=Join-Path $base $item.key
 New-Item -Path $key -Force | Out-Null
 New-ItemProperty -LiteralPath $key -Name $ExecutableName -PropertyType String -Value $item.value -Force | Out-Null
 $result+=@{path=$key;name=$ExecutableName;value=(Get-ItemPropertyValue -LiteralPath $key -Name $ExecutableName)}
}
$result|ConvertTo-Json
