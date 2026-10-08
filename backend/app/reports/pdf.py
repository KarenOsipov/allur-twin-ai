from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.lineplots import LinePlot
from reportlab.graphics.shapes import Drawing, Line, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (
    BaseDocTemplate,
    CondPageBreak,
    Flowable,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    TableStyle,
)
from reportlab.platypus import Table as RLTable

ASSETS = Path(__file__).resolve().parent / "assets"
COMPANY = "АО «Группа компаний АЛЛЮР»"
PLANT = "Сборочный завод, г. Костанай"
SYSTEM = "Цифровой двойник производства"

ALLUR = colors.HexColor("#FF3324")
BRAND = colors.HexColor("#E3241B")
ACCENT = colors.HexColor("#B4231B")
INK = colors.HexColor("#1D1515")
INK2 = colors.HexColor("#4B3F3E")
INK3 = colors.HexColor("#7D6E6C")
LINE = colors.HexColor("#E8DCDA")
SUNKEN = colors.HexColor("#FAF4F3")
SOFT = colors.HexColor("#FFE9E6")
OK = colors.HexColor("#17A05D")
OK_SOFT = colors.HexColor("#E2F5EA")
WARN = colors.HexColor("#B07F00")
WARN_SOFT = colors.HexColor("#FCF3D9")
BAD = colors.HexColor("#D42F2F")
BAD_SOFT = colors.HexColor("#FDE8E8")
TONE = {"ok": OK, "warn": WARN, "bad": BAD, "info": INK3, None: INK3}
TONE_SOFT = {"ok": OK_SOFT, "warn": WARN_SOFT, "bad": BAD_SOFT, "info": SUNKEN, None: SUNKEN}

PAGE_W, PAGE_H = A4
MARGIN_X = 18 * mm
CONTENT_W = PAGE_W - 2 * MARGIN_X


_FONTS_READY = False


def _fonts() -> None:
    global _FONTS_READY
    if _FONTS_READY:
        return
    for name, file in (
        ("Manrope", "Manrope_400Regular.ttf"),
        ("Manrope-Medium", "Manrope_500Medium.ttf"),
        ("Manrope-SemiBold", "Manrope_600SemiBold.ttf"),
        ("Manrope-Bold", "Manrope_700Bold.ttf"),
        ("Outfit-Light", "Outfit_300Light.ttf"),
        ("Outfit-Medium", "Outfit_500Medium.ttf"),
        ("Symbols", "Symbols.ttf"),
    ):
        pdfmetrics.registerFont(TTFont(name, str(ASSETS / file)))
    pdfmetrics.registerFontFamily(
        "Manrope", normal="Manrope", bold="Manrope-SemiBold", italic="Manrope", boldItalic="Manrope-SemiBold"
    )
    _FONTS_READY = True


def _style(name: str, **kw) -> ParagraphStyle:
    base = {"fontName": "Manrope", "fontSize": 9.5, "leading": 13.5, "textColor": INK}
    base.update(kw)
    return ParagraphStyle(name, **base)


_DIGITS = re.compile(r"^[\d\s.,+\-−–%/×:]+$")


@dataclass
class Kpi:
    label: str
    value: str
    note: str = ""
    tone: str | None = None


@dataclass
class Kpis:
    items: list[Kpi]
    per_row: int = 4


@dataclass
class Heading:
    text: str
    hint: str = ""


@dataclass
class Text:
    text: str
    muted: bool = False


@dataclass
class Bullets:
    items: list[str]


@dataclass
class Callout:
    title: str
    text: str
    tone: str = "info"


@dataclass
class Steps:
    items: list[tuple[str, str, str]]


@dataclass
class Table:
    columns: list[str]
    rows: list[list]
    widths: list[float] | None = None
    align: list[str] | None = None
    tones: list[str | None] | None = None
    max_rows: int = 400
    note: str = ""


@dataclass
class Chart:
    kind: str
    labels: list[str]
    series: list[tuple[str, list[float]]]
    target: float | None = None
    target_label: str = ""
    unit: str = ""
    height_mm: float = 58


@dataclass
class Pairs:
    items: list[tuple[str, str]]


@dataclass
class Section:
    number: int
    title: str
    hint: str = ""


@dataclass
class Doc:
    title: str
    subtitle: str
    code: str
    author: str
    position: str
    blocks: list = field(default_factory=list)
    meta: list[tuple[str, str]] = field(default_factory=list)
    created: datetime | None = None
    signatures: list[tuple[str, str]] | None = None
    confidential: bool = True

    @property
    def number(self) -> str:
        c = self.created or datetime.now()
        return f"{self.code}-{c:%Y%m%d-%H%M}"


def _logo_paths() -> list[list[tuple[float, float]]]:
    svg = (Path(__file__).resolve().parent / "assets" / "allur.svg").read_text()
    d = re.search(r'd="([^"]+)"', svg).group(1)
    paths: list[list[tuple[float, float]]] = []
    for chunk in re.split(r"[Mm]", d):
        chunk = chunk.replace("Z", " ").replace("z", " ").strip()
        if not chunk:
            continue
        nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", chunk)]
        paths.append(list(zip(nums[0::2], nums[1::2], strict=False)))
    return paths


_LOGO: list[list[tuple[float, float]]] | None = None
LOGO_VIEW = (321.5, 111.1)


def draw_logo(c: rl_canvas.Canvas, x: float, y: float, width: float) -> float:
    global _LOGO
    if _LOGO is None:
        _LOGO = _logo_paths()
    k = width / LOGO_VIEW[0]
    h = LOGO_VIEW[1] * k
    p = c.beginPath()
    for poly in _LOGO:
        x0, y0 = poly[0]
        p.moveTo(x + x0 * k, y + h - y0 * k)
        for px, py in poly[1:]:
            p.lineTo(x + px * k, y + h - py * k)
        p.close()
    c.saveState()
    c.setFillColor(ALLUR)
    c.drawPath(p, stroke=0, fill=1, fillMode=0)
    c.restoreState()
    return h


class _NumberedCanvas(rl_canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved: list[dict] = []

    def showPage(self):
        self._saved.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved)
        for state in self._saved:
            self.__dict__.update(state)
            self._footer_pages(total)
            super().showPage()
        super().save()

    def _footer_pages(self, total: int) -> None:
        self.setFont("Manrope", 7.5)
        self.setFillColor(INK3)
        self.drawRightString(PAGE_W - MARGIN_X, 11 * mm, f"Стр. {self._pageNumber} из {total}")


def _decor(doc: Doc):
    def first(c: rl_canvas.Canvas, _d) -> None:
        c.saveState()
        top = PAGE_H - 16 * mm
        h = draw_logo(c, MARGIN_X, top - 11 * mm, 32 * mm)
        c.setFont("Manrope-SemiBold", 9)
        c.setFillColor(INK)
        c.drawRightString(PAGE_W - MARGIN_X, top - 2.5 * mm, COMPANY)
        c.setFont("Manrope", 8)
        c.setFillColor(INK3)
        c.drawRightString(PAGE_W - MARGIN_X, top - 6.6 * mm, PLANT)
        c.drawRightString(PAGE_W - MARGIN_X, top - 10.4 * mm, SYSTEM)
        y = top - 11 * mm - 4.5 * mm
        c.setStrokeColor(BRAND)
        c.setLineWidth(1.4)
        c.line(MARGIN_X, y, MARGIN_X + 34 * mm, y)
        c.setStrokeColor(LINE)
        c.setLineWidth(0.6)
        c.line(MARGIN_X + 34 * mm, y, PAGE_W - MARGIN_X, y)
        _ = h
        _footer(c, doc)
        c.restoreState()

    def later(c: rl_canvas.Canvas, _d) -> None:
        c.saveState()
        top = PAGE_H - 12 * mm
        draw_logo(c, MARGIN_X, top - 5.5 * mm, 16 * mm)
        c.setFont("Manrope-Medium", 8)
        c.setFillColor(INK2)
        c.drawRightString(PAGE_W - MARGIN_X, top - 3.6 * mm, f"{doc.title} · № {doc.number}")
        c.setStrokeColor(LINE)
        c.setLineWidth(0.6)
        c.line(MARGIN_X, top - 8 * mm, PAGE_W - MARGIN_X, top - 8 * mm)
        _footer(c, doc)
        c.restoreState()

    return first, later


def _footer(c: rl_canvas.Canvas, doc: Doc) -> None:
    c.setStrokeColor(LINE)
    c.setLineWidth(0.6)
    c.line(MARGIN_X, 15 * mm, PAGE_W - MARGIN_X, 15 * mm)
    c.setFont("Manrope", 7.5)
    c.setFillColor(INK3)
    left = f"{COMPANY} · № {doc.number}"
    if doc.confidential:
        left += " · для внутреннего пользования"
    c.drawString(MARGIN_X, 11 * mm, left)


def _md(text: str) -> str:
    t = escape(str(text))
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t).replace("\n", "<br/>")
    return _SYMBOLS.sub(r'<font name="Symbols">\g<0></font>', t)


_SYMBOLS = re.compile("[₸■]")


class _Rule(Flowable):
    def __init__(self, color=LINE, width: float = 0.6, space: float = 2) -> None:
        super().__init__()
        self.color, self.lw, self.space = color, width, space

    def wrap(self, aw, ah):
        self.aw = aw
        return aw, self.space * 2

    def draw(self):
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(self.lw)
        self.canv.line(0, self.space, self.aw, self.space)


def _title_block(doc: Doc) -> list:
    out: list = [
        Spacer(1, 2 * mm),
        Paragraph(_md(doc.title), _style("t", fontName="Manrope-SemiBold", fontSize=19, leading=23)),
        Spacer(1, 1.2 * mm),
        Paragraph(_md(doc.subtitle), _style("st", fontSize=10, leading=14, textColor=INK2)),
        Spacer(1, 4 * mm),
    ]
    created = doc.created or datetime.now()
    meta = [
        ("Документ №", doc.number),
        ("Сформирован", f"{created:%d.%m.%Y %H:%M}"),
        ("Подготовил", doc.author),
        ("Должность", doc.position),
        *doc.meta,
    ]
    if len(meta) % 2:
        meta.append(("", ""))
    lab = _style("ml", fontSize=7.5, leading=10, textColor=INK3)
    val = _style("mv", fontName="Manrope-Medium", fontSize=9, leading=12)
    rows = []
    for i in range(0, len(meta), 2):
        row = []
        for k, v in meta[i : i + 2]:
            row.append([Paragraph(_md(k), lab), Paragraph(_md(v), val)] if k else "")
        rows.append(row)
    t = RLTable(rows, colWidths=[CONTENT_W / 2] * 2)
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), SUNKEN),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4 * mm),
                ("TOPPADDING", (0, 0), (-1, -1), 2.2 * mm),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2 * mm),
                ("ROUNDEDCORNERS", [8, 8, 8, 8]),
            ]
        )
    )
    out += [t, Spacer(1, 6 * mm)]
    return out


def _section(b: Section) -> list:
    items: list = [
        PageBreak(),
        Paragraph(f"{b.number:02d}", _style("sn", fontName="Outfit-Light", fontSize=30, leading=34, textColor=BRAND)),
        Spacer(1, 1 * mm),
        Paragraph(_md(b.title), _style("st2", fontName="Manrope-SemiBold", fontSize=20, leading=25)),
    ]
    if b.hint:
        items += [Spacer(1, 1.5 * mm), Paragraph(_md(b.hint), _style("sh", fontSize=9.5, leading=13.5, textColor=INK2))]
    items += [Spacer(1, 3 * mm), _Rule(BRAND, 1.6, 1), Spacer(1, 4 * mm)]
    return items


def _heading(b: Heading) -> list:
    items: list = [
        CondPageBreak(40 * mm),
        Spacer(1, 2.5 * mm),
        Paragraph(_md(b.text), _style("h", fontName="Manrope-SemiBold", fontSize=12.5, leading=16)),
    ]
    if b.hint:
        items += [Spacer(1, 0.8 * mm), Paragraph(_md(b.hint), _style("hh", fontSize=8.5, leading=12, textColor=INK3))]
    items.append(Spacer(1, 2.8 * mm))
    return items


def _kpis(b: Kpis) -> list:
    if not b.items:
        return []
    n = max(1, min(b.per_row, len(b.items)))
    gap = 3 * mm
    w = (CONTENT_W - gap * (n - 1)) / n
    lab = _style("kl", fontSize=7.8, leading=10.5, textColor=INK2)
    rows, row = [], []
    for k in b.items:
        big_font = "Outfit-Light" if _DIGITS.match(k.value) else "Manrope-Medium"
        size = 21 if big_font == "Outfit-Light" and len(k.value) <= 9 else 14
        cell = [
            Paragraph(_md(k.label), lab),
            Spacer(1, 1.5 * mm),
            Paragraph(_md(k.value), _style("kv", fontName=big_font, fontSize=size, leading=size * 1.12)),
        ]
        if k.note:
            cell += [
                Spacer(1, 1.2 * mm),
                Paragraph(_md(k.note), _style("kn", fontSize=7.5, leading=10, textColor=TONE.get(k.tone, INK3))),
            ]
        row.append(cell)
        if len(row) == n:
            rows.append(row)
            row = []
    if row:
        row += [""] * (n - len(row))
        rows.append(row)
    out: list = []
    for r in rows:
        cols, widths = [], []
        for i, cell in enumerate(r):
            cols.append(cell)
            widths.append(w)
            if i < n - 1:
                cols.append("")
                widths.append(gap)
        t = RLTable([cols], colWidths=widths)
        style = [
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 3.5 * mm),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3 * mm),
            ("TOPPADDING", (0, 0), (-1, -1), 3 * mm),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3.4 * mm),
        ]
        for i in range(0, len(cols), 2):
            if r[i // 2] != "":
                style.append(("BOX", (i, 0), (i, 0), 0.6, LINE))
                style.append(("BACKGROUND", (i, 0), (i, 0), colors.white))
        t.setStyle(TableStyle(style))
        out += [t, Spacer(1, gap)]
    return out


def _table(b: Table) -> list:
    if not b.rows:
        return [Paragraph("Записей нет.", _style("e", textColor=INK3)), Spacer(1, 3 * mm)]
    n = len(b.columns)
    fr = b.widths or [1 / n] * n
    total = sum(fr)
    widths = [CONTENT_W * f / total for f in fr]
    align = b.align or ["l"] + ["r"] * (n - 1)
    head = _style("th", fontName="Manrope-SemiBold", fontSize=7.8, leading=10, textColor=colors.white)
    cells = []
    styles = {}
    for a in set(align):
        al = {"l": TA_LEFT, "r": TA_RIGHT, "c": 1}[a]
        styles[a] = _style("td" + a, fontSize=8.2, leading=11, alignment=al)
        styles["h" + a] = ParagraphStyle("th" + a, parent=head, alignment=al)
    cells.append([Paragraph(_md(c), styles["h" + align[i]]) for i, c in enumerate(b.columns)])
    rows = b.rows[: b.max_rows]
    for r in rows:
        cells.append([Paragraph(_md(_fmt(v)), styles[align[i]]) for i, v in enumerate(r)])
    t = RLTable(cells, colWidths=widths, repeatRows=1)
    st = [
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.4 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.4 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 1.6 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.8 * mm),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, LINE),
    ]
    for i in range(1, len(cells)):
        if i % 2 == 0:
            st.append(("BACKGROUND", (0, i), (-1, i), SUNKEN))
    for i, tone in enumerate((b.tones or [])[: len(rows)], start=1):
        if tone:
            st.append(("BACKGROUND", (0, i), (-1, i), TONE_SOFT[tone]))
    t.setStyle(TableStyle(st))
    out: list = [t]
    note = b.note
    if len(b.rows) > b.max_rows:
        note = (
            note + " " if note else ""
        ) + f"Показаны первые {b.max_rows} из {len(b.rows)} строк; все — в Excel-выгрузке."
    if note:
        out += [Spacer(1, 1.5 * mm), Paragraph(_md(note), _style("tn", fontSize=7.5, leading=10, textColor=INK3))]
    out.append(Spacer(1, 4.5 * mm))
    return out


def _chart(b: Chart) -> list:
    h = b.height_mm * mm
    d = Drawing(CONTENT_W, h)
    palette = [ACCENT, colors.HexColor("#E8A49E"), INK3, OK]
    values_all = [v for _, vals in b.series for v in vals if v is not None]
    if b.target is not None:
        values_all.append(b.target)
    top = max(values_all or [1]) * 1.15 or 1
    if b.kind == "bar":
        ch = VerticalBarChart()
        ch.data = [[v or 0 for v in vals] for _, vals in b.series]
        ch.categoryAxis.categoryNames = b.labels
        ch.barSpacing = 1
        ch.groupSpacing = 6 if len(b.labels) < 20 else 2
        for i in range(len(b.series)):
            ch.bars[i].fillColor = palette[i % len(palette)]
            ch.bars[i].strokeColor = None
    else:
        ch = LinePlot()
        ch.data = [[(i, v) for i, v in enumerate(vals) if v is not None] for _, vals in b.series]
        for i in range(len(b.series)):
            ch.lines[i].strokeColor = palette[i % len(palette)]
            ch.lines[i].strokeWidth = 1.6
        ch.xValueAxis.valueMin = 0
        ch.xValueAxis.valueMax = max(len(b.labels) - 1, 1)
        step = max(1, len(b.labels) // 8)
        ch.xValueAxis.valueSteps = list(range(0, len(b.labels), step))
        ch.xValueAxis.labelTextFormat = lambda x: b.labels[int(x)] if 0 <= int(x) < len(b.labels) else ""
        ch.xValueAxis.labels.fontName = "Manrope"
        ch.xValueAxis.labels.fontSize = 6.8
        ch.xValueAxis.labels.fillColor = INK3
        ch.xValueAxis.strokeColor = LINE
    ch.x, ch.y = 11 * mm, 9 * mm
    ch.width, ch.height = CONTENT_W - 14 * mm, h - 16 * mm
    va = ch.valueAxis if b.kind == "bar" else ch.yValueAxis
    lo = min([0.0, *values_all]) if b.kind == "bar" else min(values_all or [0]) * 0.92
    va.valueMin = lo
    va.valueMax = top
    va.labels.fontName = "Manrope"
    va.labels.fontSize = 6.8
    va.labels.fillColor = INK3
    va.strokeColor = LINE
    va.visibleGrid = True
    va.gridStrokeColor = colors.HexColor("#F0E6E4")
    va.gridStrokeWidth = 0.4
    va.labelTextFormat = lambda v: _num(v)
    if b.kind == "bar":
        ca = ch.categoryAxis
        ca.labels.fontName = "Manrope"
        ca.labels.fontSize = 6.8 if len(b.labels) < 16 else 5.6
        ca.labels.fillColor = INK3
        ca.strokeColor = LINE
        if len(b.labels) > 16:
            ca.labels.angle = 45
            ca.labels.boxAnchor = "ne"
    d.add(ch)
    if b.target is not None and top > lo:
        y = ch.y + (b.target - lo) / (top - lo) * ch.height
        d.add(Line(ch.x, y, ch.x + ch.width, y, strokeColor=INK, strokeWidth=0.6, strokeDashArray=[2, 2]))
        d.add(
            String(
                ch.x + ch.width - 1,
                y + 2,
                b.target_label or _num(b.target),
                fontName="Manrope",
                fontSize=6.8,
                fillColor=INK,
                textAnchor="end",
            )
        )
    legend: list = []
    if len(b.series) > 1 or b.unit:
        parts = [
            f'<font name="Symbols" color="{palette[i % len(palette)].hexval().replace("0x", "#")}">■</font> {escape(n)}'
            for i, (n, _) in enumerate(b.series)
        ]
        if b.unit:
            parts.append(f'<font color="#7D6E6C">{escape(b.unit)}</font>')
        legend = [Paragraph("&nbsp;&nbsp;&nbsp;".join(parts), _style("lg", fontSize=7.5, leading=10, textColor=INK2))]
    return [KeepTogether([d, *legend]), Spacer(1, 4 * mm)]


def _callout(b: Callout) -> list:
    body = [
        Paragraph(
            _md(b.title),
            _style(
                "ct",
                fontName="Manrope-SemiBold",
                fontSize=9.5,
                leading=13,
                textColor=TONE.get(b.tone, INK) if b.tone != "info" else INK,
            ),
        ),
        Spacer(1, 1 * mm),
        Paragraph(_md(b.text), _style("cx", fontSize=8.8, leading=12.5, textColor=INK2)),
    ]
    t = RLTable([[body]], colWidths=[CONTENT_W])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), TONE_SOFT.get(b.tone, SUNKEN)),
                ("LINEBEFORE", (0, 0), (0, -1), 2.2, TONE.get(b.tone, INK3)),
                ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4 * mm),
                ("TOPPADDING", (0, 0), (-1, -1), 2.6 * mm),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3 * mm),
            ]
        )
    )
    return [t, Spacer(1, 3 * mm)]


def _steps(b: Steps) -> list:
    if not b.items:
        return []
    out: list = []
    num = _style("sn", fontName="Outfit-Medium", fontSize=12, leading=14, textColor=BRAND)
    for i, (title, text, effect) in enumerate(b.items, 1):
        body: list = [Paragraph(_md(title), _style("s1", fontName="Manrope-SemiBold", fontSize=9.5, leading=13))]
        if text:
            body += [Spacer(1, 0.8 * mm), Paragraph(_md(text), _style("s2", fontSize=8.6, leading=12, textColor=INK2))]
        if effect:
            body += [
                Spacer(1, 1 * mm),
                Paragraph(
                    _md(effect), _style("s3", fontName="Manrope-SemiBold", fontSize=8.6, leading=12, textColor=ACCENT)
                ),
            ]
        t = RLTable([[Paragraph(str(i), num), body]], colWidths=[9 * mm, CONTENT_W - 9 * mm])
        t.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("TOPPADDING", (0, 0), (-1, -1), 2 * mm),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 2.4 * mm),
                    ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
                ]
            )
        )
        out.append(KeepTogether([t]))
    out.append(Spacer(1, 3 * mm))
    return out


def _pairs(b: Pairs) -> list:
    if not b.items:
        return []
    lab = _style("pl", fontSize=8.6, leading=12, textColor=INK2)
    val = _style("pv", fontName="Manrope-Medium", fontSize=8.6, leading=12, alignment=TA_RIGHT)
    rows = [[Paragraph(_md(k), lab), Paragraph(_md(_fmt(v)), val)] for k, v in b.items]
    t = RLTable(rows, colWidths=[CONTENT_W * 0.62, CONTENT_W * 0.38])
    t.setStyle(
        TableStyle(
            [
                ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 1.5 * mm),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 1.7 * mm),
            ]
        )
    )
    return [t, Spacer(1, 4 * mm)]


def _signatures(doc: Doc) -> list:
    sig = doc.signatures or [
        (doc.position or "Составил", doc.author),
        ("Руководитель производства", ""),
    ]
    lab = _style("sg", fontSize=8.2, leading=11, textColor=INK3)
    val = _style("sv", fontName="Manrope-Medium", fontSize=9, leading=12)
    rows = []
    for role, name in sig:
        rows.append(
            [
                [Paragraph(_md(role), lab), Spacer(1, 1 * mm), Paragraph(_md(name or " "), val)],
                [Spacer(1, 6 * mm), _Rule(INK3, 0.5, 0), Paragraph("подпись", lab)],
                [Spacer(1, 6 * mm), _Rule(INK3, 0.5, 0), Paragraph("дата", lab)],
            ]
        )
    t = RLTable(rows, colWidths=[CONTENT_W * 0.46, CONTENT_W * 0.32, CONTENT_W * 0.22])
    t.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5 * mm),
                ("TOPPADDING", (0, 0), (-1, -1), 1.6 * mm),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 1.6 * mm),
            ]
        )
    )
    head = [
        Spacer(1, 2.5 * mm),
        Paragraph("Подписи", _style("h", fontName="Manrope-SemiBold", fontSize=12.5, leading=16)),
        Spacer(1, 2.8 * mm),
    ]
    return [Spacer(1, 3 * mm), KeepTogether([*head, t])]


def render(doc: Doc) -> bytes:
    _fonts()
    buf = io.BytesIO()
    first, later = _decor(doc)
    frame1 = Frame(
        MARGIN_X,
        20 * mm,
        CONTENT_W,
        PAGE_H - 20 * mm - 36 * mm,
        id="f1",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    frame2 = Frame(
        MARGIN_X,
        20 * mm,
        CONTENT_W,
        PAGE_H - 20 * mm - 26 * mm,
        id="f2",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    t = BaseDocTemplate(
        buf,
        pagesize=A4,
        title=f"{doc.title} — {COMPANY}",
        author=f"{doc.author}, {doc.position}",
        subject=doc.subtitle,
        creator=SYSTEM,
        leftMargin=MARGIN_X,
        rightMargin=MARGIN_X,
    )
    t.addPageTemplates(
        [
            PageTemplate(id="first", frames=[frame1], onPage=first, autoNextPageTemplate="later"),
            PageTemplate(id="later", frames=[frame2], onPage=later),
        ]
    )
    story: list = _title_block(doc)
    for b in doc.blocks:
        if isinstance(b, Heading):
            story += _heading(b)
        elif isinstance(b, Kpis):
            story += _kpis(b)
        elif isinstance(b, Text):
            story += [
                Paragraph(_md(b.text), _style("p", textColor=INK3 if b.muted else INK2, fontSize=9, leading=13.5)),
                Spacer(1, 2.5 * mm),
            ]
        elif isinstance(b, Bullets):
            for item in b.items:
                story.append(
                    Paragraph(
                        _md(item),
                        _style("b", fontSize=9, leading=13, leftIndent=10, bulletIndent=0, textColor=INK2),
                        bulletText="•",
                    )
                )
            story.append(Spacer(1, 3 * mm))
        elif isinstance(b, Callout):
            story += _callout(b)
        elif isinstance(b, Steps):
            story += _steps(b)
        elif isinstance(b, Table):
            story += _table(b)
        elif isinstance(b, Chart):
            story += _chart(b)
        elif isinstance(b, Pairs):
            story += _pairs(b)
        elif isinstance(b, Section):
            story += _section(b)
    story += _signatures(doc)
    t.build(story, canvasmaker=_NumberedCanvas)
    return buf.getvalue()


def _num(v: float) -> str:
    if v is None:
        return "—"
    if abs(v - round(v)) < 1e-9:
        return f"{int(round(v)):,}".replace(",", " ")
    return f"{v:,.1f}".replace(",", " ").replace(".", ",")


def _fmt(v) -> str:
    if v is None or v == "":
        return "—"
    if isinstance(v, bool):
        return "да" if v else "нет"
    if isinstance(v, datetime):
        return v.strftime("%d.%m.%Y %H:%M")
    if hasattr(v, "strftime"):
        return v.strftime("%d.%m.%Y")
    if isinstance(v, (int, float)):
        return _num(v)
    return str(v)


def money(v: float | int | None) -> str:
    if v is None:
        return "—"
    a = abs(v)
    sign = "−" if v < 0 else ""
    if a >= 1_000_000_000:
        return f"{sign}{a / 1e9:.1f} млрд ₸".replace(".", ",")
    if a >= 1_000_000:
        return f"{sign}{a / 1e6:.1f} млн ₸".replace(".", ",")
    if a >= 10_000:
        return f"{sign}{round(a / 1000):,} тыс ₸".replace(",", " ")
    return f"{sign}{round(a):,} ₸".replace(",", " ")
