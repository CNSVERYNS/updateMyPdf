"""Translate a PDF's logical text and redraw it using the visual-repair layout."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import fitz


REPAIR_PATH = Path(__file__).with_name("repair-booking-pdf.py")
spec = importlib.util.spec_from_file_location("repair_booking", REPAIR_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError("Could not load repair-booking-pdf.py")
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


FONT_SIZE = repair.BODY_FONT_SIZE
LINE_HEIGHT = repair.LINE_HEIGHT
PARAGRAPH_GAP = repair.PARAGRAPH_GAP


def logical_items(lines: list[str]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    current: dict[str, str] | None = None

    def flush() -> None:
        nonlocal current
        if current and current.get("text", "").strip():
            current["text"] = re.sub(r"\s+", " ", current["text"]).strip()
            items.append(current)
        current = None

    for line in lines:
        if not line:
            continue
        if repair.is_heading(line):
            flush()
            items.append({"kind": "heading" if not re.match(r"^\d+\.\s", line) else "section", "text": line})
            current = None
        elif line in {"Se prohíbe", "Se prohíbe crear", "Se prohíbe usar", "Toda vez que sea posible, deben seguirse las mejores prácticas:"}:
            flush()
            current = {"kind": "label", "text": line}
        elif re.match(r"^[a-d]\.\s", line):
            flush()
            current = {"kind": "alpha", "text": line}
            flush()
        elif line.startswith("■ "):
            flush()
            current = {"kind": "best", "text": line[2:].strip()}
        elif line.startswith(("- ", "• ")):
            flush()
            current = {"kind": "bullet" if line.startswith("- ") else "dot", "text": line[2:].strip()}
        elif current:
            current["text"] += f" {line}"
        else:
            current = {"kind": "paragraph", "text": line}
    flush()
    return items


def azure_translate(texts: list[str], source_language: str = "es", target_language: str = "tr") -> list[str]:
    endpoint = os.environ.get("AZURE_TRANSLATOR_ENDPOINT", "").rstrip("/")
    key = os.environ.get("AZURE_TRANSLATOR_KEY", "")
    if not endpoint or not key:
        raise RuntimeError("AZURE_TRANSLATOR_ENDPOINT and AZURE_TRANSLATOR_KEY are required")
    values: list[str] = []
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
            translations = item.get("translations") or []
            values.append(str(translations[0].get("text", "")) if translations else "")
    if len(values) != len(texts) or any(not value.strip() for value in values):
        raise RuntimeError("Azure returned an incomplete translation batch")
    return values


def wrap(font: fitz.Font, text: str, max_width: float, size: float) -> list[str]:
    return repair.wrap_line(font, text, max_width, size)


def prepare_layout(items: list[dict[str, str]], x0: float, x1: float, y0: float, y1: float, regular: str, bold_italic: str) -> tuple[float, list[dict[str, Any]], float]:
    regular_font = fitz.Font(fontfile=regular or None)
    bold_font = fitz.Font(fontfile=bold_italic or None)
    for size in (8.04, 7.8, 7.55, 7.3, 7.05, 6.8):
        height = size * (LINE_HEIGHT / FONT_SIZE)
        y = y0 + size
        placements: list[dict[str, Any]] = []
        for item in items:
            kind = item["kind"]
            if kind in {"heading", "section"}:
                x = x0
                font = bold_font
                gap = 0.0
            elif kind in {"bullet", "dot"}:
                x = x0 + 8
                font = regular_font
                gap = 0.0
            elif kind == "best":
                x = x0 + 16
                font = regular_font
                gap = 0.0
            elif kind == "alpha":
                x = x0 + 8
                font = regular_font
                gap = 0.0
            else:
                x = x0
                font = regular_font
                gap = 0.0
            lines = wrap(font, item["text"], x1 - x, size)
            placements.append({"item": item, "x": x, "lines": lines, "size": size, "height": height})
            y += len(lines) * height + (PARAGRAPH_GAP if kind in {"heading", "section", "label", "alpha"} else gap)
            if y > y1 + 1:
                break
        if y <= y1 + 1:
            return size, placements, y
    raise RuntimeError(f"Translated column overflows at y={y:.1f} (limit {y1})")


def draw_translated_column(page: fitz.Page, rect: tuple[float, float, float, float], items: list[dict[str, str]], regular: str, bold_italic: str) -> dict[str, Any]:
    x0, y0, x1, y1 = rect
    size, placements, bottom = prepare_layout(items, x0, x1, y0, y1, regular, bold_italic)
    regular_font = fitz.Font(fontfile=regular or None)
    bold_font = fitz.Font(fontfile=bold_italic or None)
    y = y0 + size
    for placement in placements:
        item = placement["item"]
        kind = item["kind"]
        lines = placement["lines"]
        if kind in {"heading", "section"}:
            x = x0
            font_path = bold_italic
            font = bold_font
        elif kind in {"bullet", "dot"}:
            x = x0 + 8
            font_path = regular
            font = regular_font
            repair.draw_marker(page, "•" if kind == "dot" else "-", x0, y)
        elif kind == "best":
            x = x0 + 16
            font_path = regular
            font = regular_font
            repair.draw_marker(page, "■", x0 + 8, y)
        elif kind == "alpha":
            x = x0 + 8
            font_path = regular
            font = regular_font
        else:
            x = x0
            font_path = regular
            font = regular_font
        for line in lines:
            repair.draw_text(page, (x, y), line, font_path, size)
            if kind in {"heading", "section"}:
                width = font.text_length(line, fontsize=size)
                page.draw_line((x, y + 1.4), (x + width, y + 1.4), color=repair.BLACK, width=0.35, overlay=True)
            y += size * (LINE_HEIGHT / FONT_SIZE)
        if kind in {"heading", "section", "label", "alpha"}:
            y += PARAGRAPH_GAP
    return {"fontSize": size, "drawnItems": len(items), "bottom": round(y, 2), "availableBottom": y1}


def translate_and_repair(source: Path, output: Path, report_path: Path) -> None:
    document = fitz.open(source)
    if len(document) != 1:
        raise RuntimeError("This fixture currently expects a one-page PDF")
    source_page = document[0]
    columns = {name: logical_items(repair.clean_lines(text)) for name, text in repair.source_blocks(source_page).items()}
    all_items = [item for items in columns.values() for item in items]
    translated = azure_translate([item["text"] for item in all_items])
    for item, value in zip(all_items, translated):
        item["text"] = value

    header = azure_translate(["Reservaciones – Políticas y pautas"])[0]
    footer = azure_translate(["Consulte las políticas específicas sobre reservaciones, cumplimiento y cargos en el sitio web de las compañías aéreas individuales"])[0]

    for rect in (
        fitz.Rect(35.5, 30, 300, 50),
        fitz.Rect(35.5, 60, 273.8, repair.BODY_BOTTOM),
        fitz.Rect(274.8, 60, 517.2, repair.BODY_BOTTOM),
        fitz.Rect(518.8, 60, 756.5, repair.BODY_BOTTOM),
        fitz.Rect(35.5, 563, 756.5, 579),
    ):
        source_page.add_redact_annot(rect, fill=repair.WHITE)
    source_page.apply_redactions()
    source_page.draw_line((274.25, 68.2), (274.25, 549.35), color=repair.BLACK, width=0.5, overlay=True)
    source_page.draw_line((517.87, 68.2), (517.87, 549.35), color=repair.BLACK, width=0.5, overlay=True)

    regular, bold_italic, bold = repair.font_paths()
    stats = {
        "left": draw_translated_column(source_page, (36, 68.2, 269.8, 548.5), columns["left"], regular, bold_italic),
        "middle": draw_translated_column(source_page, (279.6, 68.2, 513.0, 548.5), columns["middle"], regular, bold_italic),
        "right": draw_translated_column(source_page, (523.3, 68.2, 757.0, 548.5), columns["right"], regular, bold_italic),
    }
    repair.draw_text(source_page, (36, 48), header, bold_italic, 14.04)
    repair.draw_text(source_page, (163, 575.5), footer, regular, 8.04)
    repair.draw_text(source_page, (700, 575.5), "Ekim 2012", regular, 8.04)

    output.parent.mkdir(parents=True, exist_ok=True)
    document.set_metadata({**document.metadata, "title": "Reservasyonlar – Politikalar ve yönergeler (Türkçe)"})
    document.save(output, garbage=4, deflate=True)
    report = {
        "source": str(source),
        "output": str(output),
        "sourceLanguage": "es",
        "targetLanguage": "tr",
        "translationProvider": "azure-text-translation",
        "strategy": "visual-profile + reflow_text_columns",
        "pageCount": 1,
        "translatedItems": len(all_items) + 2,
        "columns": stats,
        "finalGate": {"status": "pass" if all(value["bottom"] <= value["availableBottom"] for value in stats.values()) else "warning", "textOverflow": [name for name, value in stats.items() if value["bottom"] > value["availableBottom"]]},
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    translate_and_repair(args.source, args.output, args.report)


if __name__ == "__main__":
    main()
