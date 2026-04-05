"""
Menu & calorie web app — Flask + REST JSON API (/api/*) + dashboard UI.

Patterns aligned with typical Web & Web API courses:
  - HTTP resources, JSON request/response, status codes
  - Separation: browser consumes API via fetch()
  - Session cookie auth for demo users
"""

from __future__ import annotations

import re
import sqlite3
import unicodedata
from functools import wraps
from pathlib import Path

from flask import Flask, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from database import close_db, food_count, get_db, init_db

ACTIVITY_LABELS = {
    1: ("Ít vận động (1.2)", 1.2),
    2: ("Nhẹ (1.375)", 1.375),
    3: ("Vừa (1.55)", 1.55),
    4: ("Năng động (1.725)", 1.725),
    5: ("Rất năng động (1.9)", 1.9),
}

# Phân bổ % năng lượng gợi ý cho macro (có thể đổi trong code)
MACRO_KCAL_SPLIT = {"protein": 0.25, "carb": 0.45, "fat": 0.30}


def macro_targets_from_calories(calories: float) -> dict:
    """Từ kcal mục tiêu → gam đạm/carb/béo (4 kcal/g P & C, 9 kcal/g F)."""
    cal = max(0.0, float(calories))
    pk = cal * MACRO_KCAL_SPLIT["protein"]
    ck = cal * MACRO_KCAL_SPLIT["carb"]
    fk = cal * MACRO_KCAL_SPLIT["fat"]
    return {
        "protein_g": round(pk / 4.0, 1),
        "carb_g": round(ck / 4.0, 1),
        "fat_g": round(fk / 9.0, 1),
        "protein_kcal": round(pk, 0),
        "carb_kcal": round(ck, 0),
        "fat_kcal": round(fk, 0),
    }


def enrich_suggestion(row: sqlite3.Row, meal_target_cal: float) -> dict:
    """
    Gợi ý khối lượng (g) để ~đạt calo mục tiêu bữa, kèm macro khẩu phần đó.
    """
    item = dict(row)
    kcal_100 = float(item.get("kcal_per_100g") or 0)
    cal = float(meal_target_cal)
    if kcal_100 > 0:
        g = (cal / kcal_100) * 100.0
        suggested = max(30.0, min(600.0, round(g)))
    else:
        suggested = 100.0
    ratio = suggested / 100.0
    p = float(item.get("protein") or 0) * ratio
    c = float(item.get("carb") or 0) * ratio
    f = float(item.get("fat") or 0) * ratio
    item["suggested_grams"] = int(round(suggested))
    item["portion"] = {
        "calories": round(kcal_100 * ratio, 0) if kcal_100 > 0 else 0.0,
        "protein_g": round(p, 1),
        "carb_g": round(c, 1),
        "fat_g": round(f, 1),
        "fiber_g": round(float(item.get("fiber") or 0) * ratio, 1),
    }
    return item


def normalize_logged_at_client(value) -> str | None:
    """Chuẩn hoá từ client → SQLite datetime.

    - Chỉ ngày: ``YYYY-MM-DD`` → ``YYYY-MM-DD 12:00:00`` (cột bữa chủ yếu theo nhãn bữa).
    - Có giờ: ``YYYY-MM-DDTHH:MM`` hoặc ``YYYY-MM-DD HH:MM`` → thêm ``:00`` nếu thiếu giây.
    """
    if value is None or value == "":
        return None
    s = str(value).strip().replace("T", " ", 1)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return f"{s} 12:00:00"
    if len(s) == 16 and re.match(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", s):
        s += ":00"
    return s


def _strip_vi_label(s: str) -> str:
    t = unicodedata.normalize("NFD", str(s or ""))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return t.lower().strip()


def log_date_key_py(logged_at) -> str:
    st = str(logged_at or "")
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", st)
    return m.group(1) if m else st[:10]


def meal_slot_from_label_py(meal_label, logged_at) -> str:
    """Khớp logic mealSlotFromLabel trong static/app.js (Sáng/Trưa/Tối/Khác)."""
    a = _strip_vi_label(meal_label or "")
    if a:
        if "trua" in a or "lunch" in a:
            return "trua"
        if "toi" in a or "dem" in a or "dinner" in a or "supper" in a:
            return "toi"
        if "sang" in a or "breakfast" in a:
            return "sang"
        if "khac" in a or "other" in a or "phu" in a or "snack" in a:
            return "khac"
    if logged_at:
        m = re.search(r"\s(\d{1,2}):(\d{2}):", str(logged_at))
        if m:
            h = int(m.group(1))
            if 4 <= h < 11:
                return "sang"
            if 11 <= h < 15:
                return "trua"
            if 15 <= h < 23:
                return "toi"
    return "khac"


def format_date_vn(iso_ymd: str) -> str:
    p = iso_ymd.split("-")
    if len(p) != 3:
        return iso_ymd
    return f"{p[2]}/{p[1]}/{p[0]}"


def create_app() -> Flask:
    app = Flask(
        __name__,
        instance_relative_config=True,
        template_folder="templates",
        static_folder="static",
    )
    app.config.from_mapping(
        SECRET_KEY="dev-menu-calorie-change-in-production",
        DATABASE=str(Path(app.instance_path) / "app.db"),
    )

    app.teardown_appcontext(close_db)

    with app.app_context():
        init_db()

    @app.route("/")
    def index():
        return render_template("index.html")

    def current_user_id():
        return session.get("user_id")

    def login_required(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            if current_user_id() is None:
                return jsonify({"error": "unauthorized"}), 401
            return f(*args, **kwargs)

        return wrapped

    def row_profile(user_id: int) -> dict | None:
        db = get_db()
        row = db.execute(
            "SELECT * FROM profiles WHERE user_id = ?", (user_id,)
        ).fetchone()
        if not row:
            return None
        return dict(row)

    def compute_bmi(weight_kg: float, height_cm: float) -> dict:
        h = height_cm / 100.0
        bmi = weight_kg / (h * h) if h > 0 else None
        if bmi is None:
            label = None
        elif bmi < 18.5:
            label = "Thiếu cân"
        elif bmi < 25:
            label = "Bình thường"
        elif bmi < 30:
            label = "Thừa cân"
        else:
            label = "Béo phì"
        return {"bmi": round(bmi, 2) if bmi is not None else None, "category": label}

    def compute_tdee(profile: dict) -> dict | None:
        if not profile:
            return None
        w = profile.get("weight_kg")
        h = profile.get("height_cm")
        a = profile.get("age")
        sex = (profile.get("sex") or "").lower()
        lvl = int(profile.get("activity_level") or 2)
        if not all(isinstance(x, (int, float)) for x in (w, h, a)) or w <= 0 or h <= 0:
            return None
        if sex in ("m", "male", "nam"):
            bmr = 10 * w + 6.25 * h - 5 * a + 5
        else:
            bmr = 10 * w + 6.25 * h - 5 * a - 161
        mult = ACTIVITY_LABELS.get(lvl, ACTIVITY_LABELS[2])[1]
        tdee = bmr * mult
        deficit = int(profile.get("calorie_deficit") or 0)
        target = max(800, tdee - deficit)
        return {
            "bmr": round(bmr, 1),
            "tdee": round(tdee, 1),
            "daily_intake_target": round(target, 1),
            "activity_multiplier": mult,
        }

    @app.post("/api/register")
    def register():
        data = request.get_json(silent=True) or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        if len(username) < 3 or len(password) < 4:
            return jsonify({"error": "username/password quá ngắn"}), 400
        db = get_db()
        try:
            db.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (username, generate_password_hash(password)),
            )
            db.commit()
        except sqlite3.IntegrityError:
            return jsonify({"error": "username đã tồn tại"}), 409
        user = db.execute(
            "SELECT id FROM users WHERE username = ?", (username,)
        ).fetchone()
        uid = int(user["id"])
        db.execute("INSERT OR IGNORE INTO profiles (user_id) VALUES (?)", (uid,))
        db.commit()
        session["user_id"] = uid
        return jsonify({"ok": True, "user_id": uid})

    @app.post("/api/login")
    def login():
        data = request.get_json(silent=True) or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        row = get_db().execute(
            "SELECT id, password_hash FROM users WHERE username = ?", (username,)
        ).fetchone()
        if not row or not check_password_hash(row["password_hash"], password):
            return jsonify({"error": "sai tài khoản hoặc mật khẩu"}), 401
        session["user_id"] = int(row["id"])
        return jsonify({"ok": True, "user_id": session["user_id"]})

    @app.post("/api/logout")
    def logout():
        session.clear()
        return jsonify({"ok": True})

    @app.get("/api/me")
    def me():
        uid = current_user_id()
        if not uid:
            return jsonify({"authenticated": False})
        db = get_db()
        u = db.execute(
            "SELECT id, username, created_at FROM users WHERE id = ?", (uid,)
        ).fetchone()
        profile = row_profile(uid)
        meta = compute_tdee(profile) if profile else None
        bmi = None
        if profile and profile.get("weight_kg") and profile.get("height_cm"):
            bmi = compute_bmi(profile["weight_kg"], profile["height_cm"])
        return jsonify(
            {
                "authenticated": True,
                "user": dict(u) if u else None,
                "profile": profile,
                "tdee_meta": meta,
                "bmi": bmi,
                "foods_loaded": food_count(),
                "activity_levels": {str(k): v[0] for k, v in ACTIVITY_LABELS.items()},
            }
        )

    @app.get("/api/foods/search")
    def food_search():
        q = (request.args.get("q") or "").strip()
        limit = min(50, max(1, int(request.args.get("limit", 20))))
        db = get_db()
        if len(q) < 2:
            return jsonify({"items": [], "hint": "Nhập ít nhất 2 ký tự."})
        match = build_fts_match(q)
        rows = []
        if match:
            try:
                rows = db.execute(
                    """
                    SELECT f.id, f.ndb_number, f.category, f.description,
                           f.kcal_per_100g, f.protein, f.carb, f.fat, f.fiber
                    FROM food_fts fts
                    JOIN foods f ON f.id = fts.rowid
                    WHERE fts MATCH ?
                    LIMIT ?
                    """,
                    (match, limit),
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []
        if not rows:
            like = f"%{q}%"
            rows = db.execute(
                """
                SELECT id, ndb_number, category, description,
                       kcal_per_100g, protein, carb, fat, fiber
                FROM foods
                WHERE description LIKE ? OR category LIKE ?
                LIMIT ?
                """,
                (like, like, limit),
            ).fetchall()
        return jsonify({"items": [dict(r) for r in rows]})

    @app.get("/api/foods/<int:food_id>")
    def food_detail(food_id: int):
        row = get_db().execute(
            """
            SELECT id, ndb_number, category, description,
                   kcal_per_100g, protein, carb, fat, fiber
            FROM foods WHERE id = ?
            """,
            (food_id,),
        ).fetchone()
        if not row:
            return jsonify({"error": "not found"}), 404
        return jsonify(dict(row))

    @app.get("/api/profile")
    @login_required
    def get_profile():
        p = row_profile(current_user_id())
        return jsonify({"profile": p})

    @app.put("/api/profile")
    @login_required
    def put_profile():
        uid = current_user_id()
        data = request.get_json(silent=True) or {}
        
        fields = {
            "age": data.get("age"),
            "sex": data.get("sex"),
            "height_cm": data.get("height_cm"),
            "weight_kg": data.get("weight_kg"),
            "activity_level": data.get("activity_level"),
            "target_weight_kg": data.get("target_weight_kg"),
            "calorie_deficit": data.get("calorie_deficit"),
        }
        db = get_db()
        db.execute(
            """
            INSERT INTO profiles (user_id, age, sex, height_cm, weight_kg,
                activity_level, target_weight_kg, calorie_deficit)
            VALUES (:uid, :age, :sex, :height, :weight, :act, :tw, :def)
            ON CONFLICT(user_id) DO UPDATE SET
                age = excluded.age,
                sex = excluded.sex,
                height_cm = excluded.height_cm,
                weight_kg = excluded.weight_kg,
                activity_level = excluded.activity_level,
                target_weight_kg = excluded.target_weight_kg,
                calorie_deficit = excluded.calorie_deficit
            """,
            {
                "uid": uid,
                "age": fields["age"],
                "sex": fields["sex"],
                "height": fields["height_cm"],
                "weight": fields["weight_kg"],
                "act": fields["activity_level"],
                "tw": fields["target_weight_kg"],
                "def": fields["calorie_deficit"],
            },
        )
        db.commit()
        p = row_profile(uid)
        return jsonify({"profile": p, "tdee": compute_tdee(p), "bmi": compute_bmi(p["weight_kg"], p["height_cm"]) if p and p.get("weight_kg") and p.get("height_cm") else None})

    @app.post("/api/log")
    @login_required
    def add_log():
        uid = current_user_id()
        data = request.get_json(silent=True) or {}
        food_id = int(data.get("food_id") or 0)
        grams = float(data.get("grams") or 0)
        meal_label = (data.get("meal_label") or "").strip() or None
        if food_id <= 0 or grams <= 0:
            return jsonify({"error": "food_id và grams không hợp lệ"}), 400
        db = get_db()
        frow = db.execute(
            "SELECT kcal_per_100g, protein, carb, fat FROM foods WHERE id = ?",
            (food_id,),
        ).fetchone()
        if not frow:
            return jsonify({"error": "food not found"}), 404
        ratio = grams / 100.0
        calories = round(float(frow["kcal_per_100g"]) * ratio, 2)
        protein = round(float(frow["protein"]) * ratio, 3)
        carb = round(float(frow["carb"]) * ratio, 3)
        fat = round(float(frow["fat"]) * ratio, 3)
        logged_at = normalize_logged_at_client(data.get("logged_at"))
        if logged_at:
            cur = db.execute(
                """
                INSERT INTO food_logs (user_id, food_id, grams, calories, protein, carb, fat, meal_label, logged_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (uid, food_id, grams, calories, protein, carb, fat, meal_label, logged_at),
            )
        else:
            cur = db.execute(
                """
                INSERT INTO food_logs (user_id, food_id, grams, calories, protein, carb, fat, meal_label)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (uid, food_id, grams, calories, protein, carb, fat, meal_label),
            )
        db.commit()
        log = db.execute("SELECT * FROM food_logs WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify({"log": dict(log)})

    @app.get("/api/log")
    @login_required
    def list_logs():
        uid = current_user_id()
        start = request.args.get("start")
        end = request.args.get("end")
        q = """
            SELECT l.*, f.description AS food_description, f.category AS food_category
            FROM food_logs l
            JOIN foods f ON f.id = l.food_id
            WHERE l.user_id = ?
        """
        args: list = [uid]
        if start:
            q += " AND date(l.logged_at) >= date(?) "
            args.append(start)
        if end:
            q += " AND date(l.logged_at) <= date(?) "
            args.append(end)
        q += " ORDER BY l.logged_at DESC LIMIT 500"
        rows = get_db().execute(q, args).fetchall()
        return jsonify({"logs": [dict(r) for r in rows]})

    @app.get("/api/log/<int:log_id>")
    @login_required
    def get_log(log_id: int):
        uid = current_user_id()
        row = get_db().execute(
            """
            SELECT l.*, f.description AS food_description, f.category AS food_category
            FROM food_logs l
            JOIN foods f ON f.id = l.food_id
            WHERE l.id = ? AND l.user_id = ?
            """,
            (log_id, uid),
        ).fetchone()
        if not row:
            return jsonify({"error": "not found"}), 404
        return jsonify({"log": dict(row)})

    @app.put("/api/log/<int:log_id>")
    @login_required
    def update_log(log_id: int):
        uid = current_user_id()
        data = request.get_json(silent=True) or {}
        db = get_db()
        cur = db.execute(
            "SELECT * FROM food_logs WHERE id = ? AND user_id = ?",
            (log_id, uid),
        ).fetchone()
        if not cur:
            return jsonify({"error": "not found"}), 404
        food_id = int(cur["food_id"])
        grams = float(data["grams"]) if data.get("grams") is not None else float(cur["grams"])
        if grams <= 0:
            return jsonify({"error": "grams không hợp lệ"}), 400
        meal_label = data.get("meal_label")
        if meal_label is not None:
            meal_label = str(meal_label).strip() or None
        else:
            meal_label = cur["meal_label"]
        logged_at = data.get("logged_at")
        if logged_at is not None and logged_at != "":
            logged_at = normalize_logged_at_client(logged_at)
        else:
            logged_at = cur["logged_at"]

        frow = db.execute(
            "SELECT kcal_per_100g, protein, carb, fat FROM foods WHERE id = ?",
            (food_id,),
        ).fetchone()
        if not frow:
            return jsonify({"error": "food not found"}), 404
        ratio = grams / 100.0
        calories = round(float(frow["kcal_per_100g"]) * ratio, 2)
        protein = round(float(frow["protein"] or 0) * ratio, 3)
        carb = round(float(frow["carb"] or 0) * ratio, 3)
        fat = round(float(frow["fat"] or 0) * ratio, 3)

        db.execute(
            """
            UPDATE food_logs
            SET grams = ?, calories = ?, protein = ?, carb = ?, fat = ?,
                meal_label = ?, logged_at = ?
            WHERE id = ? AND user_id = ?
            """,
            (
                grams,
                calories,
                protein,
                carb,
                fat,
                meal_label,
                logged_at,
                log_id,
                uid,
            ),
        )
        db.commit()
        row = db.execute(
            """
            SELECT l.*, f.description AS food_description, f.category AS food_category
            FROM food_logs l
            JOIN foods f ON f.id = l.food_id
            WHERE l.id = ?
            """,
            (log_id,),
        ).fetchone()
        return jsonify({"log": dict(row)})

    @app.delete("/api/log/<int:log_id>")
    @login_required
    def delete_log(log_id: int):
        uid = current_user_id()
        db = get_db()
        db.execute(
            "DELETE FROM food_logs WHERE id = ? AND user_id = ?", (log_id, uid)
        )
        db.commit()
        return jsonify({"ok": True})

    @app.get("/api/analytics/daily")
    @login_required
    def analytics_daily():
        uid = current_user_id()
        days = min(90, max(1, int(request.args.get("days", 14))))
        # Mỗi ngày trong khoảng [hôm nay − (days−1) … hôm nay] đều có 1 điểm (0 kcal nếu không log).
        # Tránh biểu đồ “nhảy cóc” ngày (ví dụ có 1/4 và 3/4 mà thiếu 2/4 trên trục).
        rows = get_db().execute(
            """
            WITH RECURSIVE rng(d) AS (
                SELECT date('now', '-' || cast(? AS text) || ' days')
                UNION ALL
                SELECT date(d, '+1 day') FROM rng WHERE d < date('now')
            )
            SELECT rng.d AS d,
                   COALESCE(SUM(fl.calories), 0) AS calories,
                   COALESCE(SUM(fl.protein), 0) AS protein,
                   COALESCE(SUM(fl.carb), 0) AS carb,
                   COALESCE(SUM(fl.fat), 0) AS fat
            FROM rng
            LEFT JOIN food_logs fl
              ON date(fl.logged_at) = rng.d AND fl.user_id = ?
            GROUP BY rng.d
            ORDER BY rng.d
            """,
            (days - 1, uid),
        ).fetchall()
        return jsonify({"series": [dict(r) for r in rows]})

    @app.get("/api/analytics/meals_week")
    @login_required
    def analytics_meals_week():
        """Calo theo 4 bữa + tổng gam P/C/F mỗi ngày (dữ liệu nhật ký thật), mặc định 7 ngày."""
        uid = current_user_id()
        n = min(14, max(1, int(request.args.get("days", 7))))
        db = get_db()
        date_rows = db.execute(
            """
            WITH RECURSIVE rng(d) AS (
                SELECT date('now', '-' || cast(? AS text) || ' days')
                UNION ALL
                SELECT date(d, '+1 day') FROM rng WHERE d < date('now')
            )
            SELECT d FROM rng ORDER BY d
            """,
            (n - 1,),
        ).fetchall()
        dates = [r["d"] for r in date_rows]
        if not dates:
            return jsonify({"days": []})

        log_rows = db.execute(
            """
            SELECT meal_label, logged_at, calories, protein, carb, fat
            FROM food_logs
            WHERE user_id = ?
              AND date(logged_at) >= ?
              AND date(logged_at) <= date('now')
            """,
            (uid, dates[0]),
        ).fetchall()

        by_day: dict[str, dict] = {
            d: {
                "sang": 0.0,
                "trua": 0.0,
                "toi": 0.0,
                "khac": 0.0,
                "protein": 0.0,
                "carb": 0.0,
                "fat": 0.0,
            }
            for d in dates
        }
        for r in log_rows:
            d = log_date_key_py(r["logged_at"])
            if d not in by_day:
                continue
            slot = meal_slot_from_label_py(r["meal_label"], r["logged_at"])
            b = by_day[d]
            b[slot] += float(r["calories"] or 0)
            b["protein"] += float(r["protein"] or 0)
            b["carb"] += float(r["carb"] or 0)
            b["fat"] += float(r["fat"] or 0)

        out = []
        for i, d in enumerate(dates):
            b = by_day[d]
            out.append(
                {
                    "day_index": i + 1,
                    "d": d,
                    "label_vn": format_date_vn(d),
                    "meals_kcal": {
                        "sang": round(b["sang"], 1),
                        "trua": round(b["trua"], 1),
                        "toi": round(b["toi"], 1),
                        "khac": round(b["khac"], 1),
                    },
                    "protein_g": round(b["protein"], 3),
                    "carb_g": round(b["carb"], 3),
                    "fat_g": round(b["fat"], 3),
                }
            )
        return jsonify({"days": out})

    @app.get("/api/suggest/week")
    @login_required
    def suggest_week():
        uid = current_user_id()
        profile = row_profile(uid)
        if not profile:
            return jsonify({"error": "cập nhật hồ sơ trước"}), 400
        meta = compute_tdee(profile)
        if not meta:
            return jsonify({"error": "thiếu thông tin TDEE (tuổi, giới, cân, cao)"}), 400
        target = meta["daily_intake_target"]
        db = get_db()
        splits = (0.25, 0.35, 0.30, 0.10)
        labels = ("Bữa sáng", "Bữa trưa", "Bữa tối", "Phụ / snack")
        out_days = []
        daily_macro = macro_targets_from_calories(target)
        pct = {
            "protein": int(round(MACRO_KCAL_SPLIT["protein"] * 100)),
            "carb": int(round(MACRO_KCAL_SPLIT["carb"] * 100)),
            "fat": int(round(MACRO_KCAL_SPLIT["fat"] * 100)),
        }
        for day in range(1, 8):
            meals = []
            for share, label in zip(splits, labels):
                cal = round(target * share, 0)
                meal_macro = macro_targets_from_calories(cal)
                kcal_cap = min(float(cal) * 2.0, 900.0)
                ideas = db.execute(
                    """
                    SELECT id, description, kcal_per_100g, category, protein, carb, fat, fiber
                    FROM foods
                    WHERE kcal_per_100g BETWEEN 40 AND ?
                    ORDER BY RANDOM()
                    LIMIT 3
                    """,
                    (kcal_cap,),
                ).fetchall()
                enriched = [enrich_suggestion(r, cal) for r in ideas]
                meals.append(
                    {
                        "label": label,
                        "calorie_share": share,
                        "target_calories": cal,
                        "macro_target": meal_macro,
                        "suggestions": enriched,
                    }
                )
            out_days.append(
                {
                    "day_index": day,
                    "daily_calorie_target": round(target, 0),
                    "daily_macro_target": daily_macro,
                    "meals": meals,
                }
            )
        return jsonify(
            {
                "tdee": meta["tdee"],
                "daily_intake_target": target,
                "deficit": profile.get("calorie_deficit"),
                "macro_kcal_percent": pct,
                "macro_note": (
                    f"Macro mục tiêu gợi ý: ~{pct['protein']}% kcal từ đạm, "
                    f"~{pct['carb']}% từ carb, ~{pct['fat']}% từ chất béo "
                    "(ước lượng cho thực đơn cân bằng; có thể chỉnh trong app.py — MACRO_KCAL_SPLIT)."
                ),
                "days": out_days,
                "note": "Giá trị/100 g theo Dataset1; cột 'khẩu phần gợi ý' ≈ gam để gần calo mục tiêu bữa.",
            }
        )

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok", "foods": food_count()})

    return app


def build_fts_match(q: str) -> str | None:
    parts = []
    for raw in q.split():
        token = re.sub(r"[^\w\-]", "", raw, flags=re.UNICODE)
        if len(token) < 2:
            continue
        parts.append(f'{token}*')
    if not parts:
        return None
    return " AND ".join(parts)


app = create_app()

if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=5000)
