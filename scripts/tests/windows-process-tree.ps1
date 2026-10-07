function Get-ProcessTreeSnapshot {
    param([object[]]$Processes, [int]$RootIdentifier)
    $byIdentifier = @{}
    foreach ($entry in $Processes) { $byIdentifier[[int]$entry.ProcessId] = $entry }
    if (-not $byIdentifier.ContainsKey($RootIdentifier)) { throw 'Root process no longer exists' }
    $selected = @{}
    $selected[$RootIdentifier] = $byIdentifier[$RootIdentifier]
    do {
        $changed = $false
        foreach ($entry in $Processes) {
            $identifier = [int]$entry.ProcessId
            $parent = [int]$entry.ParentProcessId
            # Windows retains an exited parent's PID. It may now identify a
            # completely different process; a real child cannot predate it.
            if (-not $selected.ContainsKey($identifier) -and $selected.ContainsKey($parent) -and
                [datetime]$entry.CreationDate -ge [datetime]$selected[$parent].CreationDate) {
                $selected[$identifier] = $entry
                $changed = $true
            }
        }
    } while ($changed)
    @($selected.Values)
}
