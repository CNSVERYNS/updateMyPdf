# Document Quality Control TODO

Bu katalog PDF ve Word çevirilerinde teslim edilebilir çıktıyı belirleyen kalite kriterlerinin ana listesidir. Her kriter kodla takip edilir; `[x]` tamamlandı, `[~]` kısmen mevcut, `[ ]` yapılacak, `[!]` dış doğrulama/ürün kararı bekliyor anlamına gelir.

Kural: Bir kriter kodu tamamlanmadan “tamamlandı” işaretlenmez. Kalite kapısı bir dosyayı ancak kritik kriterlerin tamamı geçerse teslim eder. Bölgesel font küçültme yalnızca ilgili kutu/frame/kolon bölgesine uygulanır; bütün sayfa global olarak küçültülmez.

## 1. QC-FND — kalite motoru temeli

- [x] QC-FND-001: Kalite servisi ulaşılamadığında çıktı fail-closed reddedilir.
- [x] QC-FND-002: Kalite isteğinde redirect kabul edilmez; POST başka metoda dönemez.
- [x] QC-FND-003: Kalite servisi timeout değeri yapılandırılabilir.
- [x] QC-FND-004: Her kalite katmanı score/status/details üretir.
- [x] QC-FND-005: En zayıf kritik katman genel skoru sınırlayabilir.
- [x] QC-FND-006: Kaynak ve sonuç dosyası byte/page temelinde raporlanır.
- [~] QC-FND-007: Her kriterin makinece okunabilir criterion code alanı rapora eklenecek.
- [ ] QC-FND-008: Kritik ve uyarı seviyelerinin ayrı karar matrisi uygulanacak.
- [~] QC-FND-009: Region/frame ve geometry hataları için kaynak/result koordinatı üretiliyor; tüm kriterlere genişletilecek.
- [ ] QC-FND-010: Aynı kriterin tekrar eden hataları deduplicate edilecek.
- [ ] QC-FND-011: Kalite raporu schema version alanı taşıyacak.
- [ ] QC-FND-012: Renderer ve inspector aynı layout modelini paylaşacak.

## 2. QC-PDF — PDF dosya ve sayfa bütünlüğü

- [x] QC-PDF-001: PDF parse edilebilir olmalı.
- [x] QC-PDF-002: Şifreli/parolalı PDF açıkça reddedilmeli.
- [x] QC-PDF-003: Kaynak/result sayfa sayısı eşleşmeli.
- [x] QC-PDF-004: Sayfa genişlik/yükseklik tolerans içinde eşleşmeli.
- [x] QC-PDF-005: Sonuçta boş sayfa oluşmamalı.
- [x] QC-PDF-006: Sayfa dışına taşan text span reddedilmeli.
- [x] QC-PDF-007: Metin karakter ve kelime kaybı oranı kontrol edilmeli.
- [x] QC-PDF-008: Metin blok kapsamı ve konum kapsamı kontrol edilmeli.
- [~] QC-PDF-009: Görsel/image varlık kaybı sayısal kontrol ediliyor; xref/alan eşleşmesi genişletilecek.
- [x] QC-PDF-010: Vektör drawing kaybı kontrol edilmeli.
- [ ] QC-PDF-011: Linklerin URI, rect ve sayfa hedefleri eşleşmeli.
- [ ] QC-PDF-012: Annotation, form field ve widget kaybı kontrol edilmeli.
- [ ] QC-PDF-013: PDF metadata ve producer değişimi raporlanmalı; tek başına fail sebebi olmamalı.
- [ ] QC-PDF-014: CropBox/MediaBox/TrimBox/BleedBox eşleşmeli.
- [ ] QC-PDF-015: Page rotation ve user unit korunmalı.
- [ ] QC-PDF-016: Transparency/blend mode kaybı kontrol edilmeli.
- [ ] QC-PDF-017: Clipping path ve mask kaybı kontrol edilmeli.
- [ ] QC-PDF-018: Embedded font/resource eksikliği kontrol edilmeli.
- [ ] QC-PDF-019: Font encoding ve ToUnicode eksikliği tespit edilmeli.
- [ ] QC-PDF-020: Content stream bozulması ve parse warning raporlanmalı.
- [ ] QC-PDF-021: Katman/Optional Content Group kaybı kontrol edilmeli.
- [ ] QC-PDF-022: Bookmark/outline ağacı korunmalı.
- [ ] QC-PDF-023: Named destination ve internal anchor korunmalı.
- [ ] QC-PDF-024: Tagged PDF structure tree kaybı kontrol edilmeli.
- [ ] QC-PDF-025: PDF/A/X uyumluluk iddiası varsa ayrı validator çalışmalı.

## 3. QC-GEO — geometrik ve bölgesel layout güvenliği

- [x] QC-GEO-001: Text block konum drift kontrolü.
- [x] QC-GEO-002: Text line overlap kontrolü.
- [x] QC-GEO-003: Text block overlap kontrolü.
- [x] QC-GEO-004: Text line page overflow kontrolü.
- [x] QC-GEO-005: Kaynak region içinde result line eşleştirme.
- [x] QC-GEO-006: Kaynak frame öncesi/sonrası güvenlik tamponu.
- [x] QC-GEO-007: Vector rectangle/box/frame bölgeleri çıkarılmalı.
- [x] QC-GEO-008: Frame sınırları kaynak/result koordinat bazında eşleşmeli.
- [x] QC-GEO-009: Frame içindeki text’in frame sınırları dışına çıkması reddedilmeli.
- [ ] QC-GEO-010: Kutu içi padding/top/left/right/bottom korunmalı.
- [ ] QC-GEO-011: Kutu içinde text’in dikey hizası korunmalı.
- [ ] QC-GEO-012: Kutu içinde text’in yatay hizası korunmalı.
- [ ] QC-GEO-013: Kutu içinde çok satırlı baseline aralığı çakışmamalı.
- [ ] QC-GEO-014: Kutu içinde son satır alt sınıra taşmamalı.
- [ ] QC-GEO-015: Kutu içinde Türkçe uzama için yalnız ilgili bölge fit edilmeli.
- [ ] QC-GEO-016: Frame dışındaki metin frame içine taşmamalı.
- [ ] QC-GEO-017: Frame içindeki metin başka frame alanına taşmamalı.
- [ ] QC-GEO-018: Dikey çizgi/ayraç ile text overlap kontrol edilmeli.
- [ ] QC-GEO-019: Yatay çizgi/underline ile text overlap kontrol edilmeli.
- [ ] QC-GEO-020: Checkbox/radio işareti ile label overlap kontrol edilmeli.
- [ ] QC-GEO-021: Tablo hücresi sınırları ve hücre padding’i korunmalı.
- [ ] QC-GEO-022: Tablo satır yüksekliği ve kolon genişliği kontrol edilmeli.
- [ ] QC-GEO-023: Birleşik/merged hücre geometrisi kontrol edilmeli.
- [ ] QC-GEO-024: Çok kolonlu text region tespit edilmeli.
- [ ] QC-GEO-025: Kolon sırası ve kolonlar arası gutter korunmalı.
- [ ] QC-GEO-026: Kolon text’inin komşu kolona sızması reddedilmeli.
- [ ] QC-GEO-027: Header/footer güvenli alanı korunmalı.
- [ ] QC-GEO-028: Kenar boşluğu minimumları bölge türüne göre kontrol edilmeli.
- [ ] QC-GEO-029: Orphan/widow satırları tespit edilmeli.
- [ ] QC-GEO-030: Sayfa sonu ve frame sonu arasında bölünemez bloklar korunmalı.

## 4. QC-TYP — font, boyut, satır ve stil

- [x] QC-TYP-001: Font family eşleşmesi/fallback raporlanıyor.
- [x] QC-TYP-002: Font size ve visual span height karşılaştırılıyor.
- [x] QC-TYP-003: Bold/italic/style flag karşılaştırılıyor.
- [x] QC-TYP-004: Minimum okunabilir font boyutu kontrol ediliyor.
- [x] QC-TYP-005: Tek satırlık uzun Türkçe label yatay fit ediliyor.
- [ ] QC-TYP-006: Font fallback family metrik olarak en yakın serif/sans family seçmeli.
- [ ] QC-TYP-007: Font weight değişimi ayrı kriter olmalı.
- [ ] QC-TYP-008: Font italic angle değişimi ayrı kriter olmalı.
- [ ] QC-TYP-009: Letter spacing/character spacing farkı kontrol edilmeli.
- [ ] QC-TYP-010: Word spacing farkı kontrol edilmeli.
- [ ] QC-TYP-011: Line height ve leading farkı kontrol edilmeli.
- [ ] QC-TYP-012: Baseline shift/superscript/subscript korunmalı.
- [ ] QC-TYP-013: Small caps ve text transform korunmalı.
- [ ] QC-TYP-014: Heading/body font hiyerarşisi korunmalı.
- [ ] QC-TYP-015: Başlık ile altbaşlık arasındaki mesafe korunmalı.
- [ ] QC-TYP-016: Başlıkların frame/box içindeki hizası korunmalı.
- [ ] QC-TYP-017: Paragraf alignment ve justification korunmalı.
- [ ] QC-TYP-018: İlk satır girintisi ve hanging indent korunmalı.
- [ ] QC-TYP-019: Bullet/number indent ve bullet glyph korunmalı.
- [ ] QC-TYP-020: Tab stop konumları korunmalı.
- [ ] QC-TYP-021: Alt çizgi/üst çizgi/strike-through korunmalı.
- [ ] QC-TYP-022: Partial regional scaling kararı tüm sayfa scaling’den bağımsız raporlanmalı.

## 5. QC-COL — renk ve çizgi görünümü

- [x] QC-COL-001: Text color consistency kontrolü.
- [x] QC-COL-002: Rendered background mismatch kontrolü.
- [ ] QC-COL-003: Fill color ve frame fill eşleşmeli.
- [ ] QC-COL-004: Border/stroke color eşleşmeli.
- [ ] QC-COL-005: Stroke width ve dash pattern korunmalı.
- [ ] QC-COL-006: Opacity/transparency farkı kontrol edilmeli.
- [ ] QC-COL-007: Color space/ICC profile değişimi raporlanmalı.
- [ ] QC-COL-008: Grayscale renklerin yanlış renge dönüşmesi yakalanmalı.
- [ ] QC-COL-009: Highlight/background plate text’i kapatmamalı.
- [ ] QC-COL-010: Link renkleri ve visited state korunmalı.
- [ ] QC-COL-011: Checkbox/radio fill ve stroke renkleri korunmalı.
- [ ] QC-COL-012: Renk farkı hem object hem raster capture seviyesinde ölçülmeli.

## 6. QC-VIS — visual capture ve görsel varlıklar

- [x] QC-VIS-001: Kaynak/result rendered page capture alınabiliyor.
- [x] QC-VIS-002: Capture grid luminance/ink density karşılaştırması.
- [x] QC-VIS-003: Sayfa genel visual preflight.
- [x] QC-VIS-004: AI source/result capture karşılaştırması.
- [ ] QC-VIS-005: Capture karşılaştırması bölgeler bazında yapılmalı.
- [ ] QC-VIS-006: Dikey düzlem (y-axis) ink/edge continuity kontrolü.
- [ ] QC-VIS-007: Yatay düzlem (x-axis) ink/edge continuity kontrolü.
- [ ] QC-VIS-008: Frame/box edge continuity kontrolü.
- [ ] QC-VIS-009: Text baseline heatmap karşılaştırması.
- [ ] QC-VIS-010: Heading/subheading visual hierarchy karşılaştırması.
- [ ] QC-VIS-011: Kolon/gutter heatmap karşılaştırması.
- [ ] QC-VIS-012: Kutu içi padding heatmap karşılaştırması.
- [ ] QC-VIS-013: Çizgi, border ve divider detection.
- [ ] QC-VIS-014: Logo/image aspect ratio karşılaştırması.
- [ ] QC-VIS-015: Image crop ve focal region kayması kontrolü.
- [ ] QC-VIS-016: Görsel interpolation/blur ve çözünürlük kaybı kontrolü.
- [ ] QC-VIS-017: QR/barcode quiet-zone ve okunabilirlik kontrolü.
- [ ] QC-VIS-018: Signature/seal/stamp region korunmalı.
- [ ] QC-VIS-019: Watermark/background pattern korunmalı.
- [ ] QC-VIS-020: Rasterized text ile gerçek text ayrımı raporlanmalı.
- [ ] QC-VIS-021: Screenshot diff ve object diff birlikte kullanılmalı.
- [ ] QC-VIS-022: AI “manual_review” durumunda kritik issue sınıfları ayrıştırılmalı.

## 7. QC-AI — AI visual review güvenliği

- [x] QC-AI-001: AI review yapılandırılmış JSON bekliyor.
- [x] QC-AI-002: AI review parse edilemezse durum failed/invalid raporlanıyor.
- [x] QC-AI-003: AI modeline kaynak ve çevrilmiş capture birlikte veriliyor.
- [ ] QC-AI-004: AI prompt yatay/dikey/frame/box/column/heading kriterlerini ayrı ayrı istemeli.
- [ ] QC-AI-005: AI issue’ları criterion code ile etiketlemeli.
- [ ] QC-AI-006: AI issue koordinat/region kanıtı üretmeli.
- [ ] QC-AI-007: AI font küçülmesini “görsel fark” ve “okunamazlık” olarak ayırmalı.
- [ ] QC-AI-008: AI translation wording’i layout defect olarak değerlendirmemeli.
- [ ] QC-AI-009: AI manual_review ile hard_fail ayrımı uygulanmalı.
- [ ] QC-AI-010: AI confidence düşükse deterministik katman kararı korunmalı.
- [ ] QC-AI-011: AI kaynak/result sayfa eşleşmesi yapmalı.
- [ ] QC-AI-012: AI kolon ve tablo bozulmasını özel sınıf olarak raporlamalı.
- [ ] QC-AI-013: AI kutu içi taşmayı özel sınıf olarak raporlamalı.
- [ ] QC-AI-014: AI frame çizgisi ile text çakışmasını özel sınıf olarak raporlamalı.
- [ ] QC-AI-015: AI raporları regression fixture olarak saklanmalı.

## 8. QC-DOCX — Word/DOCX kalite kontrolü

- [ ] QC-DOCX-001: DOCX ZIP/XML parse edilebilir olmalı.
- [ ] QC-DOCX-002: Document section/page size korunmalı.
- [ ] QC-DOCX-003: Section margins korunmalı.
- [ ] QC-DOCX-004: Header/footer içeriği korunmalı.
- [ ] QC-DOCX-005: Page break/section break korunmalı.
- [ ] QC-DOCX-006: Paragraph count ve text coverage kontrol edilmeli.
- [ ] QC-DOCX-007: Run font family/size/color karşılaştırılmalı.
- [ ] QC-DOCX-008: Run bold/italic/underline/strike korunmalı.
- [ ] QC-DOCX-009: Paragraph alignment/indent/spacing korunmalı.
- [ ] QC-DOCX-010: Line spacing ve widow/orphan settings korunmalı.
- [ ] QC-DOCX-011: Heading styles ve outline levels korunmalı.
- [ ] QC-DOCX-012: Bullet/numbering definitions ve indent korunmalı.
- [ ] QC-DOCX-013: Table count ve row/column sayıları korunmalı.
- [ ] QC-DOCX-014: Table cell merge/gridSpan/vMerge korunmalı.
- [ ] QC-DOCX-015: Table width/row height/cell margins korunmalı.
- [ ] QC-DOCX-016: Cell vertical/horizontal alignment korunmalı.
- [ ] QC-DOCX-017: Cell borders/fills/colors korunmalı.
- [ ] QC-DOCX-018: Text box/shape drawing XML korunmalı.
- [ ] QC-DOCX-019: Shape anchor/wrap/position korunmalı.
- [ ] QC-DOCX-020: Shape içindeki text frame padding korunmalı.
- [ ] QC-DOCX-021: Image count, dimensions, crop ve anchor korunmalı.
- [ ] QC-DOCX-022: Hyperlink/bookmark/comment/footnote korunmalı.
- [ ] QC-DOCX-023: Alt text ve accessibility metadata korunmalı.
- [ ] QC-DOCX-024: DOCX PDF preview capture ile görsel kontrol yapılmalı.
- [ ] QC-DOCX-025: DOCX kalite servisi unavailable olduğunda çıktı teslim edilmemeli.

## 9. QC-TSL — translation and content safety

- [x] QC-TSL-001: Boş translation block reddediliyor.
- [x] QC-TSL-002: Aşırı sayıda unchanged substantive block reddediliyor.
- [x] QC-TSL-003: Eksik block/failed block renderer sonucu reddediliyor.
- [ ] QC-TSL-004: Placeholder token sayısı ve konumu korunmalı.
- [ ] QC-TSL-005: URL/email/phone/date/number token’ları korunmalı.
- [ ] QC-TSL-006: Legal/form case number gibi exact token’lar korunmalı.
- [ ] QC-TSL-007: Barcode/QR altındaki token’lar değiştirilmemeli.
- [ ] QC-TSL-008: HTML/XML/markdown benzeri inline markup korunmalı.
- [ ] QC-TSL-009: RTL dil yönü ve bidi isolations korunmalı.
- [ ] QC-TSL-010: Unicode normalization ve combining mark kaybı kontrol edilmeli.
- [ ] QC-TSL-011: Turkish İ/ı/Ş/ş/Ğ/ğ/Ç/ç/Ö/ö/Ü/ü glyph coverage kontrol edilmeli.
- [ ] QC-TSL-012: CJK/Arabic/Devanagari gibi script coverage kontrol edilmeli.
- [ ] QC-TSL-013: Dil yönüne göre alignment ve frame fit uygulanmalı.
- [ ] QC-TSL-014: Translation-induced expansion per region raporlanmalı.
- [ ] QC-TSL-015: Glossary/terminology consistency report üretilmeli.

## 10. QC-OPS — test, gözlemleme ve teslimat

- [x] QC-OPS-001: PDF quality unit test suite mevcut.
- [x] QC-OPS-002: API build ve translation testleri çalıştırılıyor.
- [x] QC-OPS-003: Git diff check deploy öncesi çalıştırılıyor.
- [ ] QC-OPS-004: Her kriter için fixture dosyası oluşturulmalı.
- [ ] QC-OPS-005: Exact source PDF regression fixture eklenmeli.
- [ ] QC-OPS-006: DOCX regression fixture eklenmeli.
- [ ] QC-OPS-007: Kriter bazlı pass/fail summary CI çıktısına eklenmeli.
- [ ] QC-OPS-008: Quality report contract testleri eklenmeli.
- [ ] QC-OPS-009: Render latency per page/block ölçülmeli.
- [ ] QC-OPS-010: Quality service CPU/memory/liveness telemetry raporlanmalı.
- [ ] QC-OPS-011: AI token/cost/page telemetry raporlanmalı.
- [ ] QC-OPS-012: Failed output quarantine ve retention akışı tanımlanmalı.
- [ ] QC-OPS-013: Kullanıcıya teknik provider adı yerine aşama bazlı hata gösterilmeli.
- [ ] QC-OPS-014: Completed job download smoke test yapılmalı.
- [ ] QC-OPS-015: Live canary PDF seti ile deploy sonrası smoke test yapılmalı.
- [ ] QC-OPS-016: Her deploy TODO snapshot ve commit ile ilişkilendirilmeli.

## Güncel çalışma sırası

1. QC-GEO-007–017: frame/box/region modeli ve kutu içi taşma.
2. QC-GEO-018–030: çizgi, tablo, kolon ve sayfa bölünmesi kontrolleri.
3. QC-TYP-006–022: bölgesel font/line fit ve tipografik hiyerarşi.
4. QC-VIS-005–022 + QC-AI-004–014: eksen, bölge ve AI kriterleri.
5. QC-DOCX-001–025: Word/XML kalite motoru.
6. QC-TSL-004–015 ve QC-OPS-004–016: içerik güvenliği, fixture ve live regression.
