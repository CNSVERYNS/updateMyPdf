param(
  [string]$ResourceGroup = "updatemypdf-rg",
  [string]$QualityApp = "updatemypdf-quality"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# The quality app is private to the Container Apps environment. Keep its
# internal HTTP ingress open so the API's POST requests are not redirected to
# HTTPS (Azure's redirect changes multipart POST requests into GET requests).
az containerapp ingress enable `
  --name $QualityApp `
  --resource-group $ResourceGroup `
  --type internal `
  --allow-insecure true `
  --target-port 8000 `
  --transport http
