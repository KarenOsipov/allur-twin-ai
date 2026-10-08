from datetime import date

from app.ingest.tables import TableKind, classify, extract, extract_targets, read_document
from app.services.data_service import CUSTOMER_FILE


def test_customer_docx_tables_are_recognised():
    doc = read_document(CUSTOMER_FILE.name, CUSTOMER_FILE.read_bytes())
    kinds = [extract(t).kind for t in doc.tables]
    assert kinds == [TableKind.PRODUCTION, TableKind.DOWNTIME, TableKind.MODEL_PLAN, TableKind.QUALITY]
    production = extract(doc.tables[0])
    assert production.records[0] == {
        "day": date(2026, 10, 1),
        "line": "Сварка-1",
        "plan": 120.0,
        "fact": 118.0,
        "run_hours": 7.8,
        "load_pct": 98.0,
    }
    assert not production.errors


def test_targets_from_free_text():
    doc = read_document(CUSTOMER_FILE.name, CUSTOMER_FILE.read_bytes())
    targets = extract_targets(doc.text)
    assert targets["oee_pct"] == 85
    assert targets["defect_pct"] == 2
    assert targets["critical_downtime_min_per_day"] == 60
    assert targets["month_output"] == 5500


def test_csv_with_comma_decimals_and_bad_rows():
    data = "Дата;Участок;Выпущено;Брак\n01.10.2026;Окраска;115;4\nвчера;Окраска;1;0\n".encode("cp1251")
    doc = read_document("q.csv", data)
    result = extract(doc.tables[0])
    assert result.kind == TableKind.QUALITY
    assert len(result.records) == 1
    assert "строка 3" in result.errors[0]


def test_unknown_headers_are_not_guessed():
    assert classify(["Имя", "Телефон"]) is None
