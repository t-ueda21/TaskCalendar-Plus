$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:VERIFY_TAG -ne 'v4.0.5') { throw 'Ephemeral v4.0.5 verification only' }
$install = Join-Path $env:RUNNER_TEMP 'taskcalendar-installed'
$oldCopy = Join-Path $env:RUNNER_TEMP 'taskcalendar-previous-copy'
$taskProfile = Join-Path $env:RUNNER_TEMP 'taskcalendar-upgrade-profile'
$report = Join-Path $env:GITHUB_WORKSPACE 'verification-report'
New-Item -ItemType Directory -Force $report | Out-Null
# Keep the isolated fixture's old Local date and new JST date consistent.
$oldZone = (Get-TimeZone).Id
function Install-Checked([string]$file) {
  $process = Start-Process -FilePath $file -ArgumentList @('/S',"/D=$install") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
}
function App-Exe([string]$folder) {
  $files = @(Get-ChildItem -LiteralPath $folder -File -Filter '*.exe' | Where-Object { $_.Name -notmatch '(?i)uninstall|webview|update' })
  if ($files.Count -ne 1) { throw 'Ambiguous installed app executable' }
  return $files[0].FullName
}
function Check-Native([string]$mode,[string]$exe,[string]$data) {
  node .github/release-verification/native-release-check.mjs $mode $exe $data $report
  if ($LASTEXITCODE -ne 0) { throw "Native check failed: $mode" }
}
function Read-Registrations {
  foreach ($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    if (Test-Path $hive) {
      foreach ($key in Get-ChildItem $hive) {
        $value = Get-ItemProperty -LiteralPath $key.PSPath
        @{key=$key.Name;hive=$hive;name=$value.DisplayName;version=$value.DisplayVersion;location=([string]$value.InstallLocation).Trim('"').TrimEnd('\');uninstall=[string]$value.UninstallString}
      }
    }
  }
}
function Read-Shortcuts {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($folder in @([Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms'),[Environment]::GetFolderPath('DesktopDirectory'))) {
    if (Test-Path $folder) {
      foreach ($file in Get-ChildItem -LiteralPath $folder -Recurse -File -Filter '*.lnk') {
        $shortcut = $shell.CreateShortcut($file.FullName)
        @{path=$file.FullName;name=$file.Name;target=$shortcut.TargetPath;folder=$folder}
      }
    }
  }
}
try {
  Set-TimeZone -Id 'Tokyo Standard Time'
  Install-Checked $env:OLD_INSTALLER
  $previousExe = App-Exe $install
  $previousRegistration = @(Read-Registrations | Where-Object { $_.location -eq $install -or $_.uninstall.Contains($install) })
  if ($previousRegistration.Count -ne 1 -or $previousRegistration[0].version -ne '4.0.4' -or -not $previousRegistration[0].hive.StartsWith('HKCU:')) { throw 'Previous per-user installer registration is ambiguous or missing' }
  $previousShortcuts = @(Read-Shortcuts | Where-Object { $_.target -eq $previousExe })
  if (@($previousShortcuts | Where-Object { $_.folder -eq [Environment]::GetFolderPath('Programs') }).Count -lt 1) { throw 'Previous Start Menu app shortcut missing' }
  if (@($previousShortcuts | Where-Object { $_.folder -eq [Environment]::GetFolderPath('DesktopDirectory') }).Count -lt 1) { throw 'Previous desktop app shortcut missing' }
  Copy-Item -LiteralPath $install -Destination $oldCopy -Recurse
  $oldExe = App-Exe $oldCopy
  if ($env:VERIFY_PHASE -eq 'package') { Check-Native 'seed' (App-Exe $install) $taskProfile }
  Install-Checked $env:NEW_INSTALLER
  $newExe = App-Exe $install
  $renderers = @(Get-ChildItem -LiteralPath $install -Directory -Recurse | Where-Object { $_.Name -eq 'renderer' -and (Test-Path (Join-Path $_.FullName 'assets/app.html')) })
  if ($renderers.Count -ne 1) { throw 'Packaged renderer not found' }
  $source = Join-Path $env:GITHUB_WORKSPACE 'app-source/src-tauri/renderer'
  $files = @(Get-ChildItem -LiteralPath $source -Recurse -File)
  $packagedFiles = @(Get-ChildItem -LiteralPath $renderers[0].FullName -Recurse -File)
  if ($packagedFiles.Count -ne $files.Count) { throw 'Packaged renderer file count differs' }
  foreach ($file in $files) {
    $relative = [System.IO.Path]::GetRelativePath($source,$file.FullName)
    $installed = Join-Path $renderers[0].FullName $relative
    if (-not (Test-Path -LiteralPath $installed)) { throw "Packaged source missing: $relative" }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $installed).Hash) { throw "Packaged source differs: $relative" }
  }
  $registrations = @(Read-Registrations | Where-Object { $_.name -eq $previousRegistration[0].name -or $_.key -eq $previousRegistration[0].key -or $_.location -eq $install -or $_.uninstall.Contains($install) })
  if ($registrations.Count -ne 1 -or $registrations[0].version -ne '4.0.5' -or $registrations[0].key -ne $previousRegistration[0].key -or $registrations[0].location -ne $install) { throw 'Per-user installer registration changed, duplicated or has the wrong version/path' }
  $allShortcuts = @(Read-Shortcuts)
  $shortcuts = @(
    foreach ($old in $previousShortcuts) {
      $matches = @($allShortcuts | Where-Object { $_.path -eq $old.path })
      if ($matches.Count -ne 1 -or $matches[0].target -ne $newExe) { throw "App shortcut missing or stale: $($old.path)" }
      $matches[0]
    }
  )
  $namedShortcuts = @($allShortcuts | Where-Object { $_.name -in $previousShortcuts.name })
  foreach ($link in $namedShortcuts) { if ($link.target -ne $newExe) { throw "Stale named app shortcut: $($link.path)" } }
  @{rendererFiles=$files.Count;tag=$env:VERIFY_TAG;sourceSha=$env:SOURCE_SHA;installerSha256=$env:EXPECTED_SHA;previousSha256=$env:PREVIOUS_SHA;previousRegistration=$previousRegistration;previousShortcuts=$previousShortcuts;registrations=$registrations;shortcuts=$shortcuts} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $report 'package-hashes.json')
  if ($env:VERIFY_PHASE -eq 'package') {
    Check-Native 'package' $newExe $taskProfile
    Check-Native 'fresh' $newExe (Join-Path $env:RUNNER_TEMP 'taskcalendar-fresh-profile')
    $env:VERIFY_EXE = $newExe
    $env:TCPLUS_AI_NATIVE_DATA = Join-Path $env:RUNNER_TEMP 'taskcalendar-ai-native-packaged'
    $env:TCPLUS_CODEX_PATH = Join-Path $env:RUNNER_TEMP 'deliberately-missing-model.exe'
    node .github/release-verification/ai-packaged.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Packaged AI verification failed' }
  } elseif ($env:VERIFY_PHASE -eq 'updates') {
    Check-Native 'updates-old' $oldExe (Join-Path $env:RUNNER_TEMP 'taskcalendar-old-update-profile')
    Check-Native 'updates-new' $newExe (Join-Path $env:RUNNER_TEMP 'taskcalendar-new-update-profile')
  } else { throw 'Unknown verification phase' }
} finally {
  Set-TimeZone -Id $oldZone
}
