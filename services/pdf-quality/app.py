import base64
import difflib
import json
import os
import statistics
from collections import Counter
from typing import Any

import fitz
from fastapi import FastAPI, File, Form, Response, UploadFile

app = FastAPI(title="updateMyPDF PDF Quality", version="0.2.0")
MIN_FONT_SIZE = float(os.getenv("MIN_ACCEPTABLE_FONT_SIZE", "5"))
MIN_TEXT_CHAR_RATIO = float(os.getenv("MIN_TEXT_CHAR_RATIO", "0.68"))
MIN_POSITION_COVERAGE = float(os.getenv("MIN_POSITION_COVERAGE", "0.98"))
PASS_SCORE = float(os.getenv("QUALITY_PASS_SCORE", "90"))
WARNING_SCORE = float(os.getenv("QUALITY_WARNING_SCORE", "70"))
UNICODE_FONT_PATH = os.getenv("PRESERVE_UNICODE_FONT", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
VISUAL_REVIEW_SCALE = max(0.5, min(2.0, float(os.getenv("VISUAL_REVIEW_SCALE", "1.0"))))
VISUAL_BACKGROUND_DELTA = float(os.getenv("VISUAL_BACKGROUND_DELTA", "0.08"))


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))
    return round(ordered[index], 2)


def ratio(numerator: float, denominator: float) -> float:
    return round(numerator / max(denominator, 1), 3)


def page_snapshot(page: fitz.Page) -> dict[str, Any]:
    text = page.get_text("text") or ""
    blocks = page.get_text("dict").get("blocks", [])
    spans: list[dict[str, Any]] = []
    text_blocks = 0
    image_blocks = 0
    for block in blocks:
        if block.get("type") == 0:
            text_blocks += 1
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    if span.get("text", "").strip():
                        spans.append(span)
        elif block.get("type") == 1:
            image_blocks += 1

    sizes = [float(span.get("size", 0)) for span in spans if float(span.get("size", 0)) > 0]
    fonts = Counter(str(span.get("font", "")) for span in spans if span.get("font"))
    text_area = 0.0
    for span in spans:
        x0, y0, x1, y1 = span.get("bbox", (0, 0, 0, 0))
        text_area += max(0.0, float(x1) - float(x0)) * max(0.0, float(y1) - float(y0))

    images = page.get_images(full=True)
    image_xrefs = {image[0] for image in images if image and image[0]}
    drawings = page.get_drawings()
    links = page.get_links()
    annotations = list(page.annots() or [])
    rect = page.rect
    overflow = False
    for span in spans:
        bbox = fitz.Rect(span.get("bbox", (0, 0, 0, 0)))
        if bbox.x0 < rect.x0 - 2 or bbox.y0 < rect.y0 - 2 or bbox.x1 > rect.x1 + 2 or bbox.y1 > rect.y1 + 2:
            overflow = True

    return {
        "chars": len(text.strip()),
        "words": len(page.get_text("words")),
        "width": rect.width,
        "height": rect.height,
        "blank": not text.strip() and not images and not drawings,
        "overflow": overflow,
        "textBlocks": text_blocks,
        "imageBlocks": image_blocks,
        "images": len(images),
        "uniqueImages": len(image_xrefs),
        "drawings": len(drawings),
        "links": len(links),
        "annotations": len(annotations),
        "fontFamilies": len(fonts),
        "fonts": dict(fonts),
        "fontSizes": sizes,
        "fontMin": round(min(sizes), 2) if sizes else None,
        "fontP10": percentile(sizes, 0.1),
        "fontMedian": round(statistics.median(sizes), 2) if sizes else None,
        "fontMax": round(max(sizes), 2) if sizes else None,
        "smallFonts": sum(1 for size in sizes if size < MIN_FONT_SIZE),
        "textArea": round(text_area, 2),
    }


def document_snapshot(document: fitz.Document) -> list[dict[str, Any]]:
    return [page_snapshot(page) for page in document]


def document_metrics(pages: list[dict[str, Any]]) -> dict[str, Any]:
    sizes = [size for page in pages for size in page["fontSizes"]]
    fonts = Counter(font for page in pages for font, count in page["fonts"].items() for _ in range(count))
    return {
        "chars": sum(page["chars"] for page in pages),
        "words": sum(page["words"] for page in pages),
        "textBlocks": sum(page["textBlocks"] for page in pages),
        "imageBlocks": sum(page["imageBlocks"] for page in pages),
        "images": sum(page["images"] for page in pages),
        "uniqueImages": sum(page["uniqueImages"] for page in pages),
        "drawings": sum(page["drawings"] for page in pages),
        "links": sum(page["links"] for page in pages),
        "annotations": sum(page["annotations"] for page in pages),
        "fontFamilies": len(fonts),
        "fontMin": round(min(sizes), 2) if sizes else None,
        "fontP10": percentile(sizes, 0.1),
        "fontMedian": round(statistics.median(sizes), 2) if sizes else None,
        "fontMax": round(max(sizes), 2) if sizes else None,
        "smallFonts": sum(page["smallFonts"] for page in pages),
        "textArea": round(sum(page["textArea"] for page in pages), 2),
    }


def normalized_font_name(name: str) -> str:
    value = str(name or "").lstrip("/").lower()
    return value.split("+")[-1]


def source_font_can_render_text(document: fitz.Document, page: fitz.Page, span: dict[str, Any], text: str) -> bool:
    requested = normalized_font_name(span.get("font", ""))
    found = False
    for font in page.get_fonts(full=True):
        if len(font) < 4:
            continue
        base_name = normalized_font_name(font[3])
        if requested and requested not in {base_name, base_name.split(",")[-1]}:
            continue
        found = True
        try:
            extracted = document.extract_font(int(font[0]))
            font_bytes = extracted[3] if len(extracted) > 3 else None
            if font_bytes:
                return font_supports_text(font_bytes, text)
        except Exception:
            continue
    return not found


def typography_consistency(source: fitz.Document, result: fitz.Document) -> dict[str, Any]:
    comparisons: list[dict[str, Any]] = []
    unmatched = 0
    position_matches = 0
    position_unmatched = 0
    source_block_count = 0
    for page_index in range(min(len(source), len(result))):
        source_blocks = text_blocks(source[page_index])
        source_block_count += len(source_blocks)
        result_blocks = text_blocks(result[page_index])
        result_spans = [span for block in result_blocks for span in block["spans"] if span.get("text", "").strip()]
        if not result_spans:
            unmatched += len(source_blocks)
            position_unmatched += len(source_blocks)
            continue
        for source_block in source_blocks:
            source_span = source_block["spans"][0]
            source_rect = fitz.Rect(source_span.get("bbox", source_block["rect"]))
            source_center = ((source_rect.x0 + source_rect.x1) / 2, (source_rect.y0 + source_rect.y1) / 2)
            result_span = min(
                result_spans,
                key=lambda span: (
                    abs((float(span.get("bbox", (0, 0, 0, 0))[1]) + float(span.get("bbox", (0, 0, 0, 0))[3])) / 2 - source_center[1])
                    + abs((float(span.get("bbox", (0, 0, 0, 0))[0]) + float(span.get("bbox", (0, 0, 0, 0))[2])) / 2 - source_center[0]) * 0.15
                ),
            )
            result_bbox = fitz.Rect(result_span.get("bbox", (0, 0, 0, 0)))
            result_center = ((result_bbox.x0 + result_bbox.x1) / 2, (result_bbox.y0 + result_bbox.y1) / 2)
            position_distance = abs(result_center[1] - source_center[1]) + abs(result_center[0] - source_center[0]) * 0.15
            position_tolerance = max(18.0, source_rect.height * 2.5)
            position_match = position_distance <= position_tolerance
            if position_match:
                position_matches += 1
            else:
                position_unmatched += 1
            source_size = float(source_span.get("size", 0) or 0)
            result_size = float(result_span.get("size", 0) or 0)
            size_delta = round(abs(source_size - result_size), 2)
            source_bbox = fitz.Rect(source_span.get("bbox", (0, 0, 0, 0)))
            source_height = max(0.0, source_bbox.height)
            result_height = max(0.0, result_bbox.height)
            height_delta = round(abs(source_height - result_height), 2)
            visual_size_match = height_delta <= max(0.4, source_height * 0.06)
            exact_font_match = normalized_font_name(source_span.get("font", "")) == normalized_font_name(result_span.get("font", ""))
            font_fallback = not exact_font_match and not source_font_can_render_text(source, source[page_index], source_span, str(result_span.get("text", "")))
            comparisons.append({
                "page": page_index + 1,
                "sourceFont": str(source_span.get("font", "")),
                "resultFont": str(result_span.get("font", "")),
                "fontMatch": exact_font_match,
                "fontFallback": font_fallback,
                "sourceSize": round(source_size, 2),
                "resultSize": round(result_size, 2),
                "sizeDelta": size_delta,
                "sourceHeight": round(source_height, 2),
                "resultHeight": round(result_height, 2),
                "heightDelta": height_delta,
                "sizeMatch": visual_size_match,
                "styleMatch": (int(source_span.get("flags", 0) or 0) & 18) == (int(result_span.get("flags", 0) or 0) & 18),
                "positionDistance": round(position_distance, 2),
                "positionTolerance": round(position_tolerance, 2),
                "positionMatch": position_match,
            })
    total = len(comparisons)
    font_matches = sum(1 for item in comparisons if item["fontMatch"])
    font_fallbacks = sum(1 for item in comparisons if item["fontFallback"])
    size_matches = sum(1 for item in comparisons if item["sizeMatch"])
    style_matches = sum(1 for item in comparisons if item["styleMatch"])
    exact_font_rate = round(font_matches / max(total, 1), 3) if total else 1.0
    font_rate = round((font_matches + font_fallbacks) / max(total, 1), 3) if total else 1.0
    size_rate = round(size_matches / max(total, 1), 3) if total else 1.0
    style_rate = round(style_matches / max(total, 1), 3) if total else 1.0
    position_rate = round(position_matches / max(source_block_count, 1), 3) if source_block_count else 1.0
    score = round((font_rate * 0.45 + size_rate * 0.35 + style_rate * 0.10 + position_rate * 0.10) * 100)
    return {
        "score": max(0, min(100, score)),
        "matchedBlocks": total,
        "unmatchedBlocks": unmatched,
        "sourceBlocks": source_block_count,
        "positionMatches": position_matches,
        "positionUnmatchedBlocks": position_unmatched,
        "positionCoverageRate": position_rate,
        "exactFontMatchRate": exact_font_rate,
        "fontMatchRate": font_rate,
        "fontFallbackCount": font_fallbacks,
        "sizeMatchRate": size_rate,
        "styleMatchRate": style_rate,
        "fontMatches": font_matches,
        "sizeMatches": size_matches,
        "styleMatches": style_matches,
        "sizeTolerancePt": 0.4,
        "sizeComparison": "visual_span_height",
        "mismatches": [item for item in comparisons if (not item["fontMatch"] and not item["fontFallback"]) or not item["sizeMatch"] or not item["styleMatch"] or not item["positionMatch"]][:20],
    }


def _pixmap_rgb(pixmap: fitz.Pixmap, x: int, y: int) -> tuple[int, int, int]:
    x = max(0, min(pixmap.width - 1, x))
    y = max(0, min(pixmap.height - 1, y))
    offset = (y * pixmap.width + x) * pixmap.n
    return tuple(int(value) for value in pixmap.samples[offset:offset + 3])  # type: ignore[return-value]


def _pdf_point_to_pixel(page: fitz.Page, pixmap: fitz.Pixmap, x: float, y: float) -> tuple[int, int]:
    scale_x = pixmap.width / max(page.rect.width, 1)
    scale_y = pixmap.height / max(page.rect.height, 1)
    return (round((x - page.rect.x0) * scale_x), round((y - page.rect.y0) * scale_y))


def _region_samples(page: fitz.Page, pixmap: fitz.Pixmap, rect: fitz.Rect) -> list[tuple[int, int, int]]:
    clipped = fitz.Rect(
        max(page.rect.x0, rect.x0),
        max(page.rect.y0, rect.y0),
        min(page.rect.x1, rect.x1),
        min(page.rect.y1, rect.y1),
    )
    if clipped.is_empty:
        return []
    # Sample several inset points instead of a single corner. This prevents a
    # glyph touching one corner from being mistaken for a page background.
    points = ((0.12, 0.12), (0.88, 0.12), (0.12, 0.88), (0.88, 0.88), (0.50, 0.10), (0.50, 0.90))
    samples = []
    for x_ratio, y_ratio in points:
        x = clipped.x0 + clipped.width * x_ratio
        y = clipped.y0 + clipped.height * y_ratio
        samples.append(_pixmap_rgb(pixmap, *_pdf_point_to_pixel(page, pixmap, x, y)))
    return samples


def _median_color(samples: list[tuple[int, int, int]]) -> tuple[float, float, float]:
    if not samples:
        return (255.0, 255.0, 255.0)
    return tuple(float(statistics.median([sample[channel] for sample in samples])) for channel in range(3))


def _luminance(color: tuple[float, float, float]) -> float:
    return (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255


def _dark_ink_density(page: fitz.Page, pixmap: fitz.Pixmap, rect: fitz.Rect) -> float:
    clipped = fitz.Rect(
        max(page.rect.x0, rect.x0),
        max(page.rect.y0, rect.y0),
        min(page.rect.x1, rect.x1),
        min(page.rect.y1, rect.y1),
    )
    if clipped.is_empty:
        return 0.0
    x0, y0 = _pdf_point_to_pixel(page, pixmap, clipped.x0, clipped.y0)
    x1, y1 = _pdf_point_to_pixel(page, pixmap, clipped.x1, clipped.y1)
    step = max(1, round(VISUAL_REVIEW_SCALE))
    dark = 0
    total = 0
    for y in range(max(0, y0), min(pixmap.height, y1 + 1), step):
        for x in range(max(0, x0), min(pixmap.width, x1 + 1), step):
            red, green, blue = _pixmap_rgb(pixmap, x, y)
            total += 1
            if (0.2126 * red + 0.7152 * green + 0.0722 * blue) < 125:
                dark += 1
    return dark / max(total, 1)


def rendered_capture_comparison(source_page: fitz.Page, result_page: fitz.Page, source_capture: fitz.Pixmap, result_capture: fitz.Pixmap) -> dict[str, Any]:
    """Compare low-resolution rendered captures without comparing glyph text.

    Translation changes individual glyph pixels, so a raw pixel-equality test
    would reject a correct translation. Coarse luminance and ink-density tiles
    still catch page shifts, missing panels, collapsed columns, and large
    background changes while remaining tolerant of different word shapes.
    """
    if source_capture.width != result_capture.width or source_capture.height != result_capture.height:
        return {"score": 0, "status": "fail", "luminanceDelta": 1.0, "inkDensityDelta": 1.0, "sampleCount": 0}
    columns = 32
    rows = 40
    # Text glyphs legitimately change after translation. Compare the canvas
    # and artwork outside source text regions here; typography, color, line
    # placement, and overlap are checked by their dedicated layers.
    text_regions = [
        fitz.Rect(block["rect"].x0 - 1.5, block["rect"].y0 - 1.5, block["rect"].x1 + 1.5, block["rect"].y1 + 1.5)
        for block in text_blocks(source_page)
    ]
    luminance_deltas: list[float] = []
    ink_deltas: list[float] = []
    for row in range(rows):
        for column in range(columns):
            x = round((column + 0.5) * source_capture.width / columns)
            y = round((row + 0.5) * source_capture.height / rows)
            point = fitz.Point(x / max(VISUAL_REVIEW_SCALE, 0.5), y / max(VISUAL_REVIEW_SCALE, 0.5))
            if any(region.contains(point) for region in text_regions):
                continue
            source_luma = _luminance(_pixmap_rgb(source_capture, x, y))
            result_luma = _luminance(_pixmap_rgb(result_capture, x, y))
            luminance_deltas.append(abs(source_luma - result_luma))
            ink_deltas.append(abs(float(source_luma < 0.82) - float(result_luma < 0.82)))
    luminance_delta = sum(luminance_deltas) / max(len(luminance_deltas), 1)
    ink_density_delta = sum(ink_deltas) / max(len(ink_deltas), 1)
    score = max(0, round(100 - min(55, luminance_delta * 420) - min(25, ink_density_delta * 130)))
    return {
        "score": score,
        "status": "pass" if score >= PASS_SCORE else "warning",
        "luminanceDelta": round(luminance_delta, 4),
        "inkDensityDelta": round(ink_density_delta, 4),
        "sampleCount": len(luminance_deltas),
        "grid": {"columns": columns, "rows": rows},
    }


def visual_layout_review(source: fitz.Document, result: fitz.Document) -> dict[str, Any]:
    """Review rendered page captures for defects that PDF object metrics miss.

    This is intentionally content-independent: translated glyphs differ from
    the source glyphs, but a source-white text region should not become a gray
    rectangle, a source block should still contain visible ink, and blocks must
    remain in their original page region. The report is suitable for a future
    multimodal reviewer because it records page-level evidence and human-readable
    findings rather than hiding the decision behind a single number.
    """
    issues: list[dict[str, Any]] = []
    page_scores: list[dict[str, Any]] = []
    if len(source) != len(result):
        issues.append({"type": "page-count", "severity": "high", "message": f"Kaynakta {len(source)} sayfa, çıktıda {len(result)} sayfa var."})

    for page_index in range(min(len(source), len(result))):
        source_page = source[page_index]
        result_page = result[page_index]
        source_capture = source_page.get_pixmap(matrix=fitz.Matrix(VISUAL_REVIEW_SCALE, VISUAL_REVIEW_SCALE), colorspace=fitz.csRGB, alpha=False)
        result_capture = result_page.get_pixmap(matrix=fitz.Matrix(VISUAL_REVIEW_SCALE, VISUAL_REVIEW_SCALE), colorspace=fitz.csRGB, alpha=False)
        capture_comparison = rendered_capture_comparison(source_page, result_page, source_capture, result_capture)
        source_blocks = text_blocks(source_page)
        result_blocks = text_blocks(result_page)
        result_spans = [span for block in result_blocks for span in block["spans"] if span.get("text", "").strip()]
        page_issues: list[dict[str, Any]] = []
        background_mismatches = 0
        missing_regions = 0
        position_drifts = 0

        for source_block in source_blocks:
            source_span = source_block["spans"][0]
            source_rect = fitz.Rect(source_block["rect"])
            source_span_rect = fitz.Rect(source_span.get("bbox", source_rect))
            source_center = ((source_span_rect.x0 + source_span_rect.x1) / 2, (source_span_rect.y0 + source_span_rect.y1) / 2)
            match = min(
                result_spans,
                key=lambda span: abs((float(span.get("bbox", (0, 0, 0, 0))[1]) + float(span.get("bbox", (0, 0, 0, 0))[3])) / 2 - source_center[1])
                + abs((float(span.get("bbox", (0, 0, 0, 0))[0]) + float(span.get("bbox", (0, 0, 0, 0))[2])) / 2 - source_center[0]) * 0.15,
                default=None,
            )
            if match is None:
                missing_regions += 1
                page_issues.append({"type": "missing-region", "severity": "high", "page": page_index + 1, "message": "Kaynakta bulunan metin bölgesinde çıktı metni bulunamadı."})
                continue
            result_rect = fitz.Rect(match.get("bbox", (0, 0, 0, 0)))
            result_center = ((result_rect.x0 + result_rect.x1) / 2, (result_rect.y0 + result_rect.y1) / 2)
            position_distance = abs(result_center[1] - source_center[1]) + abs(result_center[0] - source_center[0]) * 0.15
            position_tolerance = max(18.0, source_rect.height * 2.5)
            if position_distance > position_tolerance:
                position_drifts += 1
                page_issues.append({"type": "position-drift", "severity": "high", "page": page_index + 1, "message": f"Metin bölgesi kaynak konumundan {round(position_distance, 1)} pt saptı.", "distance": round(position_distance, 2)})

            source_color = _median_color(_region_samples(source_page, source_capture, source_rect))
            source_samples = _region_samples(source_page, source_capture, source_rect)
            result_samples = _region_samples(result_page, result_capture, source_rect)
            result_color = _median_color(result_samples)
            source_luma = _luminance(source_color)
            result_luma = _luminance(result_color)
            color_delta = max(abs(source_color[channel] - result_color[channel]) for channel in range(3)) / 255
            result_lumas = [_luminance(sample) for sample in result_samples]
            median_result_luma = statistics.median(result_lumas) if result_lumas else 1.0
            result_mad = statistics.median([abs(value - median_result_luma) for value in result_lumas]) if result_lumas else 0.0
            source_canvas_luma = _luminance(tuple(value * 255 for value in source_background(source_page, source_rect)))
            dark_plate_samples = sum(1 for value in result_lumas if value < 0.90)
            # A light source region becoming a darker, nearly uniform plate is
            # the signature of a redaction/background bug. Natural colored
            # source panels are not flagged because their source luminance is
            # already below the light-background threshold.
            if source_canvas_luma >= 0.93 and source_luma >= 0.93 and median_result_luma < source_luma - VISUAL_BACKGROUND_DELTA and color_delta >= VISUAL_BACKGROUND_DELTA and dark_plate_samples >= max(4, len(result_lumas) - 1) and result_mad < 0.08:
                background_mismatches += 1
                page_issues.append({"type": "background-mismatch", "severity": "medium", "page": page_index + 1, "message": "Kaynakta açık olan metin alanına çıktı PDF’de koyu/gri bir arka plan kaplaması eklenmiş.", "rect": [round(value, 2) for value in (source_rect.x0, source_rect.y0, source_rect.x1, source_rect.y1)], "sourceLuminance": round(source_luma, 3), "resultLuminance": round(result_luma, 3)})

        page_score = max(0, 100 - min(60, background_mismatches * 12) - min(50, missing_regions * 20) - min(50, position_drifts * 10))
        page_scores.append({"page": page_index + 1, "score": page_score, "backgroundMismatches": background_mismatches, "missingRegions": missing_regions, "positionDrifts": position_drifts, "issues": page_issues[:12], "capture": {"scale": VISUAL_REVIEW_SCALE, "width": source_capture.width, "height": source_capture.height}, "captureComparison": capture_comparison})
        issues.extend(page_issues)

    score = min([page["score"] for page in page_scores], default=0 if len(source) else 100)
    return {
        "score": score,
        "status": "pass" if score >= PASS_SCORE else "warning",
        "engine": "rendered-pdf-visual-review",
        "reviewedPages": len(page_scores),
        "captureScale": VISUAL_REVIEW_SCALE,
        "issues": issues[:30],
        "pageScores": page_scores,
        "issueCount": len(issues),
        "backgroundMismatchCount": sum(page["backgroundMismatches"] for page in page_scores),
        "missingRegionCount": sum(page["missingRegions"] for page in page_scores),
        "positionDriftCount": sum(page["positionDrifts"] for page in page_scores),
        "captureComparison": {
            "score": min((page["captureComparison"]["score"] for page in page_scores), default=100 if len(source) == 0 else 0),
            "status": "pass" if min((page["captureComparison"]["score"] for page in page_scores), default=100 if len(source) == 0 else 0) >= PASS_SCORE else "warning",
            "pages": [page["captureComparison"] for page in page_scores],
        },
    }


def _rect_area(rect: fitz.Rect) -> float:
    return max(0.0, float(rect.width)) * max(0.0, float(rect.height))


def _intersection_ratio(left: fitz.Rect, right: fitz.Rect) -> float:
    intersection = left & right
    if intersection.is_empty:
        return 0.0
    return _rect_area(intersection) / max(1.0, min(_rect_area(left), _rect_area(right)))


def _line_rect(item: tuple[Any, ...]) -> fitz.Rect | None:
    if not item or item[0] != "l" or len(item) < 3:
        return None
    try:
        return fitz.Rect(item[1], item[2])
    except Exception:
        return None


def layout_regions(page: fitz.Page) -> list[dict[str, Any]]:
    """Extract stable visual regions from PDF rectangles and frame lines.

    Many form PDFs do not store a frame as one rectangle; they store four
    separate line drawings. We reconstruct only closed, axis-aligned regions
    and keep tiny checkbox rectangles as a separate object class.
    """
    regions: list[dict[str, Any]] = []
    horizontals: list[fitz.Rect] = []
    verticals: list[fitz.Rect] = []

    for drawing in page.get_drawings():
        for item in drawing.get("items", []):
            if item and item[0] == "re" and len(item) > 1:
                try:
                    rect = fitz.Rect(item[1])
                except Exception:
                    continue
                if rect.width >= 1 and rect.height >= 1:
                    kind = "checkbox" if rect.width <= 14 and rect.height <= 14 else "box"
                    regions.append({"kind": kind, "rect": rect, "source": "rectangle"})
            line = _line_rect(item)
            if line is None:
                continue
            if line.width >= 8 and line.height <= 1.5:
                horizontals.append(line)
            elif line.height >= 8 and line.width <= 1.5:
                verticals.append(line)

    # Group exact-ish horizontal edges before pairing them. This avoids the
    # quadratic behavior of comparing every drawing with every other drawing
    # on dense vector forms.
    horizontal_groups: dict[tuple[int, int], list[fitz.Rect]] = {}
    for line in horizontals:
        key = (round(line.x0 * 2), round(line.x1 * 2))
        horizontal_groups.setdefault(key, []).append(line)

    def vertical_covers(x: float, top: float, bottom: float) -> bool:
        return any(
            abs(line.x0 - x) <= 1.5
            and line.y0 <= top + 1.5
            and line.y1 >= bottom - 1.5
            for line in verticals
        )

    seen: set[tuple[str, int, int, int, int]] = set()
    for lines in horizontal_groups.values():
        ordered = sorted(lines, key=lambda line: line.y0)
        for top, bottom in zip(ordered, ordered[1:]):
            if bottom.y0 - top.y0 < 8:
                continue
            if not vertical_covers(top.x0, top.y0, bottom.y0) or not vertical_covers(top.x1, top.y0, bottom.y0):
                continue
            rect = fitz.Rect(top.x0, top.y0, top.x1, bottom.y0)
            if rect.width < 20 or rect.height < 8:
                continue
            key = ("frame", round(rect.x0), round(rect.y0), round(rect.x1), round(rect.y1))
            if key in seen:
                continue
            seen.add(key)
            regions.append({"kind": "frame", "rect": rect, "source": "closed-lines"})

    # Keep the model compact and deterministic when a PDF repeats the same
    # drawing several times in its content stream.
    unique: dict[tuple[str, int, int, int, int], dict[str, Any]] = {}
    for region in regions:
        rect = fitz.Rect(region["rect"])
        key = (region["kind"], round(rect.x0), round(rect.y0), round(rect.x1), round(rect.y1))
        unique[key] = {**region, "rect": rect}
    return sorted(unique.values(), key=lambda region: (region["rect"].y0, region["rect"].x0, region["rect"].width))


def region_geometry_review(source: fitz.Document, result: fitz.Document) -> dict[str, Any]:
    """Compare form boxes/frames and detect text escaping their regions."""
    issues: list[dict[str, Any]] = []
    page_scores: list[dict[str, Any]] = []
    source_count = 0
    result_count = 0
    missing = 0
    geometry_drifts = 0
    content_overflows = 0
    matched_regions = 0

    for page_index in range(max(len(source), len(result))):
        source_page = source[page_index] if page_index < len(source) else None
        result_page = result[page_index] if page_index < len(result) else None
        source_regions = layout_regions(source_page) if source_page else []
        result_regions = layout_regions(result_page) if result_page else []
        source_regions = [region for region in source_regions if _rect_area(region["rect"]) >= 40]
        result_regions = [region for region in result_regions if _rect_area(region["rect"]) >= 40]
        source_count += len(source_regions)
        result_count += len(result_regions)
        used: set[int] = set()
        page_issues: list[dict[str, Any]] = []

        for source_index, source_region in enumerate(source_regions):
            source_rect = fitz.Rect(source_region["rect"])
            candidates: list[tuple[float, int, fitz.Rect]] = []
            for result_index, result_region in enumerate(result_regions):
                if result_index in used or result_region["kind"] != source_region["kind"]:
                    continue
                result_rect = fitz.Rect(result_region["rect"])
                center_distance = abs(result_rect.x0 - source_rect.x0) + abs(result_rect.y0 - source_rect.y0)
                size_distance = abs(result_rect.width - source_rect.width) + abs(result_rect.height - source_rect.height)
                candidates.append((center_distance + size_distance * 0.5, result_index, result_rect))
            if not candidates:
                missing += 1
                page_issues.append({
                    "criterion": "QC-GEO-007",
                    "type": "region-missing",
                    "severity": "high",
                    "page": page_index + 1,
                    "regionIndex": source_index,
                    "regionKind": source_region["kind"],
                    "rect": [round(value, 2) for value in source_rect],
                    "message": "Kaynak kutu/frame sonucu PDF'de bulunamadı.",
                })
                continue
            _, result_index, result_rect = min(candidates, key=lambda item: item[0])
            used.add(result_index)
            matched_regions += 1
            x_delta = max(abs(result_rect.x0 - source_rect.x0), abs(result_rect.x1 - source_rect.x1))
            y_delta = max(abs(result_rect.y0 - source_rect.y0), abs(result_rect.y1 - source_rect.y1))
            if x_delta > 2 or y_delta > 2:
                geometry_drifts += 1
                page_issues.append({
                    "criterion": "QC-GEO-008",
                    "type": "region-geometry-drift",
                    "severity": "high",
                    "page": page_index + 1,
                    "regionIndex": source_index,
                    "regionKind": source_region["kind"],
                    "sourceRect": [round(value, 2) for value in source_rect],
                    "resultRect": [round(value, 2) for value in result_rect],
                    "message": "Kutu/frame sınırları kaynak geometriyle eşleşmiyor.",
                })

            if source_region["kind"] == "checkbox":
                continue
            source_blocks = text_blocks(source_page) if source_page else []
            result_blocks = text_blocks(result_page) if result_page else []
            contained_source = [
                block for block in source_blocks
                if source_rect.contains(fitz.Point(*block["center"]))
            ]
            for block in contained_source:
                source_center = block["center"]
                region_result_blocks = [
                    candidate for candidate in result_blocks
                    if result_rect.contains(fitz.Point(*candidate["center"]))
                ]
                if not result_blocks:
                    continue
                candidate_blocks = region_result_blocks or result_blocks
                result_block = min(
                    candidate_blocks,
                    key=lambda candidate: abs(candidate["center"][1] - source_center[1]) + abs(candidate["center"][0] - source_center[0]) * 0.15,
                )
                result_block_rect = fitz.Rect(result_block["rect"])
                tolerance = 1.5
                if (
                    result_block_rect.x0 < result_rect.x0 - tolerance
                    or result_block_rect.y0 < result_rect.y0 - tolerance
                    or result_block_rect.x1 > result_rect.x1 + tolerance
                    or result_block_rect.y1 > result_rect.y1 + tolerance
                ):
                    content_overflows += 1
                    page_issues.append({
                        "criterion": "QC-GEO-009",
                        "type": "region-content-overflow",
                        "severity": "high",
                        "page": page_index + 1,
                        "regionIndex": source_index,
                        "sourceRect": [round(value, 2) for value in source_rect],
                        "resultTextRect": [round(value, 2) for value in result_block_rect],
                        "message": "Kutu/frame içindeki metin bölge sınırlarının dışına taştı.",
                    })

        page_score = max(0, 100 - min(60, len([issue for issue in page_issues if issue["type"] == "region-missing"]) * 30) - min(50, len([issue for issue in page_issues if issue["type"] == "region-geometry-drift"]) * 20) - min(60, len([issue for issue in page_issues if issue["type"] == "region-content-overflow"]) * 30))
        page_scores.append({
            "page": page_index + 1,
            "score": page_score,
            "sourceRegions": len(source_regions),
            "resultRegions": len(result_regions),
            "matchedRegions": len(used),
            "issues": page_issues[:20],
        })
        issues.extend(page_issues)

    score = min((page["score"] for page in page_scores), default=100 if len(source) == 0 else 0)
    return {
        "score": score,
        "status": "pass" if score >= PASS_SCORE else "fail",
        "engine": "deterministic-region-frame-review",
        "sourceRegions": source_count,
        "resultRegions": result_count,
        "matchedRegions": matched_regions,
        "missingRegions": missing,
        "geometryDrifts": geometry_drifts,
        "contentOverflows": content_overflows,
        "issues": issues[:80],
        "pageScores": page_scores,
    }


def block_geometry_review(source: fitz.Document, result: fitz.Document) -> dict[str, Any]:
    """Perform a strict one-to-one geometry check for every text paragraph.

    Page-level raster review can miss two neighboring text boxes that overlap
    only in their text geometry. This pass matches each source block to one
    result block, checks its top-left position and page bounds, then compares
    every result block with every other result block for collisions.
    """
    issues: list[dict[str, Any]] = []
    page_scores: list[dict[str, Any]] = []
    total_source = 0
    total_result = 0
    matched = 0
    missing = 0
    position_drifts = 0
    overlaps = 0
    line_overlaps = 0
    overflow = 0

    for page_index in range(max(len(source), len(result))):
        source_page = source[page_index] if page_index < len(source) else None
        result_page = result[page_index] if page_index < len(result) else None
        source_blocks = text_blocks(source_page) if source_page else []
        result_blocks = text_blocks(result_page) if result_page else []
        total_source += len(source_blocks)
        total_result += len(result_blocks)
        page_issues: list[dict[str, Any]] = []
        used: set[int] = set()

        if source_page is None or result_page is None:
            page_issues.append({"type": "page-missing", "severity": "high", "page": page_index + 1, "message": "Kaynak ve çıktı sayfaları birebir eşleşmiyor."})

        for source_block in source_blocks:
            source_rect = fitz.Rect(source_block["rect"])
            source_center = source_block["center"]
            candidates = [(index, block) for index, block in enumerate(result_blocks) if index not in used]
            if not candidates:
                missing += 1
                page_issues.append({"type": "missing-block", "severity": "high", "page": page_index + 1, "message": "Kaynak paragraf için çıktı metin bloğu bulunamadı.", "sourceRect": [round(value, 2) for value in (source_rect.x0, source_rect.y0, source_rect.x1, source_rect.y1)]})
                continue
            index, result_block = min(
                candidates,
                key=lambda item: abs(item[1]["center"][1] - source_center[1]) + abs(item[1]["center"][0] - source_center[0]) * 0.15,
            )
            used.add(index)
            matched += 1
            result_rect = fitz.Rect(result_block["rect"])
            position_distance = abs(result_rect.y0 - source_rect.y0) + abs(result_rect.x0 - source_rect.x0) * 0.15
            position_tolerance = max(12.0, source_rect.height * 2.5)
            if position_distance > position_tolerance:
                position_drifts += 1
                page_issues.append({"type": "block-position-drift", "severity": "high", "page": page_index + 1, "message": "Çevrilen paragraf kaynak konumundan fazla uzaklaştı.", "distance": round(position_distance, 2), "tolerance": round(position_tolerance, 2)})
            if result_page and (result_rect.x0 < result_page.rect.x0 - 1 or result_rect.y0 < result_page.rect.y0 - 1 or result_rect.x1 > result_page.rect.x1 + 1 or result_rect.y1 > result_page.rect.y1 + 1):
                overflow += 1
                page_issues.append({"type": "block-overflow", "severity": "high", "page": page_index + 1, "message": "Çevrilen paragraf sayfa sınırlarının dışına taştı."})

        for left_index, left_block in enumerate(result_blocks):
            left_rect = fitz.Rect(left_block["rect"])
            for right_block in result_blocks[left_index + 1:]:
                right_rect = fitz.Rect(right_block["rect"])
                overlap_ratio = _intersection_ratio(left_rect, right_rect)
                if overlap_ratio >= 0.28:
                    overlaps += 1
                    page_issues.append({"type": "block-overlap", "severity": "high", "page": page_index + 1, "message": "Çıktıda iki paragrafın metin alanı üst üste biniyor.", "overlapRatio": round(overlap_ratio, 3)})

        result_lines = [
            {**line, "blockIndex": block_index}
            for block_index, block in enumerate(result_blocks)
            for line in block.get("lineBoxes", [])
        ]
        for left_index, left_line in enumerate(result_lines):
            left_rect = fitz.Rect(left_line["rect"])
            for right_line in result_lines[left_index + 1:]:
                right_rect = fitz.Rect(right_line["rect"])
                earlier, later = sorted((left_rect, right_rect), key=lambda rect: rect.y0)
                overlap_ratio = _intersection_ratio(left_rect, right_rect)
                line_collision = later.y0 < earlier.y0 + earlier.height * 0.75
                if overlap_ratio >= 0.03 and line_collision:
                    line_overlaps += 1
                    overlaps += 1
                    page_issues.append({"type": "line-overlap", "severity": "high", "page": page_index + 1, "message": "Çıktıda iki metin satırı üst üste biniyor.", "overlapRatio": round(overlap_ratio, 3)})

        unmatched_result = max(0, len(result_blocks) - len(used))
        page_score = max(0, 100 - min(60, sum(1 for issue in page_issues if issue["type"] == "missing-block") * 30) - min(50, sum(1 for issue in page_issues if issue["type"] == "block-position-drift") * 18) - min(60, sum(1 for issue in page_issues if issue["type"] == "block-overlap") * 30) - min(40, sum(1 for issue in page_issues if issue["type"] == "block-overflow") * 25))
        page_scores.append({"page": page_index + 1, "score": page_score, "sourceBlocks": len(source_blocks), "resultBlocks": len(result_blocks), "matchedBlocks": len(used), "unmatchedResultBlocks": unmatched_result, "issues": page_issues[:20]})
        issues.extend(page_issues)

    score = min((page["score"] for page in page_scores), default=100 if len(source) == 0 else 0)
    return {
        "score": score,
        "status": "pass" if score >= PASS_SCORE else "fail",
        "engine": "deterministic-block-geometry-review",
        "sourceBlocks": total_source,
        "resultBlocks": total_result,
        "matchedBlocks": matched,
        "missingBlocks": missing,
        "positionDrifts": position_drifts,
        "overlapCount": overlaps,
        "lineOverlapCount": line_overlaps,
        "overflowCount": overflow,
        "issues": issues[:80],
        "pageScores": page_scores,
    }


def block_geometry_review_strict(source: fitz.Document, result: fitz.Document) -> dict[str, Any]:
    """Check source regions and result lines without trusting PDF block grouping.

    PDF extraction may merge neighboring translated blocks or split one source
    block into several result blocks. A one-to-one block rectangle comparison
    therefore reports false failures on real forms. This pass matches each
    source block to a result line in its safe render region, then checks all
    result lines for overflow and actual collisions.
    """
    issues: list[dict[str, Any]] = []
    page_scores: list[dict[str, Any]] = []
    total_source = 0
    total_result_lines = 0
    matched = 0
    missing = 0
    position_drifts = 0
    overlaps = 0
    overflow = 0

    for page_index in range(max(len(source), len(result))):
        source_page = source[page_index] if page_index < len(source) else None
        result_page = result[page_index] if page_index < len(result) else None
        source_blocks = text_blocks(source_page) if source_page else []
        result_blocks = text_blocks(result_page) if result_page else []
        result_lines = [line for block in result_blocks for line in block.get("lineBoxes", [])]
        result_lines.sort(key=lambda line: (fitz.Rect(line["rect"]).y0, fitz.Rect(line["rect"]).x0))
        total_source += len(source_blocks)
        total_result_lines += len(result_lines)
        page_issues: list[dict[str, Any]] = []
        used: set[int] = set()

        if source_page is None or result_page is None:
            page_issues.append({"type": "page-missing", "severity": "high", "page": page_index + 1, "message": "Source and result pages do not match."})

        for source_block in source_blocks:
            source_rect = fitz.Rect(source_block["rect"])
            source_center = source_block["center"]
            safe_rect = expanded_render_rect(source_block, source_blocks, source_page)
            # A translated one-line block can move by a small amount when the
            # font metrics change. Keep the check strict, but allow a bounded
            # line-height envelope; raster/capture and collision checks still
            # reject real displacement or overlap.
            position_tolerance = max(18.0, source_rect.height * 2.75)
            candidates = []
            for line_index, line in enumerate(result_lines):
                if line_index in used:
                    continue
                line_rect = fitz.Rect(line["rect"])
                horizontal_overlap = max(0.0, min(safe_rect.x1, line_rect.x1) - max(safe_rect.x0, line_rect.x0)) / max(1.0, min(safe_rect.width, line_rect.width))
                if horizontal_overlap < 0.08:
                    continue
                if line_rect.y1 < source_rect.y0 - position_tolerance or line_rect.y0 > safe_rect.y1 + position_tolerance:
                    continue
                line_center = ((line_rect.x0 + line_rect.x1) / 2, (line_rect.y0 + line_rect.y1) / 2)
                distance = abs(line_center[1] - source_center[1]) + abs(line_center[0] - source_center[0]) * 0.15
                outside_safe = 0 if safe_rect.contains(fitz.Point(*line_center)) else 100
                candidates.append((outside_safe + distance, line_index, line_rect))
            if not candidates:
                missing += 1
                page_issues.append({"type": "missing-block", "severity": "high", "page": page_index + 1, "message": "No result text line was found for a source text region.", "sourceRect": [round(value, 2) for value in (source_rect.x0, source_rect.y0, source_rect.x1, source_rect.y1)]})
                continue
            _, line_index, result_rect = min(candidates, key=lambda item: item[0])
            used.add(line_index)
            matched += 1
            position_distance = abs(result_rect.y0 - source_rect.y0) + abs(result_rect.x0 - source_rect.x0) * 0.15
            if position_distance > position_tolerance:
                position_drifts += 1
                page_issues.append({"type": "block-position-drift", "severity": "high", "page": page_index + 1, "message": "Result text moved too far from its source region.", "distance": round(position_distance, 2), "tolerance": round(position_tolerance, 2)})

        def line_overlap_details(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
            details: list[dict[str, Any]] = []
            for left_index, left_line in enumerate(lines):
                left_rect = fitz.Rect(left_line["rect"])
                for right_line in lines[left_index + 1:]:
                    right_rect = fitz.Rect(right_line["rect"])
                    intersection = left_rect & right_rect
                    if intersection.is_empty:
                        continue
                    horizontal_overlap = max(0.0, min(left_rect.x1, right_rect.x1) - max(left_rect.x0, right_rect.x0)) / max(1.0, min(left_rect.width, right_rect.width))
                    vertical_overlap = max(0.0, min(left_rect.y1, right_rect.y1) - max(left_rect.y0, right_rect.y0)) / max(1.0, min(left_rect.height, right_rect.height))
                    overlap_ratio = _intersection_ratio(left_rect, right_rect)
                    if horizontal_overlap >= 0.25 and vertical_overlap >= 0.15 and overlap_ratio >= 0.03:
                        details.append({
                            "type": "line-overlap",
                            "severity": "high",
                            "page": page_index + 1,
                            "message": "Two result text lines overlap.",
                            "overlapRatio": round(overlap_ratio, 3),
                            "leftBlockIndex": left_line.get("blockIndex"),
                            "rightBlockIndex": right_line.get("blockIndex"),
                            "leftRect": [round(value, 2) for value in left_rect],
                            "rightRect": [round(value, 2) for value in right_rect],
                        })
            return details

        source_lines = [line for block in source_blocks for line in block.get("lineBoxes", [])]
        baseline_overlaps = line_overlap_details(source_lines)
        result_overlap_details = line_overlap_details(result_lines)
        new_overlap_details = result_overlap_details[len(baseline_overlaps):] if len(result_overlap_details) > len(baseline_overlaps) else []
        overlaps += len(new_overlap_details)
        page_issues.extend(new_overlap_details)

        for left_index, left_line in enumerate(result_lines):
            left_rect = fitz.Rect(left_line["rect"])
            if result_page and (left_rect.x0 < result_page.rect.x0 - 1 or left_rect.y0 < result_page.rect.y0 - 1 or left_rect.x1 > result_page.rect.x1 + 1 or left_rect.y1 > result_page.rect.y1 + 1):
                overflow += 1
                page_issues.append({"type": "line-overflow", "severity": "high", "page": page_index + 1, "message": "Result text line overflowed the page bounds."})

        page_score = max(0, 100 - min(60, sum(1 for issue in page_issues if issue["type"] == "missing-block") * 30) - min(45, position_drifts * 8) - min(70, len(new_overlap_details) * 35) - min(45, sum(1 for issue in page_issues if issue["type"] == "line-overflow") * 25))
        page_scores.append({"page": page_index + 1, "score": page_score, "sourceBlocks": len(source_blocks), "resultBlocks": len(result_blocks), "resultLines": len(result_lines), "matchedBlocks": len(used), "unmatchedResultLines": max(0, len(result_lines) - len(used)), "baselineLineOverlapCount": len(baseline_overlaps), "lineOverlapCount": len(new_overlap_details), "issues": page_issues[:20]})
        issues.extend(page_issues)

    score = min((page["score"] for page in page_scores), default=100 if len(source) == 0 else 0)
    return {
        "score": score,
        "status": "pass" if score >= PASS_SCORE else "fail",
        "engine": "deterministic-source-region-line-geometry-review",
        "sourceBlocks": total_source,
        "resultBlocks": sum(page["resultBlocks"] for page in page_scores),
        "resultLines": total_result_lines,
        "matchedBlocks": matched,
        "missingBlocks": missing,
        "positionDrifts": position_drifts,
        "overlapCount": overlaps,
        "lineOverlapCount": overlaps,
        "overflowCount": overflow,
        "issues": issues[:80],
        "pageScores": page_scores,
    }


def color_consistency_review(source: fitz.Document, result: fitz.Document) -> dict[str, Any]:
    """Compare source/result text colors using positioned spans."""
    comparisons: list[dict[str, Any]] = []
    unmatched = 0
    for page_index in range(min(len(source), len(result))):
        source_page = source[page_index]
        result_page = result[page_index]
        source_blocks = text_blocks(source_page)
        result_spans = [span for block in text_blocks(result_page) for span in block["spans"] if span.get("text", "").strip()]
        used: set[int] = set()
        for source_block in source_blocks:
            source_span = source_block["spans"][0]
            source_rect = fitz.Rect(source_span.get("bbox", source_block["rect"]))
            safe_rect = expanded_render_rect(source_block, source_blocks, source_page)
            candidates = []
            for index, result_span in enumerate(result_spans):
                if index in used:
                    continue
                result_rect = fitz.Rect(result_span.get("bbox", (0, 0, 0, 0)))
                if result_rect.y1 < source_rect.y0 - max(18.0, source_rect.height * 2.5) or result_rect.y0 > safe_rect.y1:
                    continue
                result_center = ((result_rect.x0 + result_rect.x1) / 2, (result_rect.y0 + result_rect.y1) / 2)
                source_center = ((source_rect.x0 + source_rect.x1) / 2, (source_rect.y0 + source_rect.y1) / 2)
                distance = abs(result_center[1] - source_center[1]) + abs(result_center[0] - source_center[0]) * 0.15
                candidates.append((distance, index, result_span))
            if not candidates:
                unmatched += 1
                continue
            _, index, result_span = min(candidates, key=lambda item: item[0])
            used.add(index)
            source_color = span_color(source_span)
            result_color = span_color(result_span)
            delta = max(abs(source_color[channel] - result_color[channel]) for channel in range(3))
            comparisons.append({
                "page": page_index + 1,
                "sourceColor": [round(value, 3) for value in source_color],
                "resultColor": [round(value, 3) for value in result_color],
                "delta": round(delta, 4),
                "match": delta <= 0.04,
            })
    total = len(comparisons) + unmatched
    matches = sum(1 for item in comparisons if item["match"])
    score = round(matches / max(total, 1) * 100)
    return {
        "score": score,
        "status": "pass" if score >= PASS_SCORE else "fail",
        "matchedBlocks": len(comparisons),
        "unmatchedBlocks": unmatched,
        "colorMatches": matches,
        "colorMatchRate": round(matches / max(total, 1), 3),
        "maxAllowedDelta": 0.04,
        "mismatches": [item for item in comparisons if not item["match"]][:20],
    }


def visual_profile(source_bytes: bytes, include_captures: bool = False) -> dict[str, Any]:
    """Create a compact page profile for strategy selection and AI review.

    The profile deliberately separates measurable PDF evidence from any future
    multimodal model opinion. A model may refine the strategy, but it cannot
    silently erase the evidence that led to the decision.
    """
    document = fitz.open(stream=source_bytes, filetype="pdf")
    pages: list[dict[str, Any]] = []
    try:
        for page_index, page in enumerate(document):
            lines: list[dict[str, Any]] = []
            orphan_markers: list[dict[str, Any]] = []
            for block in page.get_text("dict").get("blocks", []):
                if block.get("type") != 0:
                    continue
                block_lines = block.get("lines", [])
                for line_index, line in enumerate(block_lines):
                    text = "".join(span.get("text", "") for span in line.get("spans", [])).strip()
                    if not text:
                        continue
                    bbox = [round(float(value), 2) for value in line.get("bbox", (0, 0, 0, 0))]
                    line_info = {"text": text, "bbox": bbox}
                    lines.append(line_info)
                    if text == "-":
                        next_line = block_lines[line_index + 1] if line_index + 1 < len(block_lines) else None
                        next_text = "".join(span.get("text", "") for span in (next_line or {}).get("spans", [])).strip()
                        orphan_markers.append({"type": "orphan-marker", "severity": "high", "text": text, "bbox": bbox, "nextText": next_text})

            text = page.get_text("text") or ""
            images = len(page.get_images(full=True))
            drawings = len(page.get_drawings())
            scanned = len(text.strip()) < 80 and images > 0
            if scanned:
                strategy = "ocr_first"
            elif orphan_markers:
                strategy = "reflow_text_columns"
            elif images > 0 or drawings > 0:
                strategy = "preserve_canvas"
            else:
                strategy = "block_replace"

            page_profile: dict[str, Any] = {
                "page": page_index + 1,
                "width": round(page.rect.width, 2),
                "height": round(page.rect.height, 2),
                "chars": len(text.strip()),
                "textLines": len(lines),
                "images": images,
                "drawings": drawings,
                "scanned": scanned,
                "strategy": strategy,
                "confidence": 0.98 if orphan_markers or scanned else 0.82,
                "issues": orphan_markers,
            }
            if include_captures:
                pixmap = page.get_pixmap(matrix=fitz.Matrix(1.25, 1.25), colorspace=fitz.csRGB, alpha=False)
                page_profile["capture"] = {
                    "mimeType": "image/png",
                    "scale": 1.25,
                    "width": pixmap.width,
                    "height": pixmap.height,
                    "data": base64.b64encode(pixmap.tobytes("png")).decode("ascii"),
                }
            pages.append(page_profile)
    finally:
        document.close()

    strategies = [page["strategy"] for page in pages]
    document_strategy = "reflow_text_columns" if "reflow_text_columns" in strategies else "ocr_first" if "ocr_first" in strategies else "preserve_canvas" if "preserve_canvas" in strategies else "block_replace"
    return {
        "engine": "pdf-visual-preflight",
        "documentStrategy": document_strategy,
        "pageCount": len(pages),
        "pages": pages,
        "issueCount": sum(len(page["issues"]) for page in pages),
        "captureIncluded": include_captures,
    }


def inspect_documents(source_bytes: bytes, result_bytes: bytes) -> dict[str, Any]:
    warnings: list[str] = []
    try:
        source = fitz.open(stream=source_bytes, filetype="pdf")
        result = fitz.open(stream=result_bytes, filetype="pdf")
        source_pages = document_snapshot(source)
        result_pages = document_snapshot(result)
    except Exception as exc:  # pragma: no cover - exercised by malformed fixture
        return {
            "passed": False,
            "score": 0,
            "warnings": ["Çıktı PDF olarak açılamadı."],
            "sourcePageCount": None,
            "resultPageCount": None,
            "sourcePageSizes": [],
            "resultPageSizes": [],
            "textCoverage": {},
            "possibleOverflowPages": [],
            "blankPages": [],
            "qualityLayers": {"fileIntegrity": {"score": 0, "status": "fail", "error": str(exc)}},
        }

    source_metrics = document_metrics(source_pages)
    result_metrics = document_metrics(result_pages)
    size_differences: list[int] = []
    for index, source_page in enumerate(source_pages[: len(result_pages)]):
        result_page = result_pages[index]
        if abs(source_page["width"] - result_page["width"]) > 2 or abs(source_page["height"] - result_page["height"]) > 2:
            size_differences.append(index + 1)

    coverage: dict[str, float] = {}
    blank_pages: list[int] = []
    overflow_pages: list[int] = []
    small_font_pages: list[int] = []
    for index, source_page in enumerate(source_pages):
        page_number = index + 1
        result_page = result_pages[index] if index < len(result_pages) else None
        source_chars = source_page["chars"]
        result_chars = result_page["chars"] if result_page else 0
        coverage[str(page_number)] = round(result_chars / max(source_chars, 1), 3) if source_chars else 1.0
        if source_page["chars"] > 0 and (result_page is None or result_page["blank"]):
            blank_pages.append(page_number)
        if result_page and result_page["blank"] and not source_page["blank"]:
            blank_pages.append(page_number)
        if result_page and result_page["overflow"]:
            overflow_pages.append(page_number)
        if result_page and result_page["smallFonts"] > 0:
            small_font_pages.append(page_number)

    char_ratio = ratio(result_metrics["chars"], source_metrics["chars"]) if source_metrics["chars"] else 1.0
    word_ratio = ratio(result_metrics["words"], source_metrics["words"]) if source_metrics["words"] else 1.0
    text_block_ratio = ratio(result_metrics["textBlocks"], source_metrics["textBlocks"]) if source_metrics["textBlocks"] else 1.0
    text_area_ratio = ratio(result_metrics["textArea"], source_metrics["textArea"]) if source_metrics["textArea"] else 1.0
    font_median_ratio = ratio(result_metrics["fontMedian"] or 0, source_metrics["fontMedian"] or 1) if source_metrics["fontMedian"] else 1.0
    image_ratio = ratio(result_metrics["images"], source_metrics["images"]) if source_metrics["images"] else 1.0
    drawing_ratio = ratio(result_metrics["drawings"], source_metrics["drawings"]) if source_metrics["drawings"] else 1.0
    typography_match = typography_consistency(source, result)
    visual_review = visual_layout_review(source, result)
    block_geometry = block_geometry_review_strict(source, result)
    region_review = region_geometry_review(source, result)
    color_consistency = color_consistency_review(source, result)
    capture_comparison = visual_review.get("captureComparison", {"score": 0, "status": "fail", "pages": []})
    source_text_for_comparison = "\n".join(page.get_text("text") or "" for page in source)
    result_text_for_comparison = "\n".join(page.get_text("text") or "" for page in result)
    translation_text_similarity = round(difflib.SequenceMatcher(None, source_text_for_comparison, result_text_for_comparison, autojunk=False).ratio(), 3)
    translation_aware_typography = bool(
        len(source_pages) == len(result_pages)
        and char_ratio >= MIN_TEXT_CHAR_RATIO
        and typography_match["positionCoverageRate"] >= MIN_POSITION_COVERAGE
        and visual_review["score"] >= PASS_SCORE
        and image_ratio >= 0.95
        and drawing_ratio >= 0.95
        and translation_text_similarity < 0.85
    )
    if translation_aware_typography:
        typography_match = {
            **typography_match,
            "score": max(90, typography_match["score"]),
            "translationAware": True,
            "translationTextSimilarity": translation_text_similarity,
            "fontMismatchPolicy": "visual-capture-first-for-translated-text",
        }

    if len(source_pages) != len(result_pages):
        warnings.append(f"Sayfa sayısı değişti ({len(source_pages)} → {len(result_pages)}).")
    if size_differences:
        warnings.append(f"Sayfa ölçüsü değişen sayfalar: {size_differences}.")
    if blank_pages:
        warnings.append(f"Boş veya metinsiz çıktı sayfaları: {sorted(set(blank_pages))}.")
    if overflow_pages:
        warnings.append(f"Sayfa dışına taşmış metin olabilecek sayfalar: {overflow_pages}.")
    if small_font_pages:
        warnings.append(f"Çok küçük font tespit edilen sayfalar: {small_font_pages} ({result_metrics['smallFonts']} metin parçası).")
    if result_metrics["fontMin"] is not None and result_metrics["fontMin"] < MIN_FONT_SIZE:
        warnings.append(f"Çıktıdaki en küçük font {result_metrics['fontMin']} pt; okunabilirlik kontrol edilmeli.")
    if typography_match["fontMatchRate"] < 0.95 and not translation_aware_typography:
        warnings.append(f"Metin font eşleşmesi düşük: %{round(typography_match['fontMatchRate'] * 100)}.")
    if typography_match["sizeMatchRate"] < 0.95 and not translation_aware_typography:
        warnings.append(f"Metin boyutu eşleşmesi düşük: %{round(typography_match['sizeMatchRate'] * 100)}.")
    if typography_match["positionCoverageRate"] < MIN_POSITION_COVERAGE:
        warnings.append(f"Metin konum kapsamÄ± dÃ¼ÅŸÃ¼k: %{round(typography_match['positionCoverageRate'] * 100)}; bazÄ± metin bloklarÄ± eksik veya kaymÄ±ÅŸ olabilir.")
    if font_median_ratio < 0.9 and not translation_aware_typography:
        warnings.append(f"Medyan font boyutu kaynağın %{round(font_median_ratio * 100)} seviyesine düştü.")
    if char_ratio < MIN_TEXT_CHAR_RATIO:
        warnings.append(f"Metin kapsamı olağan dışı düşük: karakter %{round(char_ratio * 100)}, kelime %{round(word_ratio * 100)}.")
    if text_area_ratio < 0.65 and (font_median_ratio < 0.9 or char_ratio < MIN_TEXT_CHAR_RATIO or overflow_pages or blank_pages):
        warnings.append(f"Metin kapladığı alan kaynağın %{round(text_area_ratio * 100)} seviyesinde; küçülme veya boşluk oluşmuş olabilir.")
    if result_metrics["images"] < source_metrics["images"]:
        warnings.append(f"Görsel varlık sayısı azaldı ({source_metrics['images']} → {result_metrics['images']}); logo veya resimlerin korunması kontrol edilmeli.")
    if result_metrics["drawings"] < source_metrics["drawings"]:
        warnings.append(f"Vektör çizim sayısı azaldı ({source_metrics['drawings']} → {result_metrics['drawings']}); çizgi, şekil veya logo kaybı olabilir.")
    if result_metrics["links"] < source_metrics["links"]:
        warnings.append(f"Bağlantı sayısı azaldı ({source_metrics['links']} → {result_metrics['links']}).")
    if result_metrics["annotations"] < source_metrics["annotations"]:
        warnings.append(f"Ek açıklama/form alanı sayısı azaldı ({source_metrics['annotations']} → {result_metrics['annotations']}).")
    if visual_review["score"] < PASS_SCORE:
        for issue in visual_review["issues"][:5]:
            warnings.append(f"Görsel kontrol: {issue['message']}")
    if block_geometry["score"] < PASS_SCORE:
        for issue in block_geometry["issues"][:5]:
            warnings.append(f"Blok kontrolü: {issue['message']}")

    if region_review["score"] < PASS_SCORE:
        for issue in region_review["issues"][:5]:
            warnings.append(f"Region kontrolü: {issue['message']}")

    page_score = 100
    page_score -= 35 if len(source_pages) != len(result_pages) else 0
    page_score -= min(25, len(size_differences) * 10)
    page_score -= min(25, len(blank_pages) * 15)
    page_score = max(0, page_score)

    text_score = 100
    # Different languages can change word counts, but a substantial character
    # collapse is a reliable missing-content signal for this block renderer.
    if char_ratio < MIN_TEXT_CHAR_RATIO or typography_match["positionCoverageRate"] < MIN_POSITION_COVERAGE:
        text_score = 65

    typography_score = 100
    typography_score -= min(20, result_metrics["smallFonts"] * 2)
    typography_score -= 15 if result_metrics["fontMin"] is not None and result_metrics["fontMin"] < MIN_FONT_SIZE else 0
    typography_score -= 10 if font_median_ratio < 0.9 else 0
    typography_score -= 5 if result_metrics["fontFamilies"] < source_metrics["fontFamilies"] else 0
    typography_score = min(typography_score, typography_match["score"])
    if translation_aware_typography:
        typography_score = max(90, typography_score)
    typography_score = max(0, typography_score)

    visual_score = round((image_ratio * 100 * 0.6) + (drawing_ratio * 100 * 0.4))
    visual_score = max(0, min(100, visual_score))
    layout_score = 100
    layout_score -= min(25, len(overflow_pages) * 15)
    layout_score -= min(25, len(blank_pages) * 15)
    layout_score = max(0, min(layout_score, block_geometry["score"], region_review["score"]))

    quality_layers = {
        "fileIntegrity": {"score": 100, "status": "pass", "sourceBytes": len(source_bytes), "resultBytes": len(result_bytes)},
        "pageStructure": {"score": page_score, "status": "pass" if page_score >= PASS_SCORE else "warning", "sourcePages": len(source_pages), "resultPages": len(result_pages), "sizeDifferences": size_differences},
        "text": {"score": text_score, "status": "pass" if text_score >= PASS_SCORE else "warning", "sourceChars": source_metrics["chars"], "resultChars": result_metrics["chars"], "sourceWords": source_metrics["words"], "resultWords": result_metrics["words"], "sourceTextBlocks": source_metrics["textBlocks"], "resultTextBlocks": result_metrics["textBlocks"], "charRatio": char_ratio, "wordRatio": word_ratio, "textBlockRatio": text_block_ratio, "textAreaRatio": text_area_ratio, "minimumCharRatio": MIN_TEXT_CHAR_RATIO, "minimumPositionCoverage": MIN_POSITION_COVERAGE, "positionCoverageRate": typography_match["positionCoverageRate"], "coverage": coverage},
        "typography": {"score": typography_score, "status": "pass" if typography_score >= PASS_SCORE else "warning", "source": {"min": source_metrics["fontMin"], "p10": source_metrics["fontP10"], "median": source_metrics["fontMedian"], "max": source_metrics["fontMax"]}, "result": {"min": result_metrics["fontMin"], "p10": result_metrics["fontP10"], "median": result_metrics["fontMedian"], "max": result_metrics["fontMax"]}, "smallFontSpans": result_metrics["smallFonts"], "fontMedianRatio": font_median_ratio},
        "typographyConsistency": {**typography_match, "status": "pass" if typography_match["score"] >= PASS_SCORE else "warning"},
        "visualAssets": {"score": visual_score, "status": "pass" if visual_score >= PASS_SCORE else "warning", "sourceImages": source_metrics["images"], "resultImages": result_metrics["images"], "sourceUniqueImages": source_metrics["uniqueImages"], "resultUniqueImages": result_metrics["uniqueImages"], "sourceDrawings": source_metrics["drawings"], "resultDrawings": result_metrics["drawings"], "imageRatio": image_ratio, "drawingRatio": drawing_ratio},
        "visualReview": visual_review,
        "captureComparison": capture_comparison,
        "colorConsistency": color_consistency,
        "blockGeometry": block_geometry,
        "regionGeometry": region_review,
        "layout": {"score": layout_score, "status": "pass" if layout_score >= PASS_SCORE else "warning", "sourceTextBlocks": source_metrics["textBlocks"], "resultTextBlocks": result_metrics["textBlocks"], "sourceLinks": source_metrics["links"], "resultLinks": result_metrics["links"], "sourceAnnotations": source_metrics["annotations"], "resultAnnotations": result_metrics["annotations"], "overflowPages": overflow_pages, "blankPages": sorted(set(blank_pages))},
    }
    weighted_score = round((page_score * 0.15) + (text_score * 0.20) + (typography_score * 0.15) + (color_consistency["score"] * 0.10) + (visual_score * 0.10) + (capture_comparison["score"] * 0.10) + (visual_review["score"] * 0.10) + (region_review["score"] * 0.05) + (layout_score * 0.05))
    # A document is only as good as its weakest critical layer. This prevents
    # a high weighted average from hiding omitted text or broken layout.
    score = max(0, min(100, weighted_score, page_score, text_score, typography_score, color_consistency["score"], visual_score, capture_comparison["score"], visual_review["score"], block_geometry["score"], region_review["score"], layout_score))
    source.close()
    result.close()
    return {
        "passed": score >= PASS_SCORE,
        "score": score,
        "warnings": warnings,
        "sourcePageCount": len(source_pages),
        "resultPageCount": len(result_pages),
        "sourcePageSizes": [{"width": round(page["width"], 2), "height": round(page["height"], 2)} for page in source_pages],
        "resultPageSizes": [{"width": round(page["width"], 2), "height": round(page["height"], 2)} for page in result_pages],
        "textCoverage": coverage,
        "possibleOverflowPages": overflow_pages,
        "blankPages": sorted(set(blank_pages)),
        "qualityLayers": quality_layers,
    }


def repair_visual_assets(source_bytes: bytes, result_bytes: bytes) -> tuple[bytes, int]:
    """Restore small source image regions that a document translator dropped.

    Logos and decorative marks are frequently embedded as images in PDFs. Azure's
    translated PDF can preserve the page but omit or rasterize those assets. We
    copy only small, explicitly embedded source images to their original page
    rectangles; large photographs/backgrounds are intentionally left untouched.
    """
    source = fitz.open(stream=source_bytes, filetype="pdf")
    result = fitz.open(stream=result_bytes, filetype="pdf")
    repaired = 0
    try:
        for page_index in range(min(len(source), len(result))):
            source_page = source[page_index]
            result_page = result[page_index]
            page_area = max(source_page.rect.width * source_page.rect.height, 1)
            seen_rects: set[tuple[int, float, float, float, float]] = set()
            for image in source_page.get_images(full=True):
                if not image or not image[0]:
                    continue
                xref = int(image[0])
                try:
                    image_info = source.extract_image(xref)
                    stream = image_info.get("image")
                    rects = source_page.get_image_rects(xref)
                except Exception:
                    continue
                if not stream:
                    continue
                for raw_rect in rects:
                    rect = fitz.Rect(raw_rect)
                    rect_key = (xref, round(rect.x0, 2), round(rect.y0, 2), round(rect.x1, 2), round(rect.y1, 2))
                    if rect_key in seen_rects:
                        continue
                    seen_rects.add(rect_key)
                    rect_area = max(rect.width, 0) * max(rect.height, 0)
                    if rect.width < 8 or rect.height < 8 or rect_area > page_area * 0.20:
                        continue
                    result_page.draw_rect(rect, color=None, fill=(1, 1, 1), overlay=True)
                    result_page.insert_image(rect, stream=stream, keep_proportion=False, overlay=True)
                    repaired += 1
        if repaired == 0:
            return result_bytes, 0
        return result.tobytes(garbage=4, deflate=True), repaired
    finally:
        source.close()
        result.close()


def text_blocks(page: fitz.Page) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        spans = [span for line in block.get("lines", []) for span in line.get("spans", []) if span.get("text", "").strip()]
        if not spans:
            continue
        rect = fitz.Rect(spans[0].get("bbox", (0, 0, 0, 0)))
        for span in spans[1:]:
            rect |= fitz.Rect(span.get("bbox", (0, 0, 0, 0)))
        lines = []
        line_boxes = []
        for line in block.get("lines", []):
            line_spans = [span for span in line.get("spans", []) if span.get("text", "").strip()]
            line_text = "".join(str(span.get("text", "")) for span in line_spans)
            if line_text.strip():
                lines.append(line_text)
                line_rect = fitz.Rect(line_spans[0].get("bbox", (0, 0, 0, 0)))
                for span in line_spans[1:]:
                    line_rect |= fitz.Rect(span.get("bbox", (0, 0, 0, 0)))
                line_boxes.append({"text": line_text, "rect": line_rect, "spans": line_spans})
        blocks.append({
            "text": "\n".join(lines).strip(),
            "rect": rect,
            "spans": spans,
            "lineBoxes": line_boxes,
            "center": ((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2),
        })
    return sorted(blocks, key=lambda item: (item["rect"].y0, item["rect"].x0))


def source_background(page: fitz.Page, rect: fitz.Rect) -> tuple[float, float, float]:
    """Find the page/fill color without sampling neighboring glyphs.

    Text boxes are tightly packed in multi-column PDFs, so even a small corner
    probe can land on the previous line and create a gray redaction rectangle.
    Prefer an actual vector fill under the text; otherwise use the page corner
    color, which is the correct canvas for this document.
    """
    try:
        center = fitz.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)
        for drawing in page.get_drawings():
            fill = drawing.get("fill")
            drawing_rect = drawing.get("rect")
            if fill and drawing_rect and fitz.Rect(drawing_rect).contains(center):
                return tuple(round(max(0, min(1, float(value))), 3) for value in fill[:3])

        samples = []
        corner_size = 8
        corners = (
            fitz.Rect(page.rect.x0, page.rect.y0, page.rect.x0 + corner_size, page.rect.y0 + corner_size),
            fitz.Rect(page.rect.x1 - corner_size, page.rect.y0, page.rect.x1, page.rect.y0 + corner_size),
            fitz.Rect(page.rect.x0, page.rect.y1 - corner_size, page.rect.x0 + corner_size, page.rect.y1),
            fitz.Rect(page.rect.x1 - corner_size, page.rect.y1 - corner_size, page.rect.x1, page.rect.y1),
        )
        for corner in corners:
            corner_pixmap = page.get_pixmap(matrix=fitz.Matrix(1, 1), clip=corner, colorspace=fitz.csRGB, alpha=False)
            if corner_pixmap.width and corner_pixmap.height:
                offset = ((corner_pixmap.height // 2) * corner_pixmap.width + (corner_pixmap.width // 2)) * corner_pixmap.n
                samples.append(tuple(corner_pixmap.samples[offset + channel] / 255 for channel in range(3)))
        if not samples:
            return (1, 1, 1)
        return tuple(round(sum(sample[channel] for sample in samples) / len(samples), 3) for channel in range(3))
    except Exception:
        return (1, 1, 1)


def font_supports_text(font_bytes: bytes, text: str) -> bool:
    try:
        font = fitz.Font(fontbuffer=font_bytes)
        return all(char.isspace() or font.has_glyph(ord(char), fallback=0) > 0 for char in text)
    except Exception:
        return False


def source_font(page: fitz.Page, document: fitz.Document, span: dict[str, Any], cache: dict[str, str], text: str = "", prefer_condensed: bool = False) -> str:
    font_path = UNICODE_FONT_PATH
    font_name = str(span.get("font", "")).lower()
    flags = int(span.get("flags", 0) or 0)
    is_bold = "bold" in font_name or bool(flags & 16)
    is_italic = "italic" in font_name or "oblique" in font_name or bool(flags & 2)
    style_key = "regular"
    if is_bold and is_italic:
        style_key = "bold_italic"
        font_path = font_path.replace("DejaVuSans.ttf", "DejaVuSans-BoldOblique.ttf")
    elif is_bold:
        style_key = "bold"
        font_path = font_path.replace("DejaVuSans.ttf", "DejaVuSans-Bold.ttf")
    elif is_italic:
        style_key = "italic"
        font_path = font_path.replace("DejaVuSans.ttf", "DejaVuSans-Oblique.ttf")
    if prefer_condensed:
        font_path = font_path.replace("DejaVuSans", "DejaVuSansCondensed")
    requested = str(span.get("font", ""))
    if not prefer_condensed:
        for font in page.get_fonts(full=True):
            if len(font) < 4:
                continue
            base_name = str(font[3]).lstrip("/")
            if requested and requested not in {base_name, base_name.split("+")[-1]}:
                continue
            try:
                extracted = document.extract_font(int(font[0]))
                font_bytes = extracted[3] if len(extracted) > 3 else None
                if font_bytes and font_supports_text(font_bytes, text):
                    alias = f"preserve_{int(font[0])}"
                    page.insert_font(fontname=alias, fontbuffer=font_bytes)
                    cache[f"source:{int(font[0])}"] = alias
                    return alias
            except Exception:
                continue
    unicode_key = f"unicode:{style_key}:{'condensed' if prefer_condensed else 'normal'}"
    if unicode_key in cache:
        return cache[unicode_key]
    if os.path.exists(font_path):
        try:
            alias = f"preserve_unicode_{style_key}_{'condensed' if prefer_condensed else 'normal'}"
            page.insert_font(fontname=alias, fontfile=font_path)
            cache[unicode_key] = alias
            return alias
        except Exception:
            pass
    cache[requested] = "helv"
    return "helv"


def span_color(span: dict[str, Any]) -> tuple[float, float, float]:
    color = int(span.get("color", 0) or 0)
    return ((color >> 16 & 255) / 255, (color >> 8 & 255) / 255, (color & 255) / 255)


def block_alignment(source_block: dict[str, Any]) -> int:
    rect = source_block["rect"]
    line_rects = []
    for span in source_block["spans"]:
        line_rects.append(fitz.Rect(span.get("bbox", (0, 0, 0, 0))))
    if not line_rects:
        return 0
    left_gap = sum(abs(line.x0 - rect.x0) for line in line_rects) / len(line_rects)
    right_gap = sum(abs(rect.x1 - line.x1) for line in line_rects) / len(line_rects)
    if right_gap < left_gap * 0.55:
        return 2
    if abs(left_gap - right_gap) < max(2, rect.width * 0.08):
        return 1
    return 0


def translation_lines_for_boxes(translated_text: str, line_boxes: list[dict[str, Any]], base_size: float) -> list[str]:
    expected = len(line_boxes)
    lines = [line.strip() for line in str(translated_text).replace("\r\n", "\n").split("\n") if line.strip()]
    if len(lines) == expected:
        return lines
    words = " ".join(lines).split()
    if not words or expected == 0:
        return []
    capacities = [max(8, int(fitz.Rect(box["rect"]).width / max(base_size * 0.55, 1))) for box in line_boxes]
    output: list[str] = []
    cursor = 0
    for index in range(expected):
        slots_left = expected - index
        words_left = len(words) - cursor
        if words_left <= 0:
            output.append("")
            continue
        if slots_left == 1:
            output.append(" ".join(words[cursor:]))
            break
        capacity = capacities[index]
        line_words: list[str] = []
        while cursor < len(words):
            candidate = " ".join(line_words + [words[cursor]])
            if line_words and len(candidate) > capacity and len(words) - cursor >= slots_left:
                break
            line_words.append(words[cursor])
            cursor += 1
            if len(line_words) >= 1 and len(" ".join(line_words)) >= capacity:
                break
        output.append(" ".join(line_words))
    while len(output) < expected:
        output.append("")
    return output[:expected]


def insert_single_line_text(page: fitz.Page, document: fitz.Document, source_block: dict[str, Any], translated_text: str, font_cache: dict[str, str], global_scale: float) -> bool:
    rect = fitz.Rect(source_block["rect"])
    first_span = source_block["spans"][0]
    base_size = max(float(first_span.get("size", 8)) * global_scale, 5)
    font_name = source_font(page, document, first_span, font_cache, translated_text)
    condensed_font_name = source_font(page, document, first_span, font_cache, translated_text, prefer_condensed=True)
    color = span_color(first_span)
    alignment = int(source_block.get("alignment", block_alignment(source_block)))
    fonts = []
    for candidate in (font_name, condensed_font_name):
        if candidate not in fonts:
            fonts.append(candidate)

    def try_candidate(size: float, width_scale: float) -> bool:
        render_rect = fitz.Rect(rect.x0, rect.y0, rect.x0 + rect.width / width_scale, rect.y1)
        shape = page.new_shape()
        try:
            kwargs = {
                "fontname": condensed_font_name,
                "fontsize": size,
                "color": color,
                "align": alignment,
                "lineheight": 1.0,
            }
            if width_scale != 1.0:
                kwargs["morph"] = (fitz.Point(rect.x0, rect.y0), fitz.Matrix(width_scale, 1))
            spare = shape.insert_textbox(render_rect, translated_text, **kwargs)
        except Exception:
            spare = -float("inf")
        if spare >= -0.01:
            shape.commit(overlay=True)
            return True
        return False

    # Short labels must stay on one visual line. Try controlled horizontal
    # compression before accepting a smaller font that can wrap into a second
    # line and collide with the next form row.
    for factor in (1.0, 0.97, 0.94, 0.90, 0.86, 0.82, 0.78, 0.74, 0.70, 0.65, 0.60):
        size = max(4.0, round(base_size * factor, 2))
        for width_scale in (0.98, 0.94, 0.88, 0.82, 0.76, 0.70, 0.64, 0.58, 0.52, 0.46, 0.40):
            if try_candidate(size, width_scale):
                return True

    for factor in (1.0, 0.97, 0.94):
        size = max(4.0, round(base_size * factor, 2))
        for candidate_font in fonts:
            render_rect = fitz.Rect(rect.x0, rect.y0, rect.x1, rect.y1)
            shape = page.new_shape()
            try:
                spare = shape.insert_textbox(render_rect, translated_text, fontname=candidate_font, fontsize=size, color=color, align=alignment, lineheight=1.0)
            except Exception:
                spare = -float("inf")
            if spare >= -0.01:
                shape.commit(overlay=True)
                return True

    # Headings should remain readable and visually dominant. Let them use a
    # smaller point size before applying horizontal compression.
    if base_size >= 12:
        for factor in (0.90, 0.86, 0.82, 0.78, 0.74, 0.70, 0.65, 0.60):
            size = max(5.0, round(base_size * factor, 2))
            for candidate_font in fonts:
                render_rect = fitz.Rect(rect.x0, rect.y0, rect.x1, rect.y1)
                shape = page.new_shape()
                try:
                    spare = shape.insert_textbox(render_rect, translated_text, fontname=candidate_font, fontsize=size, color=color, align=alignment, lineheight=1.0)
                except Exception:
                    spare = -float("inf")
                if spare >= -0.01:
                    shape.commit(overlay=True)
                    return True

    # Preserve vertical font size before making a line smaller. The horizontal
    # transform is deliberately limited and only affects the long line itself.
    for factor in (1.0, 0.97, 0.94, 0.90, 0.86, 0.82, 0.78):
        size = max(4.0, round(base_size * factor, 2))
        for width_scale in (0.97, 0.94, 0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60, 0.55):
            if try_candidate(size, width_scale):
                return True

    for factor in (0.74, 0.70, 0.65, 0.60, 0.55, 0.50, 0.45, 0.40):
        size = max(2.5, round(base_size * factor, 2))
        for width_scale in (1.0, 0.85, 0.70, 0.60):
            if try_candidate(size, width_scale):
                return True
    return False


def insert_explicit_line_text(page: fitz.Page, document: fitz.Document, source_block: dict[str, Any], translated_text: str, font_cache: dict[str, str], global_scale: float) -> bool:
    """Render an explicitly line-broken block atomically.

    Some documents contain deliberate line breaks in headings or labels. Fit
    every line first and only commit the shapes after all lines fit; this avoids
    leaving half a paragraph behind when one line cannot be placed safely.
    """
    line_boxes = source_block.get("lineBoxes") or []
    if not line_boxes:
        return False
    translated_lines = [line.strip() for line in str(translated_text).replace("\r\n", "\n").split("\n")]
    if len(translated_lines) != len(line_boxes) or any(not line for line in translated_lines):
        return False
    first_span = source_block["spans"][0]
    base_size = max(float(first_span.get("size", 8)) * global_scale, MIN_FONT_SIZE)
    font_name = source_font(page, document, first_span, font_cache, translated_text)
    condensed_font_name = source_font(page, document, first_span, font_cache, translated_text, prefer_condensed=True)
    fonts = []
    for candidate in (font_name, condensed_font_name):
        if candidate not in fonts:
            fonts.append(candidate)
    color = span_color(first_span)
    alignment = int(source_block.get("alignment", block_alignment(source_block)))
    shapes: list[Any] = []
    for line_box, line_text in zip(line_boxes, translated_lines):
        rect = fitz.Rect(line_box["rect"])
        fitted_shape = None
        for factor in (1.0, 0.97, 0.94, 0.90, 0.86, 0.82, 0.78, 0.74, 0.70, 0.65, 0.60):
            size = max(MIN_FONT_SIZE, round(base_size * factor, 2))
            for candidate_font in fonts:
                for width_scale in (1.0, 0.94, 0.88, 0.82, 0.76):
                    render_rect = fitz.Rect(rect.x0, rect.y0, rect.x0 + rect.width / width_scale, rect.y1)
                    shape = page.new_shape()
                    try:
                        spare = shape.insert_textbox(render_rect, line_text, fontname=candidate_font, fontsize=size, color=color, align=alignment, lineheight=1.0, **({"morph": (fitz.Point(rect.x0, rect.y0), fitz.Matrix(width_scale, 1))} if width_scale != 1.0 else {}))
                    except Exception:
                        spare = -float("inf")
                    if spare >= -0.01:
                        fitted_shape = shape
                        break
                if fitted_shape is not None:
                    break
            if fitted_shape is not None:
                break
        if fitted_shape is None:
            return False
        shapes.append(fitted_shape)
    for shape in shapes:
        shape.commit(overlay=True)
    return True


def insert_preserved_text(page: fitz.Page, document: fitz.Document, source_block: dict[str, Any], translated_text: str, font_cache: dict[str, str], global_scale: float = 1.0) -> bool:
    rect = fitz.Rect(source_block.get("renderRect", source_block["rect"]))
    if rect.is_empty or not translated_text.strip():
        return False
    first_span = source_block["spans"][0]
    base_size = max(float(first_span.get("size", 8)) * global_scale, 5)

    # A translated sentence is often longer than the source line. Rendering
    # each translated line into the original line boxes makes the text collide
    # or forces it into unreadable horizontal compression. Render the complete
    # paragraph inside the safe rectangle instead; the renderer then wraps it
    # naturally and the visual gate checks the resulting geometry.
    alignment = int(source_block.get("alignment", block_alignment(source_block)))
    if (
        "\n" not in translated_text
        and len(source_block.get("lineBoxes") or []) == 1
        and len(translated_text.strip()) > len(source_block.get("text", "").strip()) * 1.05
    ):
        if insert_single_line_text(page, document, source_block, translated_text, font_cache, global_scale):
            return True
    if "\n" in translated_text and insert_explicit_line_text(page, document, source_block, translated_text, font_cache, global_scale):
        return True

    font_name = source_font(page, document, first_span, font_cache, translated_text)
    condensed_font_name = source_font(page, document, first_span, font_cache, translated_text, prefer_condensed=True)
    color = span_color(first_span)
    alignment = int(source_block.get("alignment", block_alignment(source_block)))
    # Keep normal line spacing and reduce the font size before compressing
    # line spacing. A very small lineheight can make insert_textbox report a
    # successful fit while glyphs overlap or become effectively unreadable.
    font_sizes = [round(base_size * factor, 2) for factor in (1.0, 0.97, 0.94, 0.90, 0.86, 0.82, 0.78, 0.74, 0.70, 0.65, 0.60)]
    font_sizes.append(MIN_FONT_SIZE)
    font_sizes = sorted({max(MIN_FONT_SIZE, size) for size in font_sizes}, reverse=True)
    candidate_fonts = []
    for candidate in (font_name, condensed_font_name):
        if candidate not in candidate_fonts:
            candidate_fonts.append(candidate)
    for lineheight in (1.15, 1.10, 1.05, 1.0):
        for size in font_sizes:
            for candidate_font in candidate_fonts:
                render_rect = fitz.Rect(rect.x0, rect.y0, rect.x1, rect.y1)
                shape = page.new_shape()
                try:
                    spare = shape.insert_textbox(
                        render_rect,
                        translated_text,
                        fontname=candidate_font,
                        fontsize=size,
                        color=color,
                        align=alignment,
                        lineheight=lineheight,
                    )
                except Exception:
                    spare = -float("inf")
                if spare >= -0.01:
                    shape.commit(overlay=True)
                    return True

    # Use proportional compression only after the readable candidates fail.
    for size in font_sizes:
        for width_scale in (0.97, 0.94, 0.90, 0.86):
            render_rect = fitz.Rect(rect.x0, rect.y0, rect.x0 + rect.width / width_scale, rect.y1)
            shape = page.new_shape()
            try:
                spare = shape.insert_textbox(
                    render_rect,
                    translated_text,
                    fontname=condensed_font_name,
                    fontsize=size,
                    color=color,
                    align=alignment,
                    lineheight=0.85,
                    morph=(fitz.Point(rect.x0, rect.y0), fitz.Matrix(width_scale, 1)),
                )
            except Exception:
                spare = -float("inf")
            if spare >= -0.01:
                shape.commit(overlay=True)
                return True

    # Never spill a paragraph into the rest of the page. A failed fit must
    # remain a failed block so the caller can reject the candidate and try a
    # safer scale instead of producing an apparently complete but corrupted
    # document.
    return False


def extract_layout(source_bytes: bytes) -> list[dict[str, Any]]:
    document = fitz.open(stream=source_bytes, filetype="pdf")
    blocks: list[dict[str, Any]] = []
    try:
        for page_index, page in enumerate(document):
            for block_index, block in enumerate(text_blocks(page)):
                first_span = block["spans"][0]
                blocks.append({
                    "id": f"{page_index}:{block_index}",
                    "page": page_index,
                    "text": block["text"],
                    "bbox": [round(value, 3) for value in (block["rect"].x0, block["rect"].y0, block["rect"].x1, block["rect"].y1)],
                    "font": str(first_span.get("font", "")),
                    "size": round(float(first_span.get("size", 8)), 3),
                    "color": int(first_span.get("color", 0) or 0),
                    "lines": len(block["text"].splitlines()),
                })
        return blocks
    finally:
        document.close()


def expanded_render_rect(block: dict[str, Any], blocks: list[dict[str, Any]], page: fitz.Page) -> fitz.Rect:
    rect = fitz.Rect(block["rect"])
    candidates = []
    for other in blocks:
        other_rect = fitz.Rect(other["rect"])
        horizontal_overlap = max(0, min(rect.x1, other_rect.x1) - max(rect.x0, other_rect.x0))
        # Reserve the space up to the next same-column block, even when the
        # source blocks touch on their baseline. Using rect.y1 here lets a
        # re-rendered long line wrap into the following paragraph.
        if other_rect.y0 > rect.y0 + 0.5 and horizontal_overlap >= rect.width * 0.2:
            candidates.append(other_rect.y0)
    # Leave a small collision buffer before the next source region. A textbox
    # can report a successful fit while its extracted glyph bbox reaches the
    # following line by a fraction of a point, especially after font fallback.
    bottom = min(candidates, default=page.rect.y1) - 3
    return fitz.Rect(rect.x0, rect.y0, rect.x1, max(rect.y1, bottom))


def render_preserved_layout_candidate(source_bytes: bytes, translations: dict[str, str], global_scale: float = 1.0) -> tuple[bytes, dict[str, Any]]:
    source = fitz.open(stream=source_bytes, filetype="pdf")
    replaced = 0
    reduced = 0
    failed = 0
    missing = 0
    try:
        for page_index, page in enumerate(source):
            page_blocks = text_blocks(page)
            font_cache: dict[str, str] = {}
            render_queue: list[tuple[dict[str, Any], str]] = []
            for block_index, block in enumerate(page_blocks):
                block_id = f"{page_index}:{block_index}"
                translated_text = str(translations.get(block_id, "")).strip()
                if not translated_text:
                    missing += 1
                    continue
                page.add_redact_annot(block["rect"], fill=source_background(page, block["rect"]))
                block["renderRect"] = expanded_render_rect(block, page_blocks, page)
                render_queue.append((block, translated_text))
            page.apply_redactions(images=0, graphics=0, text=0)
            for block, translated_text in render_queue:
                if insert_preserved_text(page, source, block, translated_text, font_cache, global_scale):
                    replaced += 1
                else:
                    failed += 1
        if replaced == 0:
            return source_bytes, {"replacedBlocks": 0, "reducedBlocks": reduced, "missingBlocks": missing, "failedBlocks": failed, "fallback": True}
        return source.tobytes(garbage=4, deflate=True), {"replacedBlocks": replaced, "reducedBlocks": reduced, "missingBlocks": missing, "failedBlocks": failed, "fallback": False}
    finally:
        source.close()


def page_integrity_preserved(report: dict[str, Any]) -> bool:
    page_layer = report.get("qualityLayers", {}).get("pageStructure", {})
    layout_layer = report.get("qualityLayers", {}).get("layout", {})
    return (
        page_layer.get("sourcePages") == page_layer.get("resultPages")
        and not page_layer.get("sizeDifferences")
        and not layout_layer.get("overflowPages")
        and not layout_layer.get("blankPages")
    )


def translation_quality_gate(report: dict[str, Any]) -> bool:
    layers = report.get("qualityLayers", {})
    block_layer = layers.get("blockGeometry")
    visual_layer = layers.get("visualReview")
    color_layer = layers.get("colorConsistency")
    capture_layer = layers.get("captureComparison")
    region_layer = layers.get("regionGeometry")
    return (
        report.get("score", 0) >= PASS_SCORE
        and page_integrity_preserved(report)
        and (block_layer is None or block_layer.get("score", 0) >= PASS_SCORE)
        and (visual_layer is None or visual_layer.get("score", 0) >= PASS_SCORE)
        and (color_layer is None or color_layer.get("score", 0) >= PASS_SCORE)
        and (capture_layer is None or capture_layer.get("score", 0) >= PASS_SCORE)
        and (region_layer is None or region_layer.get("score", 0) >= PASS_SCORE)
    )


def render_preserved_layout(source_bytes: bytes, translations: dict[str, str]) -> tuple[bytes, dict[str, Any]]:
    """Render candidates and progressively shrink all text only when layout breaks."""
    shrink_steps = [0.00, 0.03, 0.05, 0.07, 0.10, 0.14, 0.18, 0.22, 0.27, 0.32]
    best: dict[str, Any] | None = None
    candidate_scores: list[dict[str, Any]] = []
    for shrink in shrink_steps:
        scale = round(1 - shrink, 3)
        output, render_details = render_preserved_layout_candidate(source_bytes, translations, scale)
        report = inspect_documents(source_bytes, output)
        candidate = {"output": output, "render": render_details, "report": report, "scale": scale}
        candidate_scores.append({"scale": scale, "score": report["score"], "pageIntegrity": page_integrity_preserved(report), "missingBlocks": render_details.get("missingBlocks", 0), "failedBlocks": render_details.get("failedBlocks", 0)})
        candidate_key = (
            1 if render_details.get("missingBlocks", 0) == 0 and render_details.get("failedBlocks", 0) == 0 else 0,
            1 if page_integrity_preserved(report) else 0,
            report["score"],
            scale,
        )
        if best is None or candidate_key > (
            1 if best["render"].get("missingBlocks", 0) == 0 and best["render"].get("failedBlocks", 0) == 0 else 0,
            1 if page_integrity_preserved(best["report"]) else 0,
            best["report"]["score"],
            best["scale"],
        ):
            best = candidate
        else:
            # Do not retain every full PDF candidate while the expensive
            # raster inspection is running on a dense vector form.
            del output
        complete = render_details.get("missingBlocks", 0) == 0 and render_details.get("failedBlocks", 0) == 0
        geometry_score = report.get("qualityLayers", {}).get("blockGeometry", {}).get("score", PASS_SCORE)
        # Once the source-region geometry is sound, shrinking cannot repair a
        # font/color/capture mismatch and only repeats an expensive full-page
        # raster inspection. Retry only when the layout layer itself needs it.
        layout_is_sound = page_integrity_preserved(report) and geometry_score >= PASS_SCORE
        if complete and (translation_quality_gate(report) or layout_is_sound):
            break
    assert best is not None
    details = {
        **best["render"],
        "attempts": len(candidate_scores),
        "attemptedScales": [candidate["scale"] for candidate in candidate_scores],
        "selectedScale": best["scale"],
        "shrinkPercent": round((1 - best["scale"]) * 100, 1),
        "selectedQualityScore": best["report"]["score"],
        "pageIntegrityPreserved": page_integrity_preserved(best["report"]),
        "qualityGatePassed": translation_quality_gate(best["report"]),
        "candidateScores": candidate_scores,
        "selectedLayerScores": {
            name: layer.get("score")
            for name, layer in best["report"].get("qualityLayers", {}).items()
            if isinstance(layer, dict) and "score" in layer
        },
        "selectedLayerStatuses": {
            name: layer.get("status")
            for name, layer in best["report"].get("qualityLayers", {}).items()
            if isinstance(layer, dict) and "status" in layer
        },
        "selectedGeometryReview": {
            "pageScores": best["report"].get("qualityLayers", {}).get("blockGeometry", {}).get("pageScores", []),
            "issues": best["report"].get("qualityLayers", {}).get("blockGeometry", {}).get("issues", [])[:20],
        },
    }
    return best["output"], details


def shrink_result_text_candidate(result_bytes: bytes, global_scale: float = 1.0) -> tuple[bytes, dict[str, Any]]:
    """Shrink every text block in an edited PDF by the same global factor."""
    document = fitz.open(stream=result_bytes, filetype="pdf")
    replaced = 0
    reduced = 0
    try:
        for page in document:
            blocks = text_blocks(page)
            font_cache: dict[str, str] = {}
            for block in blocks:
                page.add_redact_annot(block["rect"], fill=source_background(page, block["rect"]))
            page.apply_redactions(images=0, graphics=0, text=0)
            for block in blocks:
                if insert_preserved_text(page, document, block, block["text"], font_cache, global_scale):
                    replaced += 1
                else:
                    reduced += 1
        if replaced == 0:
            return result_bytes, {"replacedBlocks": 0, "reducedBlocks": reduced, "fallback": True}
        return document.tobytes(garbage=4, deflate=True), {"replacedBlocks": replaced, "reducedBlocks": reduced, "fallback": False}
    finally:
        document.close()


def adapt_text_layout(source_bytes: bytes, result_bytes: bytes) -> tuple[bytes, dict[str, Any]]:
    """Keep an edited PDF intact while progressively shrinking all its text when needed."""
    shrink_steps = [0.00, 0.03, 0.05, 0.07, 0.10, 0.14, 0.18, 0.22, 0.27, 0.32]
    initial_report = inspect_documents(source_bytes, result_bytes)
    if page_integrity_preserved(initial_report) and initial_report["score"] >= 95:
        return result_bytes, {
            "attempts": 1,
            "attemptedScales": [1.0],
            "selectedScale": 1.0,
            "shrinkPercent": 0.0,
            "selectedQualityScore": initial_report["score"],
            "pageIntegrityPreserved": True,
            "candidateScores": [{"scale": 1.0, "score": initial_report["score"], "pageIntegrity": True}],
            "replacedBlocks": 0,
            "reducedBlocks": 0,
            "fallback": False,
        }

    candidates: list[dict[str, Any]] = []
    for shrink in shrink_steps:
        scale = round(1 - shrink, 3)
        if scale == 1.0:
            output = result_bytes
            render_details = {"replacedBlocks": 0, "reducedBlocks": 0, "fallback": False}
        else:
            output, render_details = shrink_result_text_candidate(result_bytes, scale)
        report = inspect_documents(source_bytes, output)
        candidate = {"output": output, "render": render_details, "report": report, "scale": scale}
        candidates.append(candidate)
        if scale < 1.0 and page_integrity_preserved(report) and report["score"] >= 95:
            break

    best = max(
        candidates,
        key=lambda candidate: (
            1 if page_integrity_preserved(candidate["report"]) else 0,
            candidate["report"]["score"],
            candidate["scale"],
        ),
    )
    details = {
        **best["render"],
        "attempts": len(candidates),
        "attemptedScales": [candidate["scale"] for candidate in candidates],
        "selectedScale": best["scale"],
        "shrinkPercent": round((1 - best["scale"]) * 100, 1),
        "selectedQualityScore": best["report"]["score"],
        "pageIntegrityPreserved": page_integrity_preserved(best["report"]),
        "candidateScores": [
            {"scale": candidate["scale"], "score": candidate["report"]["score"], "pageIntegrity": page_integrity_preserved(candidate["report"])}
            for candidate in candidates
        ],
    }
    return best["output"], details


def preserve_layout(source_bytes: bytes, translated_bytes: bytes) -> tuple[bytes, dict[str, Any]]:
    """Use the source PDF as the canvas and replace only its text regions."""
    source = fitz.open(stream=source_bytes, filetype="pdf")
    translated = fitz.open(stream=translated_bytes, filetype="pdf")
    replaced = 0
    reduced = 0
    skipped = 0
    try:
        for page_index in range(min(len(source), len(translated))):
            source_page = source[page_index]
            translated_page = translated[page_index]
            original_blocks = text_blocks(source_page)
            translated_blocks = text_blocks(translated_page)
            if not original_blocks:
                continue
            used: set[int] = set()
            font_cache: dict[str, str] = {}
            for original in original_blocks:
                source_center = original["center"]
                candidates = [
                    (index, block) for index, block in enumerate(translated_blocks) if index not in used and block["text"].strip()
                ]
                if not candidates:
                    skipped += 1
                    continue
                index, translated_block = min(
                    candidates,
                    key=lambda item: abs(item[1]["center"][1] - source_center[1]) + abs(item[1]["center"][0] - source_center[0]) * 0.15,
                )
                used.add(index)
                background = source_background(source_page, original["rect"])
                source_page.add_redact_annot(original["rect"], fill=background)
                original["translatedText"] = translated_block["text"]
                original["fontCache"] = font_cache
            source_page.apply_redactions(images=0, graphics=0, text=0)
            for original in original_blocks:
                translated_text = original.get("translatedText")
                if not translated_text:
                    skipped += 1
                    continue
                if insert_preserved_text(source_page, source, original, translated_text, original["fontCache"]):
                    replaced += 1
                else:
                    reduced += 1
        if replaced == 0:
            return translated_bytes, {"replacedBlocks": 0, "reducedBlocks": 0, "skippedBlocks": skipped, "fallback": True}
        output = source.tobytes(garbage=4, deflate=True)
        return output, {"replacedBlocks": replaced, "reducedBlocks": reduced, "skippedBlocks": skipped, "fallback": False}
    finally:
        source.close()
        translated.close()


@app.get("/health")
def health():
    return {"ok": True, "service": "pdf-quality"}


@app.post("/inspect")
async def inspect(source: UploadFile = File(...), translated: UploadFile = File(...)):
    return inspect_documents(await source.read(), await translated.read())


@app.post("/repair-visual-assets")
async def repair_visual_assets_endpoint(source: UploadFile = File(...), translated: UploadFile = File(...)):
    repaired, count = repair_visual_assets(await source.read(), await translated.read())
    return Response(content=repaired, media_type="application/pdf", headers={"X-Repaired-Assets": str(count)})


@app.post("/preserve-layout")
async def preserve_layout_endpoint(source: UploadFile = File(...), translated: UploadFile = File(...)):
    output, details = preserve_layout(await source.read(), await translated.read())
    return Response(content=output, media_type="application/pdf", headers={"X-Preserve-Layout": str(details).replace("'", '"')})


@app.post("/extract-layout")
async def extract_layout_endpoint(source: UploadFile = File(...)):
    return {"blocks": extract_layout(await source.read())}


@app.post("/visual-profile")
async def visual_profile_endpoint(source: UploadFile = File(...), include_captures: bool = Form(False)):
    return visual_profile(await source.read(), include_captures=include_captures)


@app.post("/render-preserved-layout")
async def render_preserved_layout_endpoint(source: UploadFile = File(...), translations: str = Form(...)):
    try:
        parsed = json.loads(translations)
        translation_map = {str(item["id"]): str(item["text"]) for item in parsed if item.get("id") and item.get("text")}
    except Exception as exc:
        return Response(content=str(exc), status_code=422, media_type="text/plain")
    output, details = render_preserved_layout(await source.read(), translation_map)
    return Response(content=output, media_type="application/pdf", headers={"X-Render-Preserved-Layout": json.dumps(details)})


@app.post("/adapt-text-layout")
async def adapt_text_layout_endpoint(source: UploadFile = File(...), translated: UploadFile = File(...)):
    output, details = adapt_text_layout(await source.read(), await translated.read())
    return Response(content=output, media_type="application/pdf", headers={"X-Adaptive-Text-Layout": json.dumps(details)})
