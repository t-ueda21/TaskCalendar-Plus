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
function Restore-Saved($saved){
  foreach($old in $saved){
    if($old.Key -notin @((Join-Path $base 'AdditionalBrowserArguments'),(Join-Path $base 'UserDataFolder'))){throw 'Unexpected registry key'}
    if($old.Exists){
      New-ItemProperty -LiteralPath $old.Key -Name 'taskcalendar-plus.exe' -PropertyType $old.Kind -Value $old.Value -Force|Out-Null
    }else{
      Remove-ItemProperty -LiteralPath $old.Key -Name 'taskcalendar-plus.exe' -ErrorAction SilentlyContinue
    }
    if(-not $old.KeyExisted -and (Test-Path -LiteralPath $old.Key)){
      $keyItem=Get-Item -LiteralPath $old.Key
      if($keyItem.GetValueNames().Count -eq 0 -and $keyItem.GetSubKeyNames().Count -eq 0){Remove-Item -LiteralPath $old.Key}
    }
  }
}
if($Action -eq 'restore'){
  $saved=Get-Content -LiteralPath $Snapshot -Raw | ConvertFrom-Json
  Restore-Saved $saved
  return
}
if($ExecutableName -ne 'taskcalendar-plus.exe' -or $Port -notin @(9481,9482,9483,9484,9485,9491)){throw 'Unexpected app or debugging port'}
if(-not [IO.Path]::GetFullPath($DataDir).StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)){throw 'Profile must be in runner temp'}
$previous=@()
try {
  foreach($setting in @(@{Key='AdditionalBrowserArguments';Value="--remote-debugging-port=$Port"},@{Key='UserDataFolder';Value=$DataDir})){
    $key=Join-Path $base $setting.Key
    $keyExisted=Test-Path -LiteralPath $key
    if(-not $keyExisted){New-Item -Path $key|Out-Null}
    $registry=Get-Item -LiteralPath $key
    $exists=$registry.GetValueNames() -contains $ExecutableName
    $previous+=@{Key=$key;KeyExisted=$keyExisted;Exists=$exists;Value=$(if($exists){$registry.GetValue($ExecutableName,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{$null});Kind=$(if($exists){$registry.GetValueKind($ExecutableName).ToString()}else{$null})}
    $previous|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $Snapshot
    New-ItemProperty -LiteralPath $key -Name $ExecutableName -PropertyType String -Value $setting.Value -Force|Out-Null
  }
} catch {
  Restore-Saved $previous
  throw
}
