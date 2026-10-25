$ErrorActionPreference = 'Stop'
$headers = @{'X-Spoken-DNA' = 'local'}
try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/shutdown' -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
    Write-Output 'Stop requested. Active network requests finish or time out before exit; temporary media will be cleaned.'
} catch {
    Write-Output 'Service is not responding. Check runtime\logs if needed.'
}
