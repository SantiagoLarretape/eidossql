#!/usr/bin/env python3
"""Build the report-style MASTER-GUIDE.pdf:
markdown -> styled HTML -> headless Chrome -> page-number stamp."""

import subprocess, io, os, re
import markdown

SRC = "/Users/santiagolarretape/IdeaProjects/DSO 435 Visualizing Lessons/eidossql/docs/MASTER-GUIDE.md"
OUT = "/Users/santiagolarretape/IdeaProjects/DSO 435 Visualizing Lessons/eidossql/docs/MASTER-GUIDE.pdf"
SCRATCH = os.path.dirname(os.path.abspath(__file__))
HTML_PATH = os.path.join(SCRATCH, "guide.html")
RAW_PDF = os.path.join(SCRATCH, "guide_raw.pdf")

md_text = open(SRC, encoding="utf-8").read()

# The cover page carries the title + epigraph, so drop them from the flow and
# start the body at "How to use this guide".
md_body = re.sub(r"^# EidosSQL — Master Guide.*?(?=\n### How to use)", "", md_text, flags=re.S)

MD_EXT = ["tables", "fenced_code", "toc", "sane_lists"]
TOC_CFG = {"toc": {"toc_depth": "2-3"}}

html_body = markdown.markdown(md_body, extensions=MD_EXT, extension_configs=TOC_CFG)

mdi = markdown.Markdown(extensions=MD_EXT, extension_configs=TOC_CFG)
mdi.convert(md_body)
toc_html = mdi.toc

CSS = """
@page { size: letter; margin: 22mm 20mm 24mm 20mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; }
body {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 10.5pt; line-height: 1.55; color: #1a1a19; margin: 0;
}
h1, h2, h3, h4, .cover * { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }

/* ---- cover ---- */
.cover { page-break-after: always; padding-top: 38mm; }
.cover .mark { color: #1c5cab; font-size: 30pt; font-weight: 700; letter-spacing: -0.5pt; }
.cover h1 { font-size: 30pt; margin: 0 0 4mm; letter-spacing: -0.5pt; }
.cover .greek { font-family: Georgia, serif; font-style: italic; color: #1c5cab; font-size: 14pt; }
.cover .sub { font-size: 13pt; color: #52514e; margin: 2mm 0 14mm; }
.cover .rule { height: 3pt; background: #1c5cab; width: 40mm; margin: 10mm 0; }
.cover .meta { color: #52514e; font-size: 10.5pt; line-height: 1.8; }
.cover .epigraph { margin-top: 20mm; max-width: 120mm; color: #52514e; font-size: 10.5pt;
  border-left: 3px solid #1c5cab; padding-left: 6mm; font-style: italic; }

/* ---- toc ---- */
.toc-page { page-break-after: always; }
.toc-page h2 { font-size: 16pt; border-bottom: 2px solid #1c5cab; padding-bottom: 2mm;
  page-break-before: auto; margin-top: 0; }
/* python-markdown already emits <div class="toc">, so style it directly —
   wrapping it in another .toc would nest the column rule and double the columns */
.toc { font-size: 9.5pt; column-count: 2; column-gap: 12mm; }
.toc ul { list-style: none; padding-left: 0; margin: 0; }
.toc > ul > li { margin: 2mm 0 1mm; font-weight: 700; break-inside: avoid; }
.toc > ul > li > ul { padding-left: 4mm; font-weight: 400; }
.toc > ul > li > ul > li { margin: 0.8mm 0; }
.toc a { color: #1a1a19; text-decoration: none; }

/* ---- content ---- */
h2 { page-break-before: always; font-size: 17pt; color: #0b0b0b;
  border-bottom: 2.5px solid #1c5cab; padding-bottom: 2mm; margin: 0 0 6mm; }
h3 { font-size: 12.5pt; margin: 8mm 0 3mm; color: #0b0b0b; page-break-after: avoid; }
h4 { font-size: 11pt; margin: 5mm 0 2mm; page-break-after: avoid; }
p { margin: 0 0 3mm; }
li { margin: 0 0 1.6mm; }
strong { color: #0b0b0b; }
blockquote { border-left: 3px solid #1c5cab; margin: 4mm 0; padding: 1mm 0 1mm 5mm;
  color: #52514e; font-style: italic; }
code { font-family: Menlo, Consolas, monospace; font-size: 8.6pt;
  background: #f1f0ec; padding: 0.5pt 3pt; border-radius: 3px;
  overflow-wrap: break-word; }
pre { background: #f6f5f1; border: 1px solid #e1e0d9; border-radius: 6px;
  padding: 3.5mm 4mm; page-break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 8.1pt; line-height: 1.45;
  white-space: pre-wrap; word-break: break-word; }
table { border-collapse: collapse; width: 100%; margin: 3mm 0 5mm; font-size: 9.3pt;
  page-break-inside: avoid; }
th { text-align: left; font-family: 'Helvetica Neue', sans-serif; font-size: 9pt;
  border-bottom: 1.5px solid #898781; padding: 1.6mm 3mm 1.2mm 0; }
td { border-bottom: 0.75px solid #e1e0d9; padding: 1.6mm 3mm 1.6mm 0; vertical-align: top; }
hr { display: none; }
a { color: #1c5cab; }
"""

html = f"""<!doctype html><html><head><meta charset="utf-8">
<title>EidosSQL — Master Guide</title><style>{CSS}</style></head><body>
<div class="cover">
  <div class="mark">⧉</div>
  <h1>EidosSQL</h1>
  <div class="greek">εἶδος&ensp;·&ensp;the form, the thing seen</div>
  <div class="sub">Master Guide — every feature, how it was built,<br>and why it was built that way</div>
  <div class="rule"></div>
  <div class="meta">
    An interactive SQL visualizer for DSO&nbsp;435 · Data Base Management Systems<br>
    Version 1.1 · July 2026<br>
    ~5,500 lines of TypeScript · SQL engine written from scratch<br>
    Verified against PostgreSQL: 61/61 differential queries identical
  </div>
  <div class="epigraph">In ancient Greek, <b>εἶδος</b> is the form — the shape by which a thing
  is known. In modern Greek, a <b>type</b> or kind. EidosSQL makes the form of a query visible:
  one step, one type, one table at a time.</div>
</div>
<div class="toc-page"><h2>Contents</h2>{toc_html}</div>
{html_body}
</body></html>"""

open(HTML_PATH, "w", encoding="utf-8").write(html)

subprocess.run([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
    f"--print-to-pdf={RAW_PDF}", f"file://{HTML_PATH}",
], check=True, capture_output=True)

# ---- stamp footers (skip the cover) ----
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

reader = PdfReader(RAW_PDF)
writer = PdfWriter()
n = len(reader.pages)
for i, page in enumerate(reader.pages):
    if i > 0:
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=letter)
        c.setFont("Helvetica", 8)
        c.setFillColorRGB(0.45, 0.44, 0.42)
        c.drawString(57, 30, "EidosSQL — Master Guide")
        c.drawRightString(letter[0] - 57, 30, f"{i + 1} / {n}")
        c.save()
        buf.seek(0)
        page.merge_page(PdfReader(buf).pages[0])
    writer.add_page(page)

writer.add_metadata({
    "/Title": "EidosSQL — Master Guide",
    "/Subject": "Features, implementation, and design rationale for the EidosSQL SQL visualizer",
    "/Keywords": "SQL, visualization, compilers, parsing, query engine, differential testing",
})

with open(OUT, "wb") as f:
    writer.write(f)
print(f"wrote {OUT}: {n} pages, {os.path.getsize(OUT)//1024} KB")
