param(
  [string]$SubscriptionId = $env:AZURE_SUBSCRIPTION_ID,
  [string]$ResourceGroup = $env:AZURE_RESOURCE_GROUP,
  [string]$Location = $env:AZURE_LOCATION,
  [string]$TranslatorName = $env:AZURE_TRANSLATOR_NAME,
  [string]$StorageAccountName = $env:AZURE_STORAGE_ACCOUNT_NAME
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (-not $ResourceGroup) { $ResourceGroup = "updatemypdf-rg" }
if (-not $Location) { $Location = "eastus" }
if (-not $TranslatorName) { $TranslatorName = "updatemypdf-translator" }
if (-not $StorageAccountName) { $StorageAccountName = ("updatemypdf" + (Get-Random -Minimum 10000 -Maximum 99999)).ToLower() }

az account show | Out-Null
if ($SubscriptionId) { az account set --subscription $SubscriptionId }
az group create --name $ResourceGroup --location $Location | Out-Null

$storage = ''
$storage = az storage account list --resource-group $ResourceGroup --query "[?name=='$StorageAccountName'].name | [0]" -o tsv
if (-not $storage) {
  az storage account create --name $StorageAccountName --resource-group $ResourceGroup --location $Location --sku Standard_LRS --kind StorageV2 --allow-blob-public-access false --min-tls-version TLS1_2 --https-only true | Out-Null
}
foreach ($container in @("translation-source", "translation-target", "translation-quarantine")) {
  az storage container create --name $container --account-name $StorageAccountName --auth-mode login | Out-Null
}

$translator = ''
$translator = az cognitiveservices account list --resource-group $ResourceGroup --query "[?name=='$TranslatorName'].name | [0]" -o tsv
if (-not $translator) {
  az cognitiveservices account create --name $TranslatorName --resource-group $ResourceGroup --location global --kind TextTranslation --sku S1 --custom-domain $TranslatorName | Out-Null
}

Write-Host "Azure resources are ready." -ForegroundColor Green
Write-Host "Resource group: $ResourceGroup"
Write-Host "Storage account: $StorageAccountName"
Write-Host "Translator: $TranslatorName"
Write-Host "Next: grant the API managed identity Storage Blob Data Contributor and Storage Blob Delegator, then set AZURE_TRANSLATOR_ENDPOINT and AZURE_TRANSLATOR_KEY in the server environment."
