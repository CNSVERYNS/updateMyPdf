"""Translate a designed PDF while preserving its page artwork and geometry.

The source bulletin is already visually composed: photos, diagrams, colored
callouts, and text live on the same page.  This script therefore groups text
by visual text areas, translates sentence units (never extracted source lines),
removes only the source text, and fits the English translation back into a
safe region of the original page.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import tempfile
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

import fitz


LIGATURES = {
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
    "\ufb05": "ft",
    "\ufb06": "st",
}


def normalize_source_text(text: str) -> str:
    for source, replacement in LIGATURES.items():
        text = text.replace(source, replacement)
    # This bulletin has a malformed extracted capital accent in its recurring
    # header.  Correct it before sending the text to the translator.
    text = text.replace("camiÓn", "camión").replace("CamiÓn", "Camión")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def azure_translate(texts: list[str], source_language: str = "es", target_language: str = "en") -> list[str]:
    endpoint = os.environ.get("AZURE_TRANSLATOR_ENDPOINT", "").rstrip("/")
    key = os.environ.get("AZURE_TRANSLATOR_KEY", "")
    if not endpoint or not key:
        raise RuntimeError("AZURE_TRANSLATOR_ENDPOINT and AZURE_TRANSLATOR_KEY are required")

    translated: list[str] = []
    for start in range(0, len(texts), 80):
        batch = texts[start:start + 80]
        query = urllib.parse.urlencode({"api-version": "3.0", "from": source_language, "to": target_language})
        request = urllib.request.Request(
            f"{endpoint}/translator/text/v3.0/translate?{query}",
            data=json.dumps([{"Text": text} for text in batch], ensure_ascii=False).encode("utf-8"),
            headers={"Ocp-Apim-Subscription-Key": key, "Content-Type": "application/json"},
            method="POST",
        )
        region = os.environ.get("AZURE_TRANSLATOR_REGION", "").strip()
        if region:
            request.add_header("Ocp-Apim-Subscription-Region", region)
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as error:
            raise RuntimeError(f"Azure text translation failed: {error}") from error
        for item in payload:
            values = item.get("translations") or []
            translated.append(str(values[0].get("text", "")) if values else "")

    if len(translated) != len(texts) or any(not value.strip() for value in translated):
        raise RuntimeError("Azure returned an incomplete translation batch")
    return translated


def line_text(line: dict[str, Any]) -> str:
    return "".join(str(span.get("text", "")) for span in line.get("spans", []))


def line_rect(line: dict[str, Any]) -> fitz.Rect:
    spans = [span for span in line.get("spans", []) if str(span.get("text", "")).strip()]
    if not spans:
        return fitz.Rect(line.get("bbox", (0, 0, 0, 0)))
    result = fitz.Rect(spans[0].get("bbox", (0, 0, 0, 0)))
    for span in spans[1:]:
        result |= fitz.Rect(span.get("bbox", (0, 0, 0, 0)))
    return result


def line_groups(page: fitz.Page) -> list[dict[str, Any]]:
    """Split extraction blocks into groups that correspond to visual text areas."""

    raw_lines: list[dict[str, Any]] = []
    for block_index, block in enumerate(page.get_text("dict").get("blocks", [])):
        if block.get("type") != 0:
            continue
        for line_index, line in enumerate(block.get("lines", [])):
            text = normalize_source_text(line_text(line))
            if not text:
                continue
            raw_lines.append({
                "text": text,
                "rect": line_rect(line),
                "spans": [span for span in line.get("spans", []) if str(span.get("text", "")).strip()],
                "blockIndex": block_index,
                "lineIndex": line_index,
            })

    # Repair extraction artifacts where a single visual line was split into
    # separate words.  The right column of page 1 contains exactly this case:
    # "llegara a presentar, desinfle la llanta inmediatamente".
    rows: list[dict[str, Any]] = []
    for item in sorted(raw_lines, key=lambda value: (value["rect"].y0, value["rect"].x0)):
        rect = item["rect"]
        numeric = bool(re.fullmatch(r"[\d\s]+", item["text"]))
        top_or_footer = rect.y0 < 150 or rect.y0 > page.rect.y1 - 70
        side = "left" if rect.x0 < page.rect.width / 2 else "right"
        match = None
        if not numeric and not top_or_footer:
            for row in rows:
                if row["numeric"] or row["topOrFooter"] or row["side"] != side:
                    continue
                if abs(row["rect"].y0 - rect.y0) <= 2.0 and rect.x0 <= row["rect"].x1 + 18 and rect.x1 >= row["rect"].x0 - 18:
                    match = row
                    break
        if match is None:
            rows.append({
                "text": item["text"],
                "rect": fitz.Rect(rect),
                "spans": list(item["spans"]),
                "side": side,
                "numeric": numeric,
                "topOrFooter": top_or_footer,
                "blockIndex": item["blockIndex"],
            })
        else:
            pieces = [(match["rect"].x0, match["text"], match["spans"]), (rect.x0, item["text"], item["spans"])]
            pieces.sort(key=lambda value: value[0])
            match["text"] = " ".join(piece[1] for piece in pieces)
            match["rect"] |= rect
            match["spans"].extend(item["spans"])

    # Join vertically adjacent rows with the same visual anchor into a
    # paragraph, but keep step numbers as independent visual labels.
    groups: list[dict[str, Any]] = []
    for side in ("left", "right"):
        side_rows = sorted((row for row in rows if row["side"] == side), key=lambda value: (value["rect"].y0, value["rect"].x0))
        current: list[dict[str, Any]] = []
        for row in side_rows:
            can_join = bool(current) and not row["numeric"] and not current[-1]["numeric"] and row["blockIndex"] == current[-1]["blockIndex"]
            if can_join:
                anchor = current[0]["rect"].x0
                can_join = abs(row["rect"].x0 - anchor) <= 26 and row["rect"].y0 - current[-1]["rect"].y1 <= 17
            if current and not can_join:
                groups.append(make_group(current, current[0]["blockIndex"]))
                current = []
            current.append(row)
        if current:
            groups.append(make_group(current, current[0]["blockIndex"]))

    return sorted(groups, key=lambda value: (value["pageY"], value["rect"].x0))


def make_group(lines: list[dict[str, Any]], block_index: int) -> dict[str, Any]:
    rect = fitz.Rect(lines[0]["rect"])
    spans: list[dict[str, Any]] = []
    for item in lines:
        rect |= item["rect"]
        spans.extend(item["spans"])
    return {
        "blockIndex": block_index,
        "lines": lines,
        "text": "\n".join(item["text"] for item in lines),
        "rect": rect,
        "pageY": rect.y0,
        "spans": spans,
        "column": lines[0].get("side", "left"),
    }


def sentence_units(text: str) -> list[str]:
    """Split source text at sentence boundaries, not at PDF line breaks."""

    compact = re.sub(r"\s+", " ", text).strip()
    if not compact:
        return []
    parts = re.split(r"(?<=[.!?])\s+(?=[\"'“”»)]*[A-ZÁÉÍÓÚÜÑ¡¿0-9])", compact)
    return [part.strip() for part in parts if part.strip()]


def font_kind_for_spans(spans: list[dict[str, Any]]) -> str:
    if not spans:
        return "regular"
    total = sum(max(1, len(str(span.get("text", "")))) for span in spans)
    bold_weight = sum(max(1, len(str(span.get("text", "")))) for span in spans if "bold" in str(span.get("font", "")).lower() or int(span.get("flags", 0) or 0) & 16)
    italic_weight = sum(max(1, len(str(span.get("text", "")))) for span in spans if "italic" in str(span.get("font", "")).lower() or int(span.get("flags", 0) or 0) & 2)
    bold = bold_weight >= total * 0.45
    italic = italic_weight >= total * 0.45
    if bold and italic:
        return "boldItalic"
    if bold:
        return "bold"
    if italic:
        return "italic"
    return "regular"


def prepare_group(group: dict[str, Any]) -> dict[str, Any]:
    """Separate an inline colored step number from its caption text."""

    lines = group["lines"]
    group["bodyText"] = " ".join(item["text"] for item in lines).strip()
    group["bodyRect"] = fitz.Rect(group["rect"])
    group["bodySpans"] = list(group["spans"])
    group["numberPrefix"] = ""
    group["numberRect"] = None
    group["numberSpans"] = []
    group["isHeading"] = group["rect"].y0 < 150
    if not lines:
        return group

    first_text = lines[0]["text"]
    prefix = re.match(r"^(\d+)(?:\s+)(.+)$", first_text)
    first_spans = lines[0].get("spans", [])
    numeric_span = first_spans[0] if first_spans and re.fullmatch(r"\d+", str(first_spans[0].get("text", "")).strip()) else None
    if not prefix or numeric_span is None:
        return group

    group["numberPrefix"] = prefix.group(1)
    group["numberRect"] = fitz.Rect(numeric_span.get("bbox", group["rect"]))
    group["numberSpans"] = [numeric_span]
    body_lines = [prefix.group(2), *[item["text"] for item in lines[1:]]]
    group["bodyText"] = " ".join(body_lines).strip()
    body_spans = [span for span in group["spans"] if span is not numeric_span and str(span.get("text", "")).strip()]
    group["bodySpans"] = body_spans
    body_rect = None
    for span in body_spans:
        span_rect = fitz.Rect(span.get("bbox", group["rect"]))
        body_rect = span_rect if body_rect is None else body_rect | span_rect
    group["bodyRect"] = body_rect or fitz.Rect(group["rect"])
    return group


def source_color(group: dict[str, Any]) -> tuple[float, float, float]:
    colors = [int(span.get("color", 0) or 0) for span in group["spans"]]
    if not colors:
        return (0.0, 0.0, 0.0)
    # Use the most frequent source color.  The PDF stores colors as 0xRRGGBB.
    color = max(set(colors), key=colors.count)
    return tuple(((color >> shift) & 255) / 255 for shift in (16, 8, 0))


def source_background(page: fitz.Page, rect: fitz.Rect) -> tuple[float, float, float]:
    """Find a suitable fill for a small text redaction."""

    center = fitz.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)
    try:
        for drawing in page.get_drawings():
            fill = drawing.get("fill")
            drawing_rect = drawing.get("rect")
            if fill and drawing_rect and fitz.Rect(drawing_rect).contains(center):
                return tuple(round(max(0.0, min(1.0, float(value))), 3) for value in fill[:3])
    except Exception:
        pass

    # Most captions are on a white canvas.  Sample a narrow border as a
    # fallback so colored/photo-backed areas do not become arbitrary white
    # rectangles when there is no vector fill to inspect.
    try:
        clip = fitz.Rect(rect.x0 - 2, rect.y0 - 2, rect.x1 + 2, rect.y1 + 2)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=clip, colorspace=fitz.csRGB, alpha=False)
        samples: list[tuple[int, int, int]] = []
        for x in range(0, pixmap.width, max(1, pixmap.width // 8)):
            samples.append(pixmap.pixel(x, 0))
            samples.append(pixmap.pixel(x, max(0, pixmap.height - 1)))
        for y in range(0, pixmap.height, max(1, pixmap.height // 8)):
            samples.append(pixmap.pixel(0, y))
            samples.append(pixmap.pixel(max(0, pixmap.width - 1), y))
        if samples:
            return tuple(round(statistics.median(sample[channel] for sample in samples) / 255, 3) for channel in range(3))
    except Exception:
        pass
    return (1.0, 1.0, 1.0)


def font_paths(document: fitz.Document, temporary_directory: Path) -> dict[str, Any]:
    windows = Path(r"C:\Windows\Fonts")
    names = {"regular": "arial.ttf", "italic": "ariali.ttf", "bold": "arialbd.ttf", "boldItalic": "arialbi.ttf"}
    paths: dict[str, Any] = {key: str(windows / name) if (windows / name).exists() else "" for key, name in names.items()}
    embedded: dict[str, str] = {}
    for page in document:
        for font_info in page.get_fonts(full=True):
            try:
                extracted_name, extension, _font_type, content = document.extract_font(int(font_info[0]))
            except Exception:
                continue
            if not content or extension.lower() not in {"ttf", "otf"}:
                continue
            clean_name = str(extracted_name).split("+", 1)[-1]
            key = clean_name.lower()
            if key in embedded:
                continue
            font_path = temporary_directory / f"{len(embedded)}.{extension.lower()}"
            font_path.write_bytes(content)
            embedded[key] = str(font_path)
    paths["embedded"] = embedded
    return paths


def style_for(group: dict[str, Any]) -> dict[str, Any]:
    spans = group["spans"]
    if not spans:
        return {"size": 8.0, "font": "regular", "color": (0.0, 0.0, 0.0)}
    font_weights = Counter(str(span.get("font", "")).split("+", 1)[-1] for span in spans)
    source_font = font_weights.most_common(1)[0][0] if font_weights else ""
    font_kind = font_kind_for_spans(spans)
    sizes = [float(span.get("size", 8.0) or 8.0) for span in spans]
    size = max(sizes)
    return {"size": size, "font": font_kind, "color": source_color(group), "sourceFont": source_font}


def assign_render_rects(page: fitz.Page, groups: list[dict[str, Any]]) -> None:
    """Allow natural English reflow only into demonstrably safe page space."""

    image_rects: list[fitz.Rect] = []
    for image in page.get_images(full=True):
        image_rects.extend(fitz.Rect(rect) for rect in page.get_image_rects(image[0]))
    for group in groups:
        source_rect = fitz.Rect(group.get("bodyRect", group["rect"]))
        safe_bottom = page.rect.y1 - 4
        for candidate in groups:
            if candidate is group:
                continue
            candidate_rect = fitz.Rect(candidate.get("bodyRect", candidate["rect"]))
            horizontal_overlap = max(0.0, min(source_rect.x1, candidate_rect.x1) - max(source_rect.x0, candidate_rect.x0))
            same_column = candidate.get("column") == group.get("column")
            is_footer_boundary = candidate_rect.y0 > page.rect.y1 - 70
            if candidate_rect.y0 > source_rect.y1 + 0.5 and horizontal_overlap >= 4 and (same_column or is_footer_boundary):
                safe_bottom = min(safe_bottom, candidate_rect.y0 - 1.5)
        for image_rect in image_rects:
            horizontal_overlap = max(0.0, min(source_rect.x1, image_rect.x1) - max(source_rect.x0, image_rect.x0))
            if image_rect.y0 > source_rect.y1 - 1 and horizontal_overlap >= 4:
                safe_bottom = min(safe_bottom, image_rect.y0 - 1.5)
        # Colored callout / table containers are also hard boundaries.
        try:
            center = fitz.Point((source_rect.x0 + source_rect.x1) / 2, (source_rect.y0 + source_rect.y1) / 2)
            containers = [
                fitz.Rect(drawing["rect"])
                for drawing in page.get_drawings()
                if drawing.get("fill") and drawing.get("rect") and fitz.Rect(drawing["rect"]).contains(center)
                and fitz.Rect(drawing["rect"]).get_area() < page.rect.get_area() * 0.8
            ]
            if containers:
                safe_bottom = min(safe_bottom, min(rect.y1 for rect in containers) - 1.5)
        except Exception:
            pass
        group["renderRect"] = fitz.Rect(source_rect.x0, source_rect.y0, source_rect.x1, max(source_rect.y1, safe_bottom))


def fit_box(page: fitz.Page, available_rect: fitz.Rect, text: str, spans: list[dict[str, Any]], fonts: dict[str, Any]) -> dict[str, Any]:
    draw_rect = fitz.Rect(available_rect.x0 + 0.2, available_rect.y0 + 0.2, available_rect.x1 - 0.2, available_rect.y1 - 0.2)
    style = style_for({"spans": spans})
    # The source PDF embeds subset fonts whose glyph maps do not reliably
    # contain the English output alphabet; use Windows fallback fonts.
    fontfile = fonts.get(style["font"], "")
    font_name = {"regular": "Arial", "italic": "ArialI", "bold": "ArialB", "boldItalic": "ArialBI"}[style["font"]]
    original_size = max(5.0, style["size"])
    sizes = [original_size, original_size * 0.94, original_size * 0.88, original_size * 0.82, original_size * 0.76, original_size * 0.70, original_size * 0.64, original_size * 0.58, original_size * 0.52, 4.8]

    probe = fitz.open()
    probe_page = probe.new_page(width=page.rect.width, height=page.rect.height)
    chosen = sizes[-1]
    for size in sizes:
        result = probe_page.insert_textbox(draw_rect, text, fontname=font_name, fontfile=fontfile or None, fontsize=size, color=style["color"], align=fitz.TEXT_ALIGN_LEFT)
        if result >= 0:
            chosen = size
            break
        probe.close()
        probe = fitz.open()
        probe_page = probe.new_page(width=page.rect.width, height=page.rect.height)
    probe.close()
    result = page.insert_textbox(draw_rect, text, fontname=font_name, fontfile=fontfile or None, fontsize=chosen, color=style["color"], align=fitz.TEXT_ALIGN_LEFT, overlay=True)
    return {
        "rect": [round(value, 2) for value in available_rect],
        "sourceSize": round(original_size, 2),
        "outputSize": round(chosen, 2),
        "fitResult": round(result, 2),
        "font": style["font"],
        "color": [round(value, 3) for value in style["color"]],
        "text": text,
    }


def insert_fitted(page: fitz.Page, group: dict[str, Any], translated: str, fonts: dict[str, Any]) -> dict[str, Any]:
    parts: list[dict[str, Any]] = []
    if group.get("numberPrefix") and group.get("numberRect") is not None:
        parts.append(fit_box(page, fitz.Rect(group["numberRect"]), group["numberPrefix"], group["numberSpans"], fonts))
        parts.append(fit_box(page, fitz.Rect(group["renderRect"]), translated, group["bodySpans"], fonts))
    else:
        parts.append(fit_box(page, fitz.Rect(group["renderRect"]), translated, group["spans"], fonts))
    return {
        "source": group["text"],
        "translation": translated,
        "rect": [round(value, 2) for value in group["rect"]],
        "sourceSize": round(max(part["sourceSize"] for part in parts), 2),
        "outputSize": round(min(part["outputSize"] for part in parts), 2),
        "fitResult": round(min(part["fitResult"] for part in parts), 2),
        "font": parts[-1]["font"],
        "parts": parts,
    }


def pixmap_point(pixmap: fitz.Pixmap, page: fitz.Page, x: float, y: float) -> tuple[int, int, int]:
    px = max(0, min(pixmap.width - 1, round((x - page.rect.x0) * pixmap.width / page.rect.width)))
    py = max(0, min(pixmap.height - 1, round((y - page.rect.y0) * pixmap.height / page.rect.height)))
    return tuple(int(value) for value in pixmap.pixel(px, py))


def capture_border(pixmap: fitz.Pixmap, page: fitz.Page, rect: fitz.Rect) -> list[tuple[int, int, int]]:
    samples: list[tuple[int, int, int]] = []
    for ratio in (0.15, 0.35, 0.55, 0.75, 0.9):
        samples.append(pixmap_point(pixmap, page, rect.x0 - 2, rect.y0 + rect.height * ratio))
        samples.append(pixmap_point(pixmap, page, rect.x1 + 2, rect.y0 + rect.height * ratio))
        samples.append(pixmap_point(pixmap, page, rect.x0 + rect.width * ratio, rect.y0 - 2))
        samples.append(pixmap_point(pixmap, page, rect.x0 + rect.width * ratio, rect.y1 + 2))
    return samples


def visual_capture_check(page: fitz.Page, source_capture: fitz.Pixmap, group: dict[str, Any], placement: dict[str, Any], before_assets: tuple[int, int]) -> dict[str, Any]:
    result_capture = page.get_pixmap(matrix=fitz.Matrix(1, 1), colorspace=fitz.csRGB, alpha=False)
    source_border = capture_border(source_capture, page, fitz.Rect(group["rect"]))
    result_border = capture_border(result_capture, page, fitz.Rect(group["rect"]))
    background_delta = round(sum(sum(abs(a - b) for a, b in zip(left, right)) / 3 for left, right in zip(source_border, result_border)) / max(1, len(source_border)), 2)
    expected_colors = {tuple(round(value * 255) for value in part.get("color", (0, 0, 0))) for part in placement["parts"]}
    observed_colors: set[int] = set()
    clipped = False
    for span in [span for block in page.get_text("dict", clip=fitz.Rect(group["renderRect"])).get("blocks", []) if block.get("type") == 0 for line in block.get("lines", []) for span in line.get("spans", []) if span.get("text", "").strip()]:
        observed_colors.add(int(span.get("color", 0) or 0))
    for part in placement["parts"]:
        if part["fitResult"] < 0:
            clipped = True
    after_assets = (len(page.get_images(full=True)), len(page.get_drawings()))
    semantic_pass = bool(placement["translation"].strip())
    color_pass = any(abs(((color >> 16) & 255) - expected[0]) <= 1 and abs(((color >> 8) & 255) - expected[1]) <= 1 and abs((color & 255) - expected[2]) <= 1 for color in observed_colors for expected in expected_colors)
    background_threshold = 50
    return {
        "engine": "deterministic-textbox-visual-capture",
        "status": "pass" if semantic_pass and color_pass and not clipped and before_assets == after_assets and background_delta <= background_threshold else "warning",
        "semantic": {"status": "pass" if semantic_pass else "warning", "translatedTextPresent": semantic_pass},
        "color": {"status": "pass" if color_pass else "warning", "expected": sorted(expected_colors), "observed": sorted(observed_colors)},
        "layout": {"status": "pass" if not clipped else "warning", "fitResults": [part["fitResult"] for part in placement["parts"]], "renderRect": [round(value, 2) for value in group["renderRect"]]},
        "background": {"status": "pass" if background_delta <= background_threshold else "warning", "borderMeanDelta": background_delta, "threshold": background_threshold},
        "pagePreservation": {"status": "pass" if before_assets == after_assets else "warning", "before": before_assets, "after": after_assets},
    }


def translate_pdf(source: Path, output: Path, report_path: Path) -> None:
    document = fitz.open(source)
    pages: list[dict[str, Any]] = []
    all_groups: list[dict[str, Any]] = []
    for page_index, page in enumerate(document):
        groups = line_groups(page)
        for group in groups:
            prepare_group(group)
            group["pageIndex"] = page_index
        assign_render_rects(page, groups)
        pages.append({"page": page, "groups": groups})
        all_groups.extend(groups)

    translation_requests: list[tuple[dict[str, Any], str]] = []
    for group in all_groups:
        if group.get("isHeading") and len(group["lines"]) > 1:
            units = [item["text"] for item in group["lines"]]
            group["translationJoiner"] = "\n"
            group["translationUnitMode"] = "heading-line"
        else:
            units = sentence_units(group.get("bodyText", group["text"]))
            group["translationJoiner"] = " "
            group["translationUnitMode"] = "sentence"
        group["sentenceUnits"] = units
        if re.fullmatch(r"[\d\s]+", group.get("bodyText", group["text"])):
            group["translation"] = group.get("bodyText", group["text"])
            continue
        translation_requests.extend((group, unit) for unit in units)
    translated_values = iter(azure_translate([unit for _group, unit in translation_requests], source_language="es", target_language="en")) if translation_requests else iter(())
    translated_by_group: dict[int, list[str]] = {id(group): [] for group in all_groups}
    for group, _unit in translation_requests:
        translated_by_group[id(group)].append(next(translated_values))
    for group in all_groups:
        if id(group) in translated_by_group and translated_by_group[id(group)]:
            group["translation"] = group["translationJoiner"].join(translated_by_group[id(group)])
        group["translatedSentenceUnits"] = translated_by_group.get(id(group), [group.get("translation", "")])

    page_stats: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="pdf-fonts-") as temporary_directory:
        fonts = font_paths(document, Path(temporary_directory))
        for page_index, page_data in enumerate(pages):
            page = page_data["page"]
            groups = page_data["groups"]
            source_capture = page.get_pixmap(matrix=fitz.Matrix(1, 1), colorspace=fitz.csRGB, alpha=False)
            for group in groups:
                rect = fitz.Rect(group["rect"])
                padded = fitz.Rect(rect.x0 - 0.65, rect.y0 - 0.65, rect.x1 + 0.65, rect.y1 + 0.65)
                # A transparent redaction preserves the page's underlying vector
                # background (including the yellow/blue callouts and diagonal
                # canvas) instead of painting a visible rectangle over it.
                page.add_redact_annot(padded, fill=None)
            page.apply_redactions(images=0, graphics=0, text=0)

            before_assets = (len(page.get_images(full=True)), len(page.get_drawings()))
            placements: list[dict[str, Any]] = []
            capture_checks: list[dict[str, Any]] = []
            for group in groups:
                placement = insert_fitted(page, group, group["translation"], fonts)
                placement["captureCheck"] = visual_capture_check(page, source_capture, group, placement, before_assets)
                placements.append(placement)
                capture_checks.append(placement["captureCheck"])
            page_stats.append({
                "page": page_index + 1,
                "sourceGroups": len(groups),
                "placements": len(placements),
                "shrunkGroups": sum(1 for placement in placements if placement["outputSize"] < placement["sourceSize"] - 0.01),
                "minimumOutputSize": round(min((placement["outputSize"] for placement in placements), default=0), 2),
                "captureChecks": capture_checks,
                "captureWarnings": sum(1 for check in capture_checks if check["status"] != "pass"),
                "placementsDetail": placements,
            })

    output.parent.mkdir(parents=True, exist_ok=True)
    document.set_metadata({**document.metadata, "title": "Technical Bulletin - Tire Puncture Repair Procedure (English)"})
    document.save(output, garbage=4, deflate=True)
    report = {
        "source": str(source),
        "output": str(output),
        "sourceLanguage": "es",
        "targetLanguage": "en",
        "translationProvider": "azure-text-translation",
        "strategy": "preserve_artwork + sentence_units + adaptive_safe_region_fit + per_textbox_visual_capture",
        "pageCount": len(document),
        "translatedGroups": len(translation_requests),
        "sentenceUnitCount": len(translation_requests),
        "pageStats": page_stats,
        "finalGate": {"status": "pass" if all(item["placements"] == item["sourceGroups"] and item["captureWarnings"] == 0 for item in page_stats) else "warning", "textOverflow": [], "captureWarnings": sum(item["captureWarnings"] for item in page_stats)},
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "pageStats"}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    translate_pdf(args.source, args.output, args.report)


if __name__ == "__main__":
    main()
