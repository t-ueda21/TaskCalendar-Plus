param([int]$ProcessId, [ValidateSet('state','minimize','close','restart','quit','replacement','terminate')][string]$Action='state', [string]$ExpectedExe='', [int]$ExpectedParent=0)
if($Action -eq 'replacement') {
 if(-not $ExpectedExe){throw 'Expected executable required'}
 $matches=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" | Where-Object {$_.ExecutablePath -eq $ExpectedExe})
 @{pids=@($matches|ForEach-Object {[int]$_.ProcessId})} | ConvertTo-Json -Compress
 exit
}
if($Action -eq 'terminate') {
 if(-not $ExpectedExe -or $ExpectedParent -le 0){throw 'Owned process identity required'}
 $target=Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
 if($target){
  if($target.ExecutablePath -ne $ExpectedExe -or $target.ParentProcessId -ne $ExpectedParent){throw 'Refusing to stop an unowned process'}
  Stop-Process -Id $ProcessId -ErrorAction Stop
 }
 @{stopped=$true}|ConvertTo-Json -Compress
 exit
}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SingleInstanceNative {
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
 [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu, int position);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr menu, uint item, System.Text.StringBuilder s, int n, uint flags);
 public delegate bool Callback(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
$script:match = [IntPtr]::Zero
[SingleInstanceNative]::EnumWindows({param($h,$p)
 $owner=0
 [void][SingleInstanceNative]::GetWindowThreadProcessId($h,[ref]$owner)
 $title=New-Object System.Text.StringBuilder 256
 [void][SingleInstanceNative]::GetWindowText($h,$title,256)
 if($owner -eq $ProcessId -and $title.ToString() -eq 'TaskCalendar+') { $script:match=$h }
 return $true
},[IntPtr]::Zero) | Out-Null
if($script:match -ne [IntPtr]::Zero) {
 if($Action -eq 'minimize') { [void][SingleInstanceNative]::ShowWindowAsync($script:match,6) }
 if($Action -eq 'close') { [void][SingleInstanceNative]::PostMessage($script:match,0x10,[IntPtr]::Zero,[IntPtr]::Zero) }
}
if($Action -eq 'restart' -or $Action -eq 'quit') {
 $script:tray=[IntPtr]::Zero
 [SingleInstanceNative]::EnumWindows({param($h,$p)
  $owner=0;[void][SingleInstanceNative]::GetWindowThreadProcessId($h,[ref]$owner)
  $class=New-Object System.Text.StringBuilder 256;[void][SingleInstanceNative]::GetClassName($h,$class,256)
  if($owner -eq $ProcessId -and $class.ToString() -eq 'tray_icon_app'){$script:tray=$h};return $true
 },[IntPtr]::Zero)|Out-Null
 if($script:tray -eq [IntPtr]::Zero){throw 'Test process tray window not found'}
 [void][SingleInstanceNative]::PostMessage($script:tray,6002,[IntPtr]::Zero,[IntPtr]0x205)
 $script:popup=[IntPtr]::Zero;$deadline=[datetime]::UtcNow.AddSeconds(10)
 while($script:popup -eq [IntPtr]::Zero -and [datetime]::UtcNow -lt $deadline){
  [SingleInstanceNative]::EnumWindows({param($h,$p)
   $owner=0;[void][SingleInstanceNative]::GetWindowThreadProcessId($h,[ref]$owner)
   $class=New-Object System.Text.StringBuilder 256;[void][SingleInstanceNative]::GetClassName($h,$class,256)
   if($owner -eq $ProcessId -and $class.ToString() -eq '#32768'){$script:popup=$h};return $true
  },[IntPtr]::Zero)|Out-Null
  if($script:popup -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 50}
 }
 if($script:popup -eq [IntPtr]::Zero){throw 'Test process tray popup not found'}
 $menu=[SingleInstanceNative]::SendMessage($script:popup,0x1e1,[IntPtr]::Zero,[IntPtr]::Zero)
 $command=$null
 for($i=0;$i -lt [SingleInstanceNative]::GetMenuItemCount($menu);$i++){
  $label=New-Object System.Text.StringBuilder 256;[void][SingleInstanceNative]::GetMenuString($menu,$i,$label,256,0x400)
  if(($Action -eq 'restart' -and $label.ToString() -match '(?i)restart') -or ($Action -eq 'quit' -and $label.ToString() -match '(?i)(quit|exit)')){$command=[SingleInstanceNative]::GetMenuItemID($menu,$i)}
 }
 [void][SingleInstanceNative]::PostMessage($script:tray,0x1f,[IntPtr]::Zero,[IntPtr]::Zero)
 if($null -eq $command){throw 'Requested test menu command not found'}
 [void][SingleInstanceNative]::PostMessage($script:tray,0x111,[IntPtr][long]$command,[IntPtr]::Zero)
}
$listeners=@(netstat -ano -p tcp | ForEach-Object {
 $fields=$_.Trim() -split '\s+'
 if($fields.Length -eq 5 -and $fields[3] -eq 'LISTENING' -and $fields[4] -eq [string]$ProcessId -and $fields[1] -match '^127\.0\.0\.1:(\d+)$') { [int]$Matches[1] }
})
@{found=($script:match -ne [IntPtr]::Zero);visible=[SingleInstanceNative]::IsWindowVisible($script:match);minimized=[SingleInstanceNative]::IsIconic($script:match);ports=$listeners} | ConvertTo-Json -Compress


