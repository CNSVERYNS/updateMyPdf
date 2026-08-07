Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
foreach ($name in @('az','docker','node')) { if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name is required." } }
az account show | Out-Null
$required = @('AZURE_TRANSLATOR_ENDPOINT','AZURE_TRANSLATOR_KEY','AZURE_STORAGE_ACCOUNT_NAME','AZURE_RESOURCE_GROUP')
$missing = @($required | Where-Object { -not (Get-Item "Env:$_" -ErrorAction SilentlyContinue) -or -not (Get-Item "Env:$_").Value })
if ($missing.Count -gt 0) { Write-Warning ("Missing environment variables: " + ($missing -join ', ')) }
if ($env:AZURE_STORAGE_ACCOUNT_NAME) { az storage container list --account-name $env:AZURE_STORAGE_ACCOUNT_NAME --auth-mode login --query "[].name" -o tsv }
if ($env:AZURE_TRANSLATOR_ENDPOINT) {
  $version = if ($env:AZURE_TRANSLATOR_API_VERSION) { $env:AZURE_TRANSLATOR_API_VERSION } else { '2026-03-01' }
  $uri = "$($env:AZURE_TRANSLATOR_ENDPOINT.TrimEnd('/'))/translator/document/formats?api-version=$version&type=document"
  try { Invoke-RestMethod -Uri $uri -Headers @{ 'Ocp-Apim-Subscription-Key' = $env:AZURE_TRANSLATOR_KEY } -Method Get | Out-Null; Write-Host "Translator endpoint responded with 200." -ForegroundColor Green } catch { Write-Warning "Translator endpoint check failed: $($_.Exception.Message)" }
}
