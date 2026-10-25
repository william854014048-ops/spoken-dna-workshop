$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $runtime 'temp') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $runtime 'logs') -Force | Out-Null
$env:PYTHONUTF8 = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:TEMP = Join-Path $runtime 'temp'
$env:TMP = $env:TEMP
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/health' -TimeoutSec 2
    if ($health.app -eq ([char]0x53e3).ToString() + ([char]0x64ad).ToString() + 'DNA') {
        Write-Output 'Already running: http://127.0.0.1:8765'
        exit 0
    }
    throw 'Port 8765 is occupied by another application.'
} catch {
    if ($_.Exception.Message -like 'Port 8765*') { throw }
}
$python = (Get-Command python -ErrorAction Stop).Source
& $python -B -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"
if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is required.' }
$script = Join-Path $root 'server.py'
$arguments = '-B -u "' + $script + '"'
$process = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'logs\startup.log') -RedirectStandardError (Join-Path $runtime 'logs\startup-error.log')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    if ($process.HasExited) { throw 'Service exited. Read runtime\logs\startup-error.log.' }
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/health' -TimeoutSec 1
        $state = Get-Content -LiteralPath (Join-Path $runtime 'server.json') -Encoding UTF8 -Raw | ConvertFrom-Json
        if ($health.pid -eq $state.pid) {
            Write-Output 'Ready: http://127.0.0.1:8765'
            exit 0
        }
    } catch {}
}
throw 'Service did not become ready. Read runtime\logs.'
