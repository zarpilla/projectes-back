"""
Turns the AEAT register designs (diseños de registro, .xlsx from
https://sede.agenciatributaria.gob.es/Sede/ayuda/disenos-registro/modelos-300-399.html)
into the JSON specs src/api/treasury/services/aeat/dr<model>-<year>.json that
services/aeat-file.js fills (IVA › Models 303 i 390).

    python3 -m venv /tmp/venv && /tmp/venv/bin/pip install openpyxl
    /tmp/venv/bin/python tools/aeat-dr/extract.py DR303e26v101.xlsx src/api/treasury/services/aeat/dr303-2026.json
    /tmp/venv/bin/python tools/aeat-dr/extract.py dr390e2026.xlsx src/api/treasury/services/aeat/dr390-2026.json

Each page: its fields in order with position, length, type (An, A, Num, N),
the box number when the description ends in [nnn], and the constant when
the content says so. The positions are checked to follow each other.
"""
import json
import re
import sys

import openpyxl

BOX = re.compile(r"\[(\d+)\]\s*$")
CONSTANT = re.compile(r'^\s*(?:Constante\s*)?"([^"]*)"(?:\s*[.,]?\s*(?:Nota \d+\.?)?\s*)?$', re.I)
CONSTANT_IN = re.compile(r'Constante\s*"([^"]*)"', re.I)


def clean(value):
    return re.sub(r"\s+", " ", str(value)).strip() if value is not None else ""


def constant_of(*texts):
    for text in texts:
        m = CONSTANT.match(text) or CONSTANT_IN.search(text)
        if m:
            return m.group(1)
    return None


def page_fields(ws):
    header = None
    fields = []
    for row in ws.iter_rows(values_only=True):
        cells = [clean(c) for c in row[:10]]
        if header is None:
            if cells[:3] == ["Nº", "Posic.", "Lon"]:
                header = {name: i for i, name in enumerate(cells) if name}
            continue
        if not cells[0].isdigit():
            if fields and cells[0].upper().startswith("TOTAL"):
                break
            continue
        pos = cells[header["Posic."]]
        desc = cells[header["Descripción"]]
        validation = cells[header["Validación"]] if "Validación" in header else ""
        content = cells[header["Contenido"]] if "Contenido" in header else ""
        field = {
            "n": int(cells[0]),
            "pos": int(pos) if pos.isdigit() else None,
            "len": int(cells[header["Lon"]]) if cells[header["Lon"]].isdigit() else None,
            "type": cells[header["Tipo"]],
            "desc": desc,
        }
        box = BOX.search(desc)
        if box:
            field["box"] = box.group(1)
        constant = constant_of(content, validation)
        if constant is not None:
            field["constant"] = constant
        fields.append(field)
    return fields


def check(name, fields):
    expected = 1
    for f in fields:
        if f["pos"] is None or f["len"] is None:
            continue
        if f["pos"] != expected:
            raise SystemExit(f"{name}: field {f['n']} starts at {f['pos']}, expected {expected}")
        expected = f["pos"] + f["len"]
    return expected - 1


def main(source, target):
    wb = openpyxl.load_workbook(source, data_only=True)
    pages = []
    for ws in wb.worksheets:
        fields = page_fields(ws)
        if not fields:
            continue
        length = check(ws.title, fields)
        pages.append({"sheet": ws.title, "length": length, "fields": fields})
    with open(target, "w", encoding="utf-8") as out:
        json.dump({"source": source.split("/")[-1], "pages": pages}, out, ensure_ascii=False, indent=1)
        out.write("\n")
    for p in pages:
        print(p["sheet"], p["length"], len(p["fields"]), "fields", sum(1 for f in p["fields"] if "box" in f), "boxes")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
