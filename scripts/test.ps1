Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  npm run build
  Push-Location apps/api; npm run build; npm test; Pop-Location
  if (Get-Command python -ErrorAction SilentlyContinue) { Push-Location services/pdf-quality; python -m pytest -q; Pop-Location } else { Write-Warning "Python is not installed; skipped local PyMuPDF tests. Run them after installing Python or through Docker." }
  Push-Location apps/web; npm run build; Pop-Location
} finally { Pop-Location }
Write-Host "All configured test and build commands passed." -ForegroundColor Green
