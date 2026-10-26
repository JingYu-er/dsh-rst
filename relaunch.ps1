# dsh-rst relauncher.
#
# Spawned detached by the dsh-rst plugin (index.js) when the user types /rst.
# It is deliberately independent of the DSH process tree: it kills by PID only
# (never /T), so it survives the teardown it is orchestrating.
#
# Steps:
#   1. wait InitialDelayMs so the command result reaches the session log / UI
#   2. verify the parent process really is the DSH executable  (safety gate)
#   3. ask the shell to quit gracefully (taskkill without /F = WM_CLOSE)
#   4. if it is still alive after GraceMs, force-kill that PID
#   5. make sure the host process is gone (it owns the port + single-instance lock)
#   6. Start-Process the same executable, up to 3 attempts
#   7. verify a process with that name exists and log the result
#
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.

[CmdletBinding()]
param(
    [int]$ShellPid = 0,
    [int]$HostPid = 0,
    [string]$Exe = '',
    [string]$WorkDir = '',
    [string]$ExeArgs = '',
    [string]$LogPath = '',
    [int]$Port = 0,
    [int]$GraceMs = 2000,
    [int]$InitialDelayMs = 2000,
    [switch]$SkipShellCheck
)

$ErrorActionPreference = 'Continue'

if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = Join-Path ([IO.Path]::GetTempPath()) ('dsh-rst-' + $PID + '.log')
}
$logDir = Split-Path -Parent $LogPath
if (-not [string]::IsNullOrWhiteSpace($logDir)) {
    try { New-Item -ItemType Directory -Force -Path $logDir | Out-Null } catch { }
}

function Write-Log([string]$Message) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $Message)
    try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 -ErrorAction Stop } catch { }
}

function Test-Alive([int]$Id) {
    if ($Id -le 0) { return $false }
    return $null -ne (Get-Process -Id $Id -ErrorAction SilentlyContinue)
}

function Test-PortOpen([int]$PortNumber) {
    if ($PortNumber -le 0) { return $false }
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect('127.0.0.1', $PortNumber, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($async)
        return $true
    }
    catch { return $false }
    finally { if ($null -ne $client) { try { $client.Close() } catch { } } }
}

Write-Log ('helper start: helper={0} shell={1} host={2}' -f $PID, $ShellPid, $HostPid)
Write-Log ('exe={0} workdir={1} grace={2}ms' -f $Exe, $WorkDir, $GraceMs)

if ([string]::IsNullOrWhiteSpace($Exe)) {
    Write-Log 'abort: -Exe is empty'
    exit 2
}
if (-not (Test-Path -LiteralPath $Exe)) {
    Write-Log ('abort: exe not found: {0}' -f $Exe)
    exit 2
}

# --- 1) let the /rst result land before anything dies -----------------------
if ($InitialDelayMs -gt 0) { Start-Sleep -Milliseconds $InitialDelayMs }

# --- 2) safety gate: the parent must be the very exe we are about to relaunch
if ($ShellPid -gt 0 -and -not $SkipShellCheck) {
    $parent = Get-Process -Id $ShellPid -ErrorAction SilentlyContinue
    if ($null -eq $parent) {
        Write-Log ('abort: shell {0} is not running' -f $ShellPid)
        exit 3
    }
    $parentPath = $null
    try { $parentPath = $parent.Path } catch { }
    if ([string]::IsNullOrWhiteSpace($parentPath)) {
        Write-Log ('abort: cannot read the path of shell {0}' -f $ShellPid)
        exit 4
    }
    $expected = [IO.Path]::GetFileName($Exe)
    $actual = [IO.Path]::GetFileName($parentPath)
    if ($actual -ne $expected) {
        Write-Log ('abort: shell is {0} but expected {1} - refusing to kill it' -f $actual, $expected)
        exit 5
    }
    Write-Log ('shell verified: {0}' -f $parentPath)
}

# --- 3) graceful quit -------------------------------------------------------
if ($ShellPid -gt 0) {
    Write-Log ('graceful close of shell {0}' -f $ShellPid)
    & taskkill /PID $ShellPid 2>&1 | ForEach-Object { Write-Log ('  ' + $_) }
    $deadline = (Get-Date).AddMilliseconds([Math]::Max($GraceMs, 200))
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-Alive $ShellPid)) { break }
        Start-Sleep -Milliseconds 150
    }
}

# --- 4) force the shell if it is still there --------------------------------
if ($ShellPid -gt 0 -and (Test-Alive $ShellPid)) {
    Write-Log ('force kill of shell {0}' -f $ShellPid)
    & taskkill /F /PID $ShellPid 2>&1 | ForEach-Object { Write-Log ('  ' + $_) }
}

# --- 5) the host must really be gone (port + single-instance lock) ----------
if ($HostPid -gt 0) {
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-Alive $HostPid)) { break }
        Start-Sleep -Milliseconds 150
    }
    if (Test-Alive $HostPid) {
        Write-Log ('force kill of host {0}' -f $HostPid)
        & taskkill /F /PID $HostPid 2>&1 | ForEach-Object { Write-Log ('  ' + $_) }
        Start-Sleep -Milliseconds 400
    }
}

# --- 6) relaunch ------------------------------------------------------------
Start-Sleep -Milliseconds 500
if ($Port -gt 0) {
    $listener = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $listener) {
        if (-not (Test-PortOpen $Port)) { break }
        Start-Sleep -Milliseconds 200
    }
    if (Test-PortOpen $Port) {
        Write-Log ('warn: port {0} is still open after teardown; the new instance may refuse to start' -f $Port)
    }
    else {
        Write-Log ('port {0} is free' -f $Port)
    }
}
$attempt = 0
$launched = $false
while ($attempt -lt 3 -and -not $launched) {
    $attempt++
    try {
        # ProcessStartInfo passes Arguments verbatim; Start-Process would re-quote
        # the whole argument list and break shell redirection / quoted paths.
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $Exe
        if (-not [string]::IsNullOrWhiteSpace($ExeArgs)) { $psi.Arguments = $ExeArgs }
        if (-not [string]::IsNullOrWhiteSpace($WorkDir)) { $psi.WorkingDirectory = $WorkDir }
        $psi.UseShellExecute = $true
        $spawned = [System.Diagnostics.Process]::Start($psi)
        $launched = $true
        Write-Log ('launched on attempt {0} (pid {1})' -f $attempt, $spawned.Id)
    }
    catch {
        Write-Log ('launch failed on attempt {0}: {1}' -f $attempt, $_.Exception.Message)
        Start-Sleep -Milliseconds 900
    }
}

# --- 7) verify --------------------------------------------------------------
Start-Sleep -Milliseconds 1500
$name = [IO.Path]::GetFileNameWithoutExtension($Exe)
try {
    $running = Get-Process -Name $name -ErrorAction SilentlyContinue
    if ($null -ne $running) {
        $pids = ($running | ForEach-Object { $_.Id }) -join ','
        Write-Log ('ok: {0} is running (pid {1})' -f $name, $pids)
    }
    else {
        Write-Log ('warn: no process named {0} after launch' -f $name)
    }
}
catch {
    Write-Log ('warn: could not verify launch: {0}' -f $_.Exception.Message)
}

Write-Log 'done'
exit 0
