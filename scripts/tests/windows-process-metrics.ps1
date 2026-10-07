param([Parameter(Mandatory = $true)][int]$RootProcessIdentifier)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. "$PSScriptRoot/windows-process-tree.ps1"
$allProcesses = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate
$tree = @(Get-ProcessTreeSnapshot $allProcesses $RootProcessIdentifier)
function Read-Metrics {
    @(foreach ($identity in $tree) {
        $entry = Get-Process -Id $identity.ProcessId -ErrorAction SilentlyContinue
        if ($entry -and [Math]::Abs(($entry.StartTime.ToUniversalTime() - ([datetime]$identity.CreationDate).ToUniversalTime()).TotalMilliseconds) -lt 1) {
          [pscustomobject]@{
            id = $entry.Id
            name = $entry.ProcessName
            startedAt = $entry.StartTime.ToUniversalTime().ToString('o')
            workingSetBytes = $entry.WorkingSet64
            privateBytes = $entry.PrivateMemorySize64
            handles = $entry.Handles
            cpuMilliseconds = $entry.TotalProcessorTime.TotalMilliseconds
          }
        }
    })
}
$before = Read-Metrics
$timer = [System.Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Milliseconds 1000
$after = Read-Metrics
$elapsed = $timer.Elapsed.TotalMilliseconds
$cpuDelta = 0
foreach ($entry in $after) {
    $previous = $before | Where-Object { $_.id -eq $entry.id }
    if ($previous) { $cpuDelta += [Math]::Max(0, $entry.cpuMilliseconds - $previous.cpuMilliseconds) }
}
[pscustomobject]@{
    processCount = $after.Count
    workingSetBytes = ($after | Measure-Object workingSetBytes -Sum).Sum
    privateBytes = ($after | Measure-Object privateBytes -Sum).Sum
    handles = ($after | Measure-Object handles -Sum).Sum
    cpuPercentOneCore = 100 * $cpuDelta / $elapsed
    cpuPercentMachine = 100 * $cpuDelta / $elapsed / [Environment]::ProcessorCount
    intervalMilliseconds = $elapsed
    processes = $after
} | ConvertTo-Json -Depth 5 -Compress
