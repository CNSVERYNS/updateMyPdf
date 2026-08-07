Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
function Assert-Command($name) { if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name is required. Install it and rerun scripts/setup.ps1." } }
Assert-Command node
Assert-Command npm
Assert-Command docker
if (Get-Command az -ErrorAction SilentlyContinue) { Write-Host "Azure CLI detected." -ForegroundColor Green } else { Write-Warning "Azure CLI is not installed. Local mock mode still works; install Azure CLI before connecting Azure." }
$nodeVersion = [version]((node --version).TrimStart('v'))
if ($nodeVersion.Major -lt 20) { throw "Node.js 20 or newer is required." }
if (-not (Test-Path (Join-Path $root '.env'))) { Copy-Item (Join-Path $root '.env.example') (Join-Path $root '.env'); Write-Host "Created .env from .env.example; review it before using Azure." -ForegroundColor Yellow }
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data/translation') | Out-Null
Push-Location $root
try {
  npm install
  Push-Location apps/api; npm install; Pop-Location
  Push-Location apps/web; npm install; Pop-Location
  if (Get-Command python -ErrorAction SilentlyContinue) { Push-Location services/pdf-quality; python -m pip install -r requirements.txt; Pop-Location } else { Write-Warning "Python is not installed; the pdf-quality container still works through Docker, but local PyMuPDF tests are skipped." }
} finally { Pop-Location }
Write-Host "Setup complete. Run scripts/dev.ps1 for the Docker development stack." -ForegroundColor Green
