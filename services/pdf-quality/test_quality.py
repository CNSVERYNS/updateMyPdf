import base64

import fitz

import app as quality_app
from app import adapt_text_layout, extract_layout, inspect_documents, render_preserved_layout, repair_visual_assets


PNG_1X1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")


def make_pdf(pages=1, text="A professional translated document."):
    document = fitz.open()
    for _ in range(pages):
        page = document.new_page(width=300, height=400)
        page.insert_text((40, 60), text, fontsize=12)
    return document.tobytes()


def test_same_layout_passes():
    result = inspect_documents(make_pdf(), make_pdf())
    assert result["passed"] is True
    assert result["score"] == 100
    assert result["sourcePageCount"] == 1
    assert result["qualityLayers"]["typographyConsistency"]["score"] == 100
    assert result["qualityLayers"]["visualReview"]["score"] == 100
    assert result["qualityLayers"]["colorConsistency"]["score"] == 100
    assert result["qualityLayers"]["captureComparison"]["score"] == 100
    assert result["qualityLayers"]["blockGeometry"]["score"] == 100


def test_color_consistency_catches_changed_text_color():
    source_document = fitz.open()
    source_page = source_document.new_page(width=300, height=400)
    source_page.insert_text((40, 60), "A text block with preserved geometry", fontsize=12, color=(0, 0, 0))
    source = source_document.tobytes()
    source_document.close()

    result_document = fitz.open()
    result_page = result_document.new_page(width=300, height=400)
    result_page.insert_text((40, 60), "A translated block with preserved geometry", fontsize=12, color=(1, 0, 0))
    result = result_document.tobytes()
    result_document.close()

    report = inspect_documents(source, result)
    assert report["qualityLayers"]["colorConsistency"]["score"] < 90
    assert report["passed"] is False


def test_rendered_visual_review_catches_added_gray_text_plate():
    source_document = fitz.open()
    source_page = source_document.new_page(width=300, height=400)
    source_page.insert_text((40, 60), "A clean source text block", fontsize=12)
    source = source_document.tobytes()
    source_document.close()

    result_document = fitz.open()
    result_page = result_document.new_page(width=300, height=400)
    result_page.draw_rect(fitz.Rect(35, 45, 210, 70), color=None, fill=(0.82, 0.82, 0.82))
    result_page.insert_text((40, 60), "A translated text block", fontsize=12)
    result = result_document.tobytes()
    result_document.close()

    report = inspect_documents(source, result)
    visual_review = report["qualityLayers"]["visualReview"]
    assert visual_review["score"] < 95
    assert visual_review["backgroundMismatchCount"] >= 1
    assert any(issue["type"] == "background-mismatch" for issue in visual_review["issues"])


def test_page_mismatch_warns():
    result = inspect_documents(make_pdf(2), make_pdf(1))
    assert result["score"] < 100
    assert result["resultPageCount"] == 1


def test_missing_text_cannot_pass_quality_gate():
    result = inspect_documents(make_pdf(text="A complete source paragraph with many words."), make_pdf(text="A"))
    assert result["qualityLayers"]["text"]["score"] < 90
    assert result["score"] < 90
    assert result["passed"] is False


def test_missing_distant_text_block_cannot_pass_position_gate():
    source_document = fitz.open()
    source_page = source_document.new_page(width=300, height=400)
    source_page.insert_text((40, 60), "First source block")
    source_page.insert_text((40, 160), "Second source block")
    source = source_document.tobytes()
    source_document.close()

    result_document = fitz.open()
    result_page = result_document.new_page(width=300, height=400)
    result_page.insert_text((40, 60), "First translated block")
    result = result_document.tobytes()
    result_document.close()

    report = inspect_documents(source, result)
    assert report["qualityLayers"]["text"]["positionCoverageRate"] < 0.98
    assert report["passed"] is False


def test_overlapping_result_blocks_cannot_pass_block_geometry_gate():
    source_document = fitz.open()
    source_page = source_document.new_page(width=300, height=400)
    source_page.insert_text((40, 60), "First source paragraph")
    source_page.insert_text((40, 160), "Second source paragraph")
    source = source_document.tobytes()
    source_document.close()

    result_document = fitz.open()
    result_page = result_document.new_page(width=300, height=400)
    result_page.insert_text((40, 60), "First translated paragraph")
    result_page.insert_text((40, 64), "Second translated paragraph")
    result = result_document.tobytes()
    result_document.close()

    report = inspect_documents(source, result)
    geometry = report["qualityLayers"]["blockGeometry"]
    assert geometry["overlapCount"] >= 1
    assert geometry["score"] < 90
    assert report["passed"] is False


def test_malformed_pdf_fails():
    result = inspect_documents(make_pdf(), b"not a pdf")
    assert result["passed"] is False
    assert result["score"] == 0


def test_visual_asset_repair_restores_small_source_image():
    source_document = fitz.open()
    source_page = source_document.new_page(width=300, height=400)
    source_page.insert_image(fitz.Rect(20, 20, 60, 60), stream=PNG_1X1)
    source = source_document.tobytes()
    source_document.close()

    result_document = fitz.open()
    result_document.new_page(width=300, height=400)
    result = result_document.tobytes()
    result_document.close()

    repaired, count = repair_visual_assets(source, result)
    repaired_document = fitz.open(stream=repaired, filetype="pdf")
    assert count == 1
    assert len(repaired_document[0].get_images(full=True)) == 1
    repaired_document.close()


def test_preserve_renderer_replaces_text_and_keeps_page_structure():
    source = make_pdf(text="Original text block")
    blocks = extract_layout(source)
    output, details = render_preserved_layout(source, {blocks[0]["id"]: "Translated text block"})
    document = fitz.open(stream=output, filetype="pdf")
    assert details["replacedBlocks"] == 1
    assert document.page_count == 1
    assert "Translated text block" in " ".join(document[0].get_text().split())
    document.close()


def test_preserve_renderer_keeps_multiline_text_in_source_line_boxes():
    source_document = fitz.open()
    source_page = source_document.new_page(width=300, height=400)
    source_page.insert_text((40, 60), "Original first line\nOriginal second line", fontsize=12)
    source = source_document.tobytes()
    source_document.close()
    blocks = extract_layout(source)
    assert len(blocks) == 1
    assert blocks[0]["lines"] == 2
    output, details = render_preserved_layout(source, {blocks[0]["id"]: "Translated first line\nTranslated second line"})
    document = fitz.open(stream=output, filetype="pdf")
    text = document[0].get_text()
    assert details["failedBlocks"] == 0
    assert "Translated first line" in text
    assert "Translated second line" in text
    document.close()


def test_preserve_renderer_progressively_shrinks_until_page_integrity_is_restored(monkeypatch):
    source = make_pdf(text="Original text block")
    blocks = extract_layout(source)
    inspections = []

    def fake_inspect_documents(_source: bytes, _result: bytes):
        inspections.append(True)
        preserved = len(inspections) >= 3
        return {
            "score": 96 if preserved else 80,
            "qualityLayers": {
                "pageStructure": {
                    "sourcePages": 1,
                    "resultPages": 1 if preserved else 2,
                    "sizeDifferences": [],
                },
                "layout": {"overflowPages": [], "blankPages": []},
            },
        }

    monkeypatch.setattr(quality_app, "inspect_documents", fake_inspect_documents)
    output, details = render_preserved_layout(source, {blocks[0]["id"]: "Translated text block"})

    assert fitz.open(stream=output, filetype="pdf").page_count == 1
    assert details["attemptedScales"] == [1.0, 0.97, 0.95]
    assert details["selectedScale"] == 0.95
    assert details["shrinkPercent"] == 5.0
    assert details["pageIntegrityPreserved"] is True


def test_edited_pdf_text_layout_uses_the_same_adaptive_scale(monkeypatch):
    source = make_pdf(text="Original text block")
    result = make_pdf(text="Edited text block")
    inspections = []

    def fake_inspect_documents(_source: bytes, _result: bytes):
        inspections.append(True)
        preserved = len(inspections) >= 4
        return {
            "score": 96 if preserved else 80,
            "qualityLayers": {
                "pageStructure": {
                    "sourcePages": 1,
                    "resultPages": 1 if preserved else 2,
                    "sizeDifferences": [],
                },
                "layout": {"overflowPages": [], "blankPages": []},
            },
        }

    monkeypatch.setattr(quality_app, "inspect_documents", fake_inspect_documents)
    output, details = adapt_text_layout(source, result)

    assert fitz.open(stream=output, filetype="pdf").page_count == 1
    assert details["attemptedScales"] == [1.0, 0.97, 0.95]
    assert details["selectedScale"] == 0.95
    assert details["shrinkPercent"] == 5.0
    assert details["pageIntegrityPreserved"] is True
