# updateMyPDF SEO foundation

The public site now has a crawlable multilingual content layer alongside the
interactive PDF workspace.

## Implemented

- Unique Turkish metadata on the root application page.
- `WebSite` and `SoftwareApplication` JSON-LD on the root page.
- Localized, indexable guides at `/tr/`, `/en/`, `/es/`, `/de/`, `/fr/`,
  `/it/`, `/pt/`, and `/nl/`.
- One canonical URL and a complete `hreflang` set on each language page.
- Localized titles, descriptions, headings, FAQs, calls to action, and
  `Article` structured data.
- `public/robots.txt` with private review/document routes excluded.
- `public/sitemap.xml` with the root and all language guides.
- Crawlable language links in the interactive application footer.

## Search Console handoff

1. Add and verify `https://www.updatemypdf.com/` as a Domain property in
   Google Search Console.
2. Submit `https://www.updatemypdf.com/sitemap.xml`.
3. Inspect `/`, `/tr/`, `/en/`, and `/es/` after deployment and request an
   initial recrawl.
4. Watch indexing, Core Web Vitals, queries, and country/language performance
   for the first 28 days before changing titles.

## Content direction

The pages target useful intent such as PDF translation, layout-aware document
translation, AI PDF editing, and searchable PDF text replacement. Future
articles should answer a distinct user question with examples and screenshots;
duplicating the same article across languages without real localization should
be avoided. The scan-to-editable-PDF/OCR service is intentionally not promoted
as an available feature yet.
