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

# Keep one worker available for health probes while the other performs the
# CPU-heavy PDF capture comparison.
az containerapp update `
  --name $QualityApp `
  --resource-group $ResourceGroup `
  --cpu 1 `
  --memory 2Gi
