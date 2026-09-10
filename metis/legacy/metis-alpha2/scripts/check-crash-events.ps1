$events = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'} -MaxEvents 10 -ErrorAction SilentlyContinue
foreach ($e in $events) {
  $msg = $e.Message
  if ($msg.Length -gt 700) { $msg = $msg.Substring(0,700) }
  Write-Output ("=== {0}" -f $e.TimeCreated)
  Write-Output $msg
}
