param([string]$ApiUrl = $(if ($env:TRANSLATION_API_URL) { $env:TRANSLATION_API_URL } else { 'http://localhost:4000' }))
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$headers = @{}
if ($env:INTERNAL_API_SECRET) { $headers['x-internal-api-secret'] = $env:INTERNAL_API_SECRET }
Invoke-RestMethod -Uri "$($ApiUrl.TrimEnd('/'))/api/v1/cleanup" -Method Post -Headers $headers | ConvertTo-Json
