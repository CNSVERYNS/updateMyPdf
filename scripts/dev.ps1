Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try { docker compose up -d --build } finally { Pop-Location }
Write-Host "Web: http://localhost:3000 | API: http://localhost:4000/health | n8n: http://localhost:5678" -ForegroundColor Green
