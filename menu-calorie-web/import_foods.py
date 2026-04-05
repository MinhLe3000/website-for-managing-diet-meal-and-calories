"""
One-time (or repeat-safe) import of Dataset1 CSV into SQLite.
Run from project root: python import_foods.py
"""

from __future__ import annotations

import csv
import os
import sqlite3
import sys
from pathlib import Path

# Re-use schema
from database import SCHEMA  # noqa: E402


def default_csv_path() -> Path:
    env = os.environ.get("FOOD_CSV")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "Dataset1" / "food1.csv"


def to_float(x: str, default: float = 0.0) -> float:
    if x is None or x == "":
        return default
    try:
        return float(x)
    except ValueError:
        return default


def import_csv(db_file: Path, csv_file: Path) -> int:
    db_file.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_file)
    conn.executescript(SCHEMA)
    cur = conn.cursor()

    inserted = 0
    with open(csv_file, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            ndb = (row.get("Nutrient Data Bank Number") or "").strip()
            category = (row.get("Category") or "").strip()
            description = (row.get("Description") or "").strip()
            kcal = to_float(row.get("Data.Kilocalories"))
            protein = to_float(row.get("Data.Protein"))
            carb = to_float(row.get("Data.Carbohydrate"))
            fat = to_float(row.get("Data.Fat.Total Lipid"))
            fiber = to_float(row.get("Data.Fiber"))

            cur.execute(
                """
                INSERT OR IGNORE INTO foods
                (ndb_number, category, description, kcal_per_100g, protein, carb, fat, fiber)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (ndb, category, description, kcal, protein, carb, fat, fiber),
            )
            inserted += cur.rowcount

    conn.commit()
    total = cur.execute("SELECT COUNT(*) FROM foods").fetchone()[0]
    conn.close()
    print(f"Rows attempted insert hits: {inserted}; total foods in DB: {total}")
    return int(total)


def main() -> None:
    root = Path(__file__).resolve().parent
    db_file = root / "instance" / "app.db"
    csv_file = default_csv_path()
    if not csv_file.is_file():
        print(f"CSV not found: {csv_file}", file=sys.stderr)
        sys.exit(1)
    import_csv(db_file, csv_file)


if __name__ == "__main__":
    main()
