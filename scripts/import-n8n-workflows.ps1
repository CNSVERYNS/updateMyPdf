param([string]$N8nUrl = $(if ($env:N8N_BASE_URL) { $env:N8N_BASE_URL } else { 'http://localhost:5678' }), [string]$ApiKey = $env:N8N_API_KEY)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (-not $ApiKey) { Write-Host "Open n8n at $N8nUrl, use Import from File, and select n8n/workflows/*.json. Set N8N_API_KEY to automate import." -ForegroundColor Yellow; exit 0 }
$headers = @{ 'X-N8N-API-KEY' = $ApiKey; 'Content-Type' = 'application/json' }
Get-ChildItem (Join-Path (Split-Path -Parent $PSScriptRoot) 'n8n/workflows') -Filter '*.json' | ForEach-Object {
  $workflow = Get-Content -Raw $_.FullName | ConvertFrom-Json
  $payload = @{ name = $workflow.name; nodes = $workflow.nodes; connections = $workflow.connections; active = $false; settings = $workflow.settings } | ConvertTo-Json -Depth 30
  Invoke-RestMethod -Uri "$N8nUrl/api/v1/workflows" -Method Post -Headers $headers -Body $payload | Out-Null
  Write-Host "Imported $($_.Name)" -ForegroundColor Green
}
