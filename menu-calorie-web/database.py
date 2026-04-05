"""SQLite connection and schema for menu & calorie app."""

import sqlite3
from pathlib import Path

from flask import current_app, g


def db_path() -> Path:
    return Path(current_app.config["DATABASE"])


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(db_path())
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_exc=None) -> None:
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db() -> None:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY,
    age INTEGER,
    sex TEXT,
    height_cm REAL,
    weight_kg REAL,
    activity_level INTEGER NOT NULL DEFAULT 2,
    target_weight_kg REAL,
    calorie_deficit INTEGER NOT NULL DEFAULT 500,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ndb_number TEXT UNIQUE,
    category TEXT,
    description TEXT,
    kcal_per_100g REAL,
    protein REAL,
    carb REAL,
    fat REAL,
    fiber REAL
);

CREATE TABLE IF NOT EXISTS food_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    food_id INTEGER NOT NULL,
    grams REAL NOT NULL,
    calories REAL NOT NULL,
    protein REAL,
    carb REAL,
    fat REAL,
    meal_label TEXT,
    logged_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (food_id) REFERENCES foods(id)
);

CREATE INDEX IF NOT EXISTS idx_logs_user_time ON food_logs(user_id, logged_at);

CREATE VIRTUAL TABLE IF NOT EXISTS food_fts USING fts5(
    description,
    category,
    content='foods',
    content_rowid='id',
    tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS foods_ai AFTER INSERT ON foods BEGIN
    INSERT INTO food_fts(rowid, description, category)
    VALUES (new.id, new.description, new.category);
END;

CREATE TRIGGER IF NOT EXISTS foods_ad AFTER DELETE ON foods BEGIN
    INSERT INTO food_fts(food_fts, rowid, description, category)
    VALUES('delete', old.id, old.description, old.category);
END;

CREATE TRIGGER IF NOT EXISTS foods_au AFTER UPDATE ON foods BEGIN
    INSERT INTO food_fts(food_fts, rowid, description, category)
    VALUES('delete', old.id, old.description, old.category);
    INSERT INTO food_fts(rowid, description, category)
    VALUES (new.id, new.description, new.category);
END;
"""


def food_count() -> int:
    conn = sqlite3.connect(db_path())
    try:
        row = conn.execute("SELECT COUNT(*) AS c FROM foods").fetchone()
        return int(row[0]) if row else 0
    finally:
        conn.close()
