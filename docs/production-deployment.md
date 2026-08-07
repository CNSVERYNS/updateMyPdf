# Production deployment checklist

1. Azure Translator S1 + custom domain oluştur.
2. Private Storage Account ve üç container oluştur.
3. API container identity’sine `Storage Blob Data Contributor` ve gerektiğinde `Storage Blob Delegator` ver.
4. PostgreSQL managed instance veya güvenli PostgreSQL kullan.
5. Redis’i private network’e al.
6. `TRANSLATION_MOCK=false`, production CORS ve internal secret’ları set et.
7. Caddy ile yalnızca web/API domainlerini dışarı aç; n8n editor’ünü public yapma.
8. Blob lifecycle policy ile kaynak/çıktıları 24 saat sonra sil.
9. n8n credential’larını UI/secret store üzerinden oluştur.
10. Rate limit, backup, alerting ve Azure cost budget tanımla.

Azure’ın güncel Document Translation sürümü ve batch/synchronous ayrımı için [Microsoft’un güncel genel bakış sayfasını](https://learn.microsoft.com/en-us/azure/ai-services/translator/document-translation/latest/overview) referans al.
