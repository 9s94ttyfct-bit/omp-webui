# omp-webui update helper for the Windows launcher (#571; helper.sh is the macOS app's). The server writes this file into
# <data dir>\update\ and starts it, hidden and detached, then exits itself: it runs from there and never from inside the
# folder it replaces.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File helper.ps1 -Id <id> -AppPid <server pid>
#     -Installed <folder> -Staged <folder>.updating -Backup <folder>.previous -StateDir <dir> -QuitSecs <n> -StartSecs <n>
#     -From <version> -To <version> -Exe <folder>\omp-webui.exe
#
# It waits for the server to exit, looks once more at the staged folder, swaps it in by rename (the old folder stays as
# <Backup>), starts the new omp-webui.exe in a console of its own (as a double-click would) and waits for the new server to
# say it is up (<StateDir>\ack.json with this id). Anything that fails puts the old folder back and starts it again; the
# reason is written to <StateDir>\result.json for the next server to show. After a start that worked the backup is removed
# and nothing is written: the new server writes the success itself when it says it is up. The outcomes and files are
# helper.sh's.
#
# ASCII only: Windows PowerShell reads a script without a byte-order mark in the ANSI code page, and the server writes it
# as it is.
param(
	[Parameter(Mandatory = $true)][string]$Id,
	[Parameter(Mandatory = $true)][int]$AppPid,
	[Parameter(Mandatory = $true)][string]$Installed,
	[Parameter(Mandatory = $true)][string]$Staged,
	[Parameter(Mandatory = $true)][string]$Backup,
	[Parameter(Mandatory = $true)][string]$StateDir,
	[Parameter(Mandatory = $true)][int]$QuitSecs,
	[Parameter(Mandatory = $true)][int]$StartSecs,
	[Parameter(Mandatory = $true)][string]$From,
	[Parameter(Mandatory = $true)][string]$To,
	[Parameter(Mandatory = $true)][string]$Exe
)
$ErrorActionPreference = "Continue"
$ack = Join-Path $StateDir "ack.json"
$handover = Join-Path $StateDir "handover.json"
$result = Join-Path $StateDir "result.json"

# First of all: say this script runs. The server waits for this file before it exits, so that a PowerShell that never ran
# the script (a policy, security software) leaves the server running to say so, instead of an app that just closed.
[System.IO.File]::WriteAllText((Join-Path $StateDir "helper-started-$Id"), "$PID")

# Straight to this process's output (the helper's log), never to the pipeline: a function that returns a value and logs
# would otherwise return the line too.
function Log([string]$message) {
	[Console]::Out.WriteLine(("{0} {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ss"), $message))
}

# Write how this ended, for the next server (atomically: it may look at once; without a byte-order mark, which JSON.parse
# refuses).
function Fail([string]$problem) {
	$json = @{ id = $Id; ok = $false; from = $From; to = $To; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); problem = $problem } | ConvertTo-Json -Compress
	$tmp = "$result.$PID"
	try {
		[System.IO.File]::WriteAllText($tmp, $json)
		Move-Item -LiteralPath $tmp -Destination $result -Force
	} catch {
		Log "the result could not be written: $_"
	}
	Log "failed: $problem"
}

function Remove-Tree([string]$path) {
	if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
}

function Remove-File([string]$path) {
	Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}

# A folder renamed: one move in one folder, so nothing is copied. Windows refuses it while a program in it is still running
# or a file in it is open (an antivirus scan of the new program, a process that is ending), so it is tried for a while.
function Move-Folder([string]$from, [string]$to) {
	$why = $null
	for ($i = 0; $i -lt 20; $i++) {
		try {
			[System.IO.Directory]::Move($from, $to)
			return $true
		} catch {
			$why = $_
			Start-Sleep -Milliseconds 500
		}
	}
	Log "could not move $from to ${to}: $why"
	return $false
}

# The program in the installed folder started as a person's double-click would: in a console of its own, from its folder.
function Start-App {
	try {
		return Start-Process -FilePath $Exe -WorkingDirectory $Installed -PassThru -ErrorAction Stop
	} catch {
		Log "could not start ${Exe}: $_"
		return $null
	}
}

Log "waiting for pid $AppPid to exit (up to $QuitSecs s)"
$deadline = (Get-Date).AddSeconds($QuitSecs)
while (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) {
	if ((Get-Date) -gt $deadline) {
		Fail "quitTimeout"
		Remove-Tree $Staged
		Remove-File $handover
		exit 1
	}
	Start-Sleep -Milliseconds 200
}
Log "the server has exited"

# The last look: the staged folder still holds the program and its page, and the program says it is the version installed.
$bad = $false
$stagedExe = Join-Path $Staged "omp-webui.exe"
if (-not (Test-Path -LiteralPath $stagedExe -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $Staged "web\index.html") -PathType Leaf)) {
	$bad = $true
} else {
	# The exit code is read before anything else runs: `Select-Object -First` in the same pipeline could stop it early and
	# leave $LASTEXITCODE unset.
	$out = & $stagedExe --version 2>$null
	$code = $LASTEXITCODE
	$said = $out | Select-Object -First 1
	if ($code -ne 0 -or "$said".Trim() -ne $To) { $bad = $true }
}
if ($bad) {
	Log "the staged folder is not fit to install"
	Fail "verify"
	Remove-Tree $Staged
	Remove-File $handover
	[void](Start-App)
	exit 1
}

# The swap: two renames beside each other. The old folder is the backup until the new program is up.
Remove-Tree $Backup
if (-not (Move-Folder $Installed $Backup)) {
	Fail "swap"
	Remove-Tree $Staged
	Remove-File $handover
	[void](Start-App)
	exit 1
}
if (-not (Move-Folder $Staged $Installed)) {
	if (Move-Folder $Backup $Installed) { Fail "swap" } else { Fail "rollbackFailed" }
	Remove-File $handover
	[void](Start-App)
	exit 1
}
Log "swapped; the old folder is $Backup"

Remove-File $ack
$problem = "didNotStart"
$app = Start-App
if ($null -eq $app) {
	$problem = "swap"
} else {
	$deadline = (Get-Date).AddSeconds($StartSecs)
	while ((Get-Date) -lt $deadline) {
		if ((Test-Path -LiteralPath $ack) -and ((Get-Content -LiteralPath $ack -Raw -ErrorAction SilentlyContinue) -like "*`"id`":`"$Id`"*")) {
			Remove-Tree $Backup
			Remove-File $ack
			Remove-File $handover
			Log "the new program is up; the backup is removed"
			exit 0
		}
		# A program that has ended without saying it is up is not going to: there is no need to wait out the rest.
		if ($app.HasExited) {
			Start-Sleep -Milliseconds 500
			if ((Test-Path -LiteralPath $ack) -and ((Get-Content -LiteralPath $ack -Raw -ErrorAction SilentlyContinue) -like "*`"id`":`"$Id`"*")) { continue }
			Log "the new program ended (exit $($app.ExitCode)) without saying it is up"
			break
		}
		Start-Sleep -Milliseconds 500
	}
}

# It did not start: whatever of it runs is ended (programs started from the installed folder only), and the old folder is
# put back and started.
Log "the new program did not start ($problem): putting the old one back"
$prefix = $Installed.TrimEnd("\") + "\"
foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
	$path = $null
	try { $path = $p.Path } catch { }
	if ($path -and $path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
		Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
	}
}
Start-Sleep -Seconds 2
# The new folder is moved aside, not removed, until the old one is back in its place: whatever fails, there is a program
# at the installed path (a rollback that removed the new one first and then could not rename the backup left none at all).
$aside = "$Installed.failed"
Remove-Tree $aside
if (Move-Folder $Installed $aside) {
	if (Move-Folder $Backup $Installed) {
		Remove-Tree $aside
		Fail $problem
	} else {
		[void](Move-Folder $aside $Installed)
		Fail "rollbackFailed"
		Remove-File $handover
		exit 1
	}
} else {
	Fail "rollbackFailed"
	Remove-File $handover
	exit 1
}
Remove-File $ack
Remove-File $handover
[void](Start-App)
exit 1
