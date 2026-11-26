param(
  [Parameter(Mandatory)][ValidateSet('apply','restore')][string]$Action,
  [Parameter(Mandatory)][string]$Snapshot,
  [string]$ExecutableName,
  [string]$DataDir,
  [int]$Port
)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true'){throw 'Only an ephemeral GitHub runner is supported'}
$temp=[IO.Path]::GetFullPath($env:RUNNER_TEMP)+[IO.Path]::DirectorySeparatorChar
if(-not [IO.Path]::GetFullPath($Snapshot).StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)){throw 'Snapshot must be in runner temp'}
$base='HKLM:\Software\Policies\Microsoft\Edge\WebView2'
if($Action -eq 'restore'){
  $saved=Get-Content -LiteralPath $Snapshot -Raw | ConvertFrom-Json
  foreach($old in $saved){
    if($old.Key -notin @((Join-Path $base 'AdditionalBrowserArguments'),(Join-Path $base 'UserDataFolder'))){throw 'Unexpected registry key'}
    if($old.Exists){New-ItemProperty -LiteralPath $old.Key -Name 'taskcalendar-plus.exe' -PropertyType String -Value $old.Value -Force|Out-Null}
    else{Remove-ItemProperty -LiteralPath $old.Key -Name 'taskcalendar-plus.exe' -ErrorAction SilentlyContinue}
  }
  return
}
if($ExecutableName -ne 'taskcalendar-plus.exe' -or $Port -notin @(9481,9482,9483,9484,9485,9491)){throw 'Unexpected app or debugging port'}
if(-not [IO.Path]::GetFullPath($DataDir).StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)){throw 'Profile must be in runner temp'}
$previous=@()
try {
  foreach($setting in @(@{Key='AdditionalBrowserArguments';Value="--remote-debugging-port=$Port"},@{Key='UserDataFolder';Value=$DataDir})){
    $key=Join-Path $base $setting.Key
    New-Item -Path $key -Force|Out-Null
    $old=(Get-ItemProperty -LiteralPath $key).PSObject.Properties[$ExecutableName]
    $previous+=@{Key=$key;Exists=($null -ne $old);Value=$(if($null -ne $old){$old.Value}else{$null})}
    $previous|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $Snapshot
    New-ItemProperty -LiteralPath $key -Name $ExecutableName -PropertyType String -Value $setting.Value -Force|Out-Null
  }
} catch {
  foreach($old in $previous){
    if($old.Exists){New-ItemProperty -LiteralPath $old.Key -Name $ExecutableName -PropertyType String -Value $old.Value -Force|Out-Null}
    else{Remove-ItemProperty -LiteralPath $old.Key -Name $ExecutableName -ErrorAction SilentlyContinue}
  }
  throw
}
