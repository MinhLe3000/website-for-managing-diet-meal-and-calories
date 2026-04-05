/* Gọi REST API (JSON) — tách khỏi Flask template */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let chartDaily = null;
let selectedFood = null;
let weekCaloriesChart = null;
let weekMacroPieChart = null;
let currentWeekData = null;
let weekPieBound = false;
let chartResizeTimer = null;
/** Bản sao nhật ký sau lần load bảng gần nhất — dùng cho modal chi tiết theo ngày. */
let cachedLogsList = [];
let dayOverviewBarChart = null;
let dayOverviewPieChart = null;
let logsWeekBarChart = null;
let logsWeekPieChart = null;
let logsWeekConsumptionData = null;

/** Canvas + màn hình DPI cao: nếu DPR không khớp, vẽ bị “kéo giãn” → chữ và cạnh trông mờ. */
function chartPixelRatio() {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(3, Math.max(1, dpr));
}

function baseChartOptions(overrides = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    devicePixelRatio: chartPixelRatio(),
    ...overrides,
  };
}

function resizeAllCharts() {
  chartDaily?.resize?.();
  weekCaloriesChart?.resize?.();
  weekMacroPieChart?.resize?.();
  dayOverviewBarChart?.resize?.();
  dayOverviewPieChart?.resize?.();
  logsWeekBarChart?.resize?.();
  logsWeekPieChart?.resize?.();
}

function scheduleChartsReflow() {
  requestAnimationFrame(() => {
    resizeAllCharts();
    requestAnimationFrame(resizeAllCharts);
  });
}

/** Ẩn biểu đồ tuần + xóa nội dung gợi ý (mặc định / sau đăng xuất). */
function resetWeekSuggestionUI() {
  const wrap = $("#week-charts-wrap");
  if (wrap) wrap.classList.add("hidden");
  destroyChartIfAny(weekCaloriesChart);
  weekCaloriesChart = null;
  destroyChartIfAny(weekMacroPieChart);
  weekMacroPieChart = null;
  currentWeekData = null;
  const pieSel = $("#week-pie-day");
  if (pieSel) pieSel.innerHTML = "";
  const plan = $("#week-plan");
  if (plan) plan.innerHTML = "";
}

function showBanner(text, kind = "ok") {
  const el = $("#banner");
  el.textContent = text;
  el.classList.remove("hidden", "error", "ok");
  el.classList.add(kind === "error" ? "error" : "ok");
}

function hideBanner() {
  $("#banner").classList.add("hidden");
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toggleApp(show) {
  document.body.classList.toggle("auth-gate", !show);
  ["panel-app", "panel-search", "panel-logs", "panel-week"].forEach((id) => {
    $(`#${id}`).classList.toggle("hidden", !show);
  });
  $("#panel-auth").classList.toggle("hidden", show);
}

function renderAuthBar(me) {
  const bar = $("#auth-bar");
  if (!me.authenticated) {
    bar.innerHTML = `<span class="hint">Chưa đăng nhập</span>`;
    return;
  }
  bar.innerHTML = `
    <span>${me.user.username}</span>
    <button type="button" id="btn-logout">Đăng xuất</button>
  `;
  $("#btn-logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    await refreshMe();
  });
}

function fillActivitySelect(levels) {
  const sel = $("#activity_level");
  sel.innerHTML = Object.entries(levels)
    .map(([k, label]) => `<option value="${k}">${label}</option>`)
    .join("");
}

async function refreshMe() {
  hideBanner();
  const me = await api("/api/me");
  renderAuthBar(me);
  fillActivitySelect(me.activity_levels || {});

  if (!me.authenticated) {
    cachedLogsList = [];
    destroyLogsWeekCharts();
    resetWeekSuggestionUI();
    toggleApp(false);
    return;
  }

  toggleApp(true);

  if (!me.foods_loaded) {
    showBanner(
      "Chưa import dữ liệu thực phẩm. Chạy: python import_foods.py (từ thư mục menu-calorie-web).",
      "error"
    );
  }

  const p = me.profile || {};
  const form = $("#form-profile");
  form.age.value = p.age ?? "";
  form.sex.value = p.sex === "male" || p.sex === "m" || p.sex === "nam" ? "nam" : "nu";
  form.height_cm.value = p.height_cm ?? "";
  form.weight_kg.value = p.weight_kg ?? "";
  form.activity_level.value = p.activity_level ?? 2;
  form.target_weight_kg.value = p.target_weight_kg ?? "";
  form.calorie_deficit.value = p.calorie_deficit ?? 500;

  renderProfileSummary(me);
  await loadLogs();
  await loadChart();
  await loadLogsWeekConsumption();
}

function renderProfileSummary(me) {
  const box = $("#profile-summary");
  const t = me.tdee_meta;
  const b = me.bmi;
  if (!t && !b) {
    box.innerHTML = "<p>Nhập đủ tuổi, giới, cân, cao để xem TDEE & BMI.</p>";
    return;
  }
  box.innerHTML = `
    <h3>Tóm tắt</h3>
    <dl>
      ${t ? `<dt>BMR</dt><dd>${t.bmr} kcal/ngày</dd>` : ""}
      ${t ? `<dt>TDEE</dt><dd>${t.tdee} kcal/ngày</dd>` : ""}
      ${t ? `<dt>Mục tiêu nạp (giảm cân)</dt><dd>${t.daily_intake_target} kcal/ngày</dd>` : ""}
      ${b && b.bmi != null ? `<dt>BMI</dt><dd>${b.bmi} — ${b.category || ""}</dd>` : ""}
    </dl>
  `;
}

async function searchFoods() {
  const q = $("#food-q").value.trim();
  const ul = $("#food-results");
  ul.innerHTML = "";
  selectedFood = null;
  $("#food-detail").classList.add("hidden");
  $("#form-log").classList.add("hidden");
  if (q.length < 2) {
    showBanner("Nhập ít nhất 2 ký tự để tìm.", "error");
    return;
  }
  hideBanner();
  const data = await api(`/api/foods/search?q=${encodeURIComponent(q)}&limit=25`);
  data.items.forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${item.description}</strong><small>${item.category} · ${item.kcal_per_100g} kcal/100g</small>`;
    li.addEventListener("click", () => selectFood(item, li));
    ul.appendChild(li);
  });
  if (!data.items.length) {
    ul.innerHTML = "<li class='hint'>Không có kết quả (đã import food1.csv chưa?)</li>";
  }
}

function selectFood(item, li) {
  $$("#food-results li").forEach((x) => x.classList.remove("active"));
  li.classList.add("active");
  selectedFood = item;
  const d = $("#food-detail");
  d.classList.remove("hidden");
  d.innerHTML = `
    <h3>${item.description}</h3>
    <p><small>${item.category}</small></p>
    <dl class="summary">
      <dt>kcal / 100g</dt><dd>${item.kcal_per_100g}</dd>
      <dt>Protein</dt><dd>${item.protein} g</dd>
      <dt>Carb</dt><dd>${item.carb} g</dd>
      <dt>Fat</dt><dd>${item.fat} g</dd>
      <dt>Fiber</dt><dd>${item.fiber} g</dd>
    </dl>
  `;
  $("#log-food-id").value = item.id;
  $("#form-log").classList.remove("hidden");
}

async function submitLog(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const grams = parseFloat(fd.get("grams"));
  const foodId = parseInt($("#log-food-id").value, 10);
  const meal_label = (fd.get("meal_label") || "").trim() || null;
  const loggedRaw = (fd.get("logged_at") || "").trim();
  const body = { food_id: foodId, grams, meal_label };
  if (loggedRaw) body.logged_at = loggedRaw;
  await api("/api/log", {
    method: "POST",
    body: JSON.stringify(body),
  });
  showBanner(`Đã lưu nhật ký: ${grams}g → calo đã tính.`, "ok");
  await loadLogs();
  await loadChart();
  await loadLogsWeekConsumption();
}

function escapeHtml(s) {
  if (s == null) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** Chuỗi lưu DB → Date (chỉ dùng để mở lịch; phần giờ trong DB có thể bỏ qua). */
function parseSqlLoggedAtToDate(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
}

/** Giá trị form chỉ ngày `Y-m-d` → Date (trưa local, khớp mặc định server). */
function parseYmdFromStore(val) {
  const m = String(val || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
}

function dateAtYmdNoon(dayIso) {
  const [y, mo, d] = String(dayIso).split("-").map((x) => parseInt(x, 10));
  if (!y || !mo || !d) return new Date();
  return new Date(y, mo - 1, d, 12, 0, 0, 0);
}

function destroyFlatpickr(input) {
  if (input && input._flatpickr) input._flatpickr.destroy();
}

/** Lịch popup chỉ chọn ngày (Flatpickr). Giá trị form: `Y-m-d` → server thêm 12:00:00. */
function attachFlatpickrDatetime(input, defaultDate = null) {
  if (!input) return null;
  if (typeof flatpickr === "undefined") {
    if (defaultDate instanceof Date && !Number.isNaN(defaultDate.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      input.value = `${defaultDate.getFullYear()}-${pad(defaultDate.getMonth() + 1)}-${pad(defaultDate.getDate())}`;
    }
    return null;
  }
  destroyFlatpickr(input);
  const opts = {
    enableTime: false,
    dateFormat: "Y-m-d",
    altInput: true,
    altInputClass: "fp-alt-datetime",
    altFormat: "d/m/Y",
    allowInput: false,
    clickOpens: true,
    monthSelectorType: "dropdown",
    disableMobile: true,
  };
  if (flatpickr.l10ns && flatpickr.l10ns.vn) opts.locale = flatpickr.l10ns.vn;
  const fp = flatpickr(input, opts);
  if (defaultDate instanceof Date && !Number.isNaN(defaultDate.getTime())) fp.setDate(defaultDate, false);
  return fp;
}

function formatLogDatetimeDisplay(loggedAt) {
  const day = logDateKey(String(loggedAt || ""));
  return day ? formatDateVN(day) : "—";
}

function openModal(html) {
  destroyDayOverviewCharts();
  const root = $("#modal-root");
  const content = $("#modal-content");
  if (!root || !content) return;
  content.innerHTML = html;
  root.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  destroyDayOverviewCharts();
  const root = $("#modal-root");
  const content = $("#modal-content");
  if (content) content.innerHTML = "";
  if (root) root.classList.add("hidden");
  document.body.style.overflow = "";
}

function initModal() {
  const root = $("#modal-root");
  if (!root || root.dataset.inited) return;
  root.dataset.inited = "1";
  $("#modal-backdrop")?.addEventListener("click", closeModal);
  $("#modal-close")?.addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && root && !root.classList.contains("hidden")) closeModal();
  });
}

async function openLogDetail(logId) {
  const { log } = await api(`/api/log/${logId}`);
  const title = escapeHtml(log.food_description || "Món ăn");
  openModal(`
    <h2 id="modal-title">${title}</h2>
    <dl class="modal-dl">
      <dt>Danh mục</dt><dd>${escapeHtml(log.food_category || "—")}</dd>
      <dt>Khối lượng</dt><dd>${escapeHtml(String(log.grams))} g</dd>
      <dt>Calo</dt><dd>${escapeHtml(String(log.calories))} kcal</dd>
      <dt>Đạm / Carb / Béo</dt><dd>${escapeHtml(String(log.protein))} g · ${escapeHtml(String(log.carb))} g · ${escapeHtml(String(log.fat))} g</dd>
      <dt>Bữa</dt><dd>${escapeHtml(log.meal_label || "—")}</dd>
      <dt>Ngày</dt><dd>${escapeHtml(formatLogDatetimeDisplay(log.logged_at))}</dd>
    </dl>
  `);
}

async function openLogEdit(logId) {
  const { log } = await api(`/api/log/${logId}`);
  openModal(`
    <h2 id="modal-title">Sửa mục nhật ký</h2>
    <p class="hint modal-food-name">${escapeHtml(log.food_description || "")}</p>
    <form id="form-edit-log" class="modal-form">
      <label>Số gam <input name="grams" type="number" min="1" max="5000" step="1" required /></label>
      <label>Bữa (tuỳ chọn) <select name="meal_label">${MEAL_SELECT_OPTIONS_HTML}</select></label>
      <label>Ngày <input name="logged_at" type="text" class="input-datetime-popup" id="edit-logged-at" autocomplete="off" /></label>
      <div class="modal-actions">
        <button type="submit">Lưu thay đổi</button>
        <button type="button" class="modal-btn-secondary" id="modal-edit-cancel">Hủy</button>
      </div>
    </form>
  `);
  const form = $("#form-edit-log");
  form.grams.value = log.grams;
  form.meal_label.value = mealLabelToSelectValue(log.meal_label);
  const la = $("#edit-logged-at");
  const editInitial = parseSqlLoggedAtToDate(log.logged_at) || new Date();
  attachFlatpickrDatetime(la, editInitial);
  $("#modal-edit-cancel")?.addEventListener("click", closeModal);
  form.addEventListener(
    "submit",
    async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const grams = parseFloat(fd.get("grams"));
      const meal_label = (fd.get("meal_label") || "").trim() || null;
      const logged_at = (fd.get("logged_at") || "").trim() || null;
      await api(`/api/log/${logId}`, {
        method: "PUT",
        body: JSON.stringify({ grams, meal_label, logged_at }),
      });
      closeModal();
      showBanner("Đã cập nhật mục nhật ký.", "ok");
      await loadLogs();
      await loadChart();
      await loadLogsWeekConsumption();
    },
    { once: true }
  );
}

function openAddDayFlow() {
  openModal(`
    <h2 id="modal-title">Thêm nhật ký theo ngày</h2>
    <p class="hint">Chọn <strong>ngày</strong>, rồi tìm món và bấm <strong>Lưu &amp; tính calo</strong> — món ghi đúng ngày đó.</p>
    <form id="form-add-day-flow" class="modal-form">
      <label>Ngày ăn <input type="text" class="input-datetime-popup" id="modal-pick-datetime" autocomplete="off" required /></label>
      <div class="modal-actions">
        <button type="submit">Tiếp tục — Tìm món</button>
        <button type="button" class="modal-btn-secondary" id="modal-add-day-cancel">Hủy</button>
      </div>
    </form>
  `);
  const inp = $("#modal-pick-datetime");
  const logEl = $("#log-datetime");
  let initialPick = new Date();
  initialPick.setHours(12, 0, 0, 0);
  if (logEl?._flatpickr?.selectedDates?.length === 1) initialPick = logEl._flatpickr.selectedDates[0];
  else {
    const parsed = parseYmdFromStore(logEl?.value);
    if (parsed) initialPick = parsed;
  }
  attachFlatpickrDatetime(inp, initialPick);
  $("#modal-add-day-cancel")?.addEventListener("click", closeModal);
  $("#form-add-day-flow")?.addEventListener(
    "submit",
    (ev) => {
      ev.preventDefault();
      const dest = $("#log-datetime");
      const picked = inp?._flatpickr?.selectedDates?.[0];
      if (picked && dest?._flatpickr) dest._flatpickr.setDate(picked, false);
      else if (dest) {
        const s = (inp?.value || "").trim();
        if (dest._flatpickr) {
          if (s) dest._flatpickr.setDate(s, true, "Y-m-d");
          else dest._flatpickr.clear();
        } else dest.value = s;
      }
      closeModal();
      $("#panel-search")?.scrollIntoView({ behavior: "smooth", block: "start" });
      $("#food-q")?.focus();
      hideBanner();
      showBanner("Đã đặt ngày — chọn món và ghi nhật ký.", "ok");
    },
    { once: true }
  );
}

function stripVi(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Gom vào cột Sáng / Trưa / Tối / Khác theo nhãn bữa; nếu trống thì gợi ý theo giờ ghi nhật ký. */
function mealSlotFromLabel(label, loggedAt) {
  const a = stripVi(label);
  if (a) {
    if (a.includes("trua") || a.includes("lunch")) return "trua";
    if (a.includes("toi") || a.includes("dem") || a.includes("dinner") || a.includes("supper")) return "toi";
    if (a.includes("sang") || a.includes("breakfast")) return "sang";
    if (a.includes("khac") || a.includes("other") || a.includes("phu") || a.includes("snack")) return "khac";
  }
  if (loggedAt) {
    const t = String(loggedAt).match(/\s(\d{1,2}):(\d{2}):/);
    if (t) {
      const h = parseInt(t[1], 10);
      if (h >= 4 && h < 11) return "sang";
      if (h >= 11 && h < 15) return "trua";
      if (h >= 15 && h < 23) return "toi";
    }
  }
  return "khac";
}

/** Map nhãn đã lưu (text tự do) → giá trị option select chuẩn. */
function mealLabelToSelectValue(label) {
  const t = String(label || "").trim();
  if (!t) return "";
  const slot = mealSlotFromLabel(t, null);
  return { sang: "Sáng", trua: "Trưa", toi: "Tối", khac: "Khác" }[slot] || "";
}

const MEAL_SELECT_OPTIONS_HTML = `
<option value="">— Chọn —</option>
<option value="Sáng">Sáng</option>
<option value="Trưa">Trưa</option>
<option value="Tối">Tối</option>
<option value="Khác">Khác</option>`;

function logDateKey(loggedAt) {
  const s = String(loggedAt || "");
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s.slice(0, 10);
}

function formatDateVN(isoYmd) {
  const p = String(isoYmd).split("-");
  if (p.length !== 3) return isoYmd;
  return `${p[2]}/${p[1]}/${p[0]}`;
}

/** Nhãn bữa khi bấm + trong ô Sáng/Trưa/Tối/Khác (ngày = ngày dòng bảng). */
const SLOT_QUICK_ADD = {
  sang: { label: "Sáng", title: "Thêm món buổi sáng" },
  trua: { label: "Trưa", title: "Thêm món buổi trưa" },
  toi: { label: "Tối", title: "Thêm món buổi tối" },
  khac: { label: "Khác", title: "Thêm món (bữa khác / snack)" },
};

/** Đặt sẵn ngày + bữa, mở form tìm món để ghi thêm vào đúng ô bảng. */
function beginLogFromSlot(dayIso, slotKey) {
  const cfg = SLOT_QUICK_ADD[slotKey];
  if (!cfg || !dayIso) return;
  const dtEl = $("#log-datetime");
  const form = $("#form-log");
  const mealInp = form?.querySelector('[name="meal_label"]');
  const when = dateAtYmdNoon(dayIso);
  if (dtEl) {
    if (dtEl._flatpickr) dtEl._flatpickr.setDate(when, false);
    else dtEl.value = dayIso;
  }
  if (mealInp) mealInp.value = cfg.label;

  selectedFood = null;
  const ul = $("#food-results");
  if (ul) ul.innerHTML = "";
  $("#food-detail")?.classList.add("hidden");
  form?.classList.add("hidden");
  const hid = $("#log-food-id");
  if (hid) hid.value = "";

  $("#panel-search")?.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#food-q")?.focus();
  hideBanner();
  showBanner(`${cfg.title} (${formatDateVN(dayIso)}) — chọn món bên dưới.`, "ok");
}

function renderMealCell(items, dayIso, slotKey) {
  const cfg = SLOT_QUICK_ADD[slotKey];
  const titleAttr = cfg ? escapeHtml(cfg.title) : "";
  const addBtn = `<button type="button" class="slot-add" data-log-day="${escapeHtml(dayIso)}" data-log-slot="${escapeHtml(slotKey)}" title="${titleAttr}" aria-label="${titleAttr}">+</button>`;
  const head = `<div class="col-meal-head">${!items?.length ? `<span class="cell-empty-inline">—</span>` : ""}${addBtn}</div>`;

  if (!items || !items.length) {
    return `<td class="col-meal">${head}</td>`;
  }
  const sum = items.reduce((acc, x) => acc + Number(x.calories || 0), 0);
  const lines = items
    .map(
      (l) => `
    <div class="slot-entry">
      <div class="slot-line">
        <span class="slot-food" title="${escapeHtml(l.food_description)}">${escapeHtml(l.food_description)}</span>
        <span class="slot-meta">${l.grams}g · ${l.calories} kcal</span>
        <button type="button" class="slot-del" data-log-id="${l.id}" title="Xóa">×</button>
      </div>
      <div class="slot-actions">
        <button type="button" class="slot-link" data-log-action="detail" data-log-id="${l.id}">Chi tiết</button>
        <button type="button" class="slot-link" data-log-action="edit" data-log-id="${l.id}">Sửa</button>
      </div>
    </div>`
    )
    .join("");
  return `<td class="col-meal">
    ${head}
    <div class="slot-total">${Math.round(sum * 10) / 10} <span class="unit">kcal</span></div>
    <div class="slot-items">${lines}</div>
  </td>`;
}

const DAY_OVERVIEW_SLOTS = [
  { key: "sang", title: "Sáng" },
  { key: "trua", title: "Trưa" },
  { key: "toi", title: "Tối" },
  { key: "khac", title: "Khác" },
];

/** Cùng màu / nhãn với gợi ý tuần — calo theo bữa + pie macro. */
const DAY_OVERVIEW_MEAL_LABELS = ["Bữa sáng", "Bữa trưa", "Bữa tối", "Phụ / snack"];
const DAY_OVERVIEW_MEAL_COLORS = ["#5eb8ff", "#7cdbb0", "#e8a838", "#ff7b7b"];
const DAY_MACRO_PIE_LABELS = ["Đạm (P)", "Carb (C)", "Béo (F)"];
const DAY_MACRO_PIE_COLORS = ["#7cdbb0", "#5eb8ff", "#e8a838"];

function renderDayOverviewCharts(dayIso, items) {
  destroyDayOverviewCharts();
  if (typeof Chart === "undefined") return;
  const barCanvas = $("#day-overview-bar");
  const pieCanvas = $("#day-overview-pie");
  if (!barCanvas || !pieCanvas) return;

  const slotKeys = ["sang", "trua", "toi", "khac"];
  const calBySlot = slotKeys.map((sk) =>
    items
      .filter((l) => mealSlotFromLabel(l.meal_label, l.logged_at) === sk)
      .reduce((a, l) => a + Number(l.calories || 0), 0)
  );
  const labelDay = formatDateVN(dayIso);

  const barDatasets = DAY_OVERVIEW_MEAL_LABELS.map((mealLabel, idx) => ({
    label: mealLabel,
    data: [calBySlot[idx]],
    backgroundColor: DAY_OVERVIEW_MEAL_COLORS[idx],
    borderColor: DAY_OVERVIEW_MEAL_COLORS[idx],
    borderWidth: 1,
    stack: "meals",
  }));

  dayOverviewBarChart = new Chart(barCanvas.getContext("2d"), {
    type: "bar",
    data: { labels: [labelDay], datasets: barDatasets },
    options: baseChartOptions({
      scales: {
        x: { stacked: true, grid: { color: "#2d3a4f" }, ticks: { color: "#e8edf4" } },
        y: { stacked: true, beginAtZero: true, grid: { color: "#2d3a4f" }, ticks: { color: "#e8edf4" } },
      },
      plugins: {
        legend: { labels: { color: "#e8edf4" } },
        tooltip: {
          callbacks: {
            footer: (items) => {
              const sum = items.reduce((a, it) => a + (Number(it.parsed.y) || 0), 0);
              return `Tổng: ${Math.round(sum * 10) / 10} kcal`;
            },
          },
        },
      },
    }),
  });

  const sumP = items.reduce((a, l) => a + Number(l.protein || 0), 0);
  const sumC = items.reduce((a, l) => a + Number(l.carb || 0), 0);
  const sumF = items.reduce((a, l) => a + Number(l.fat || 0), 0);
  const pk = sumP * 4;
  const ck = sumC * 4;
  const fk = sumF * 9;

  if (pk + ck + fk < 0.0001) {
    dayOverviewPieChart = new Chart(pieCanvas.getContext("2d"), {
      type: "pie",
      data: {
        labels: ["Chưa có macro (g)"],
        datasets: [{ data: [1], backgroundColor: ["#3d4f66"] }],
      },
      options: baseChartOptions({
        plugins: {
          legend: { labels: { color: "#e8edf4" } },
          tooltip: { enabled: false },
        },
      }),
    });
  } else {
    dayOverviewPieChart = new Chart(pieCanvas.getContext("2d"), {
      type: "pie",
      data: {
        labels: DAY_MACRO_PIE_LABELS,
        datasets: [{ data: [pk, ck, fk], backgroundColor: DAY_MACRO_PIE_COLORS }],
      },
      options: baseChartOptions({
        plugins: {
          legend: { labels: { color: "#e8edf4" } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const val = ctx.raw ?? 0;
                return `${ctx.label}: ${Math.round(val)} kcal`;
              },
            },
          },
        },
      }),
    });
  }

  scheduleChartsReflow();
}

function openDayOverviewModal(dayIso) {
  const items = cachedLogsList.filter((l) => logDateKey(l.logged_at) === dayIso);
  if (!items.length) {
    showBanner("Không có dữ liệu nhật ký cho ngày này — hãy tải lại bảng.", "error");
    return;
  }
  const totalCal = items.reduce((a, l) => a + Number(l.calories || 0), 0);
  const sumP = items.reduce((a, l) => a + Number(l.protein || 0), 0);
  const sumC = items.reduce((a, l) => a + Number(l.carb || 0), 0);
  const sumF = items.reduce((a, l) => a + Number(l.fat || 0), 0);
  const kP = sumP * 4;
  const kC = sumC * 4;
  const kF = sumF * 9;
  const denom = totalCal > 0 ? totalCal : kP + kC + kF;
  const pct = (k) => (denom > 0 ? Math.round((k / denom) * 1000) / 10 : 0);

  const g = { sang: [], trua: [], toi: [], khac: [] };
  for (const l of items) {
    g[mealSlotFromLabel(l.meal_label, l.logged_at)].push(l);
  }

  let mealsHtml = "";
  for (const { key, title } of DAY_OVERVIEW_SLOTS) {
    const arr = g[key];
    if (!arr.length) continue;
    const lines = arr
      .map(
        (x) =>
          `<li><strong>${escapeHtml(x.food_description)}</strong> — ${escapeHtml(String(x.grams))}g · ${escapeHtml(String(x.calories))} kcal <span class="muted-inline">(P ${escapeHtml(String(x.protein))}g · C ${escapeHtml(String(x.carb))}g · F ${escapeHtml(String(x.fat))}g)</span></li>`
      )
      .join("");
    mealsHtml += `<h4 class="day-meal-block-title">${escapeHtml(title)}</h4><ul class="day-meal-items">${lines}</ul>`;
  }

  const headTitle = `Chi tiết ${formatDateVN(dayIso)}`;
  openModal(`
    <div class="day-overview-modal-inner">
    <h2 id="modal-title">${escapeHtml(headTitle)}</h2>
    <div class="day-overview-charts-row">
      <div class="day-overview-chart-cell">
        <p class="day-chart-caption">Calo theo bữa (cột xếp chồng)</p>
        <div class="chart-wrap day-overview-chart-wrap"><canvas id="day-overview-bar"></canvas></div>
      </div>
      <div class="day-overview-chart-cell">
        <p class="day-chart-caption">Macro (pie) — kcal từ đạm / carb / béo</p>
        <div class="chart-wrap day-overview-chart-wrap day-overview-pie-wrap"><canvas id="day-overview-pie"></canvas></div>
      </div>
    </div>
    <section class="day-overview-section">
      <h3 class="day-overview-h3">Macro trong ngày (số liệu)</h3>
      <dl class="modal-dl">
        <dt>Tổng năng lượng</dt><dd><strong>${escapeHtml(String(Math.round(totalCal * 10) / 10))}</strong> kcal</dd>
        <dt>Đạm</dt><dd>${escapeHtml(String(Math.round(sumP * 1000) / 1000))} g → ~${escapeHtml(String(Math.round(kP)))} kcal (${escapeHtml(String(pct(kP)))}% so với tổng kcal ngày)</dd>
        <dt>Carb</dt><dd>${escapeHtml(String(Math.round(sumC * 1000) / 1000))} g → ~${escapeHtml(String(Math.round(kC)))} kcal (${escapeHtml(String(pct(kC)))}%)</dd>
        <dt>Béo</dt><dd>${escapeHtml(String(Math.round(sumF * 1000) / 1000))} g → ~${escapeHtml(String(Math.round(kF)))} kcal (${escapeHtml(String(pct(kF)))}%)</dd>
      </dl>
      <p class="hint day-overview-hint">% ước tính theo tổng kcal nhật ký (4 kcal/g đạm &amp; carb, 9 kcal/g béo).</p>
    </section>
    <section class="day-overview-section">
      <h3 class="day-overview-h3">Món đã ăn trong ngày</h3>
      ${mealsHtml}
    </section>
    </div>
  `);
  requestAnimationFrame(() => renderDayOverviewCharts(dayIso, items));
}

async function loadLogs() {
  const data = await api("/api/log");
  const box = $("#logs-list");
  const logs = data.logs || [];
  cachedLogsList = logs;
  if (!logs.length) {
    box.innerHTML = `<p class="hint" style="margin:1rem">Chưa có nhật ký ăn uống.</p>`;
    return;
  }

  const byDate = new Map();
  for (const l of logs) {
    const day = logDateKey(l.logged_at);
    if (!byDate.has(day)) {
      byDate.set(day, { sang: [], trua: [], toi: [], khac: [] });
    }
    const slot = mealSlotFromLabel(l.meal_label, l.logged_at);
    byDate.get(day)[slot].push(l);
  }

  const dates = [...byDate.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  const thead = `<thead><tr>
    <th class="col-date">Ngày</th>
    <th class="col-day-overview">Chi tiết</th>
    <th class="col-meal">Sáng</th>
    <th class="col-meal">Trưa</th>
    <th class="col-meal">Tối</th>
    <th class="col-meal">Khác</th>
    <th class="col-total">Tổng / ngày</th>
  </tr></thead>`;

  const rows = dates.map((day) => {
    const g = byDate.get(day);
    const total =
      [...g.sang, ...g.trua, ...g.toi, ...g.khac].reduce((acc, x) => acc + Number(x.calories || 0), 0);
    return `<tr>
      <td class="col-date">${formatDateVN(day)}</td>
      <td class="col-day-overview">
        <button type="button" class="day-detail-btn" data-day="${escapeHtml(day)}" title="Xem macro và danh sách món">Macro &amp; món</button>
      </td>
      ${renderMealCell(g.sang, day, "sang")}
      ${renderMealCell(g.trua, day, "trua")}
      ${renderMealCell(g.toi, day, "toi")}
      ${renderMealCell(g.khac, day, "khac")}
      <td class="col-total">${Math.round(total * 10) / 10} kcal</td>
    </tr>`;
  });

  box.innerHTML = `<table class="logs-table" id="logs-data-table">${thead}<tbody>${rows.join("")}</tbody></table>`;
}

/** Dữ liệu minh họa (bịa cố định) — chỉ dùng khi chưa có nhật ký, để biểu đồ vẫn hiện */
function mockDailyCalories(numDays) {
  const pattern = [1840, 1720, 1960, 1885, 1650, 2010, 1790, 1920, 1755, 1980];
  const labels = [];
  const values = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const n = Math.min(Math.max(1, numDays), 90);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    labels.push(d.toISOString().slice(0, 10));
    values.push(pattern[(n - 1 - i) % pattern.length]);
  }
  return { labels, values };
}

async function loadChart() {
  const days = parseInt($("#chart-days").value, 10) || 14;
  const data = await api(`/api/analytics/daily?days=${days}`);
  const caption = $("#chart-caption");
  let labels;
  let values;
  let isMock = false;
  if (data.series && data.series.length > 0) {
    labels = data.series.map((r) => r.d);
    values = data.series.map((r) => r.calories);
    if (caption) {
      caption.textContent = "Đang hiển thị calo tổng theo ngày từ nhật ký của bạn.";
      caption.classList.remove("mock");
    }
  } else {
    const m = mockDailyCalories(days);
    labels = m.labels;
    values = m.values;
    isMock = true;
    if (caption) {
      caption.textContent =
        "Đường màu cam: dữ liệu ví dụ (minh họa). Khi bạn ghi nhật ký ăn, biểu đồ sẽ hiển thị số liệu thật.";
      caption.classList.add("mock");
    }
  }

  const ctx = $("#chart-daily").getContext("2d");
  if (chartDaily) chartDaily.destroy();
  chartDaily = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: isMock ? "Calo/ngày (ví dụ minh họa)" : "Calo (kcal)",
          data: values,
          borderColor: isMock ? "#e8a838" : "#5eb8ff",
          backgroundColor: isMock ? "rgba(232,168,56,0.18)" : "rgba(94,184,255,0.15)",
          fill: true,
          tension: 0.25,
        },
      ],
    },
    options: baseChartOptions({
      scales: {
        y: { beginAtZero: true, grid: { color: "#2d3a4f" } },
        x: { grid: { color: "#2d3a4f" } },
      },
      plugins: { legend: { labels: { color: "#e8edf4" } } },
    }),
  });
  scheduleChartsReflow();
}

function fmtMacro(mt) {
  if (!mt) return "";
  return `P ${mt.protein_g}g · C ${mt.carb_g}g · F ${mt.fat_g}g`;
}

function fmtSuggestion(s) {
  const p = s.portion || {};
  const per100 = `per 100g: ${s.kcal_per_100g} kcal; P ${s.protein}g, C ${s.carb}g, F ${s.fat}g`;
  const portion = `~${s.suggested_grams}g → ~${p.calories} kcal; P ${p.protein_g}g, C ${p.carb_g}g, F ${p.fat_g}g (xơ ${p.fiber_g}g)`;
  return `<div class="suggestion-item"><strong>${s.description}</strong><br/><span class="macro-detail">${per100}</span><br/><span class="macro-portion">${portion}</span></div>`;
}

const WEEK_MEAL_LABELS = ["Bữa sáng", "Bữa trưa", "Bữa tối", "Phụ / snack"];
const WEEK_MEAL_COLORS = ["#5eb8ff", "#7cdbb0", "#e8a838", "#ff7b7b"];

function destroyChartIfAny(ch) {
  if (ch) ch.destroy();
}

function destroyDayOverviewCharts() {
  destroyChartIfAny(dayOverviewBarChart);
  dayOverviewBarChart = null;
  destroyChartIfAny(dayOverviewPieChart);
  dayOverviewPieChart = null;
}

function destroyLogsWeekCharts() {
  destroyChartIfAny(logsWeekBarChart);
  logsWeekBarChart = null;
  destroyChartIfAny(logsWeekPieChart);
  logsWeekPieChart = null;
  logsWeekConsumptionData = null;
}

function renderWeekCaloriesBar(data) {
  const labels = data.days.map((d) => d.day_index);
  const byDay = new Map(data.days.map((d) => [d.day_index, d]));

  const datasets = WEEK_MEAL_LABELS.map((mealLabel, idx) => {
    const values = labels.map((di) => {
      const day = byDay.get(di);
      const m = (day?.meals || []).find((x) => x.label === mealLabel);
      return m ? m.target_calories : 0;
    });
    return {
      label: mealLabel,
      data: values,
      backgroundColor: WEEK_MEAL_COLORS[idx],
      borderColor: WEEK_MEAL_COLORS[idx],
      borderWidth: 1,
      stack: "meals",
    };
  });

  const ctx = $("#week-chart-calories").getContext("2d");
  destroyChartIfAny(weekCaloriesChart);
  weekCaloriesChart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: baseChartOptions({
      scales: {
        x: { stacked: true, grid: { color: "#2d3a4f" }, ticks: { color: "#e8edf4" } },
        y: { stacked: true, beginAtZero: true, grid: { color: "#2d3a4f" }, ticks: { color: "#e8edf4" } },
      },
      plugins: {
        legend: { labels: { color: "#e8edf4" } },
        tooltip: { enabled: true },
      },
    }),
  });
}

function renderWeekMacroPie(dayIndex) {
  const data = currentWeekData;
  if (!data) return;
  const day = (data.days || []).find((d) => d.day_index === dayIndex);
  if (!day || !day.daily_macro_target) return;

  const macro = day.daily_macro_target;
  const labels = ["Đạm (P)", "Carb (C)", "Béo (F)"];
  const values = [macro.protein_kcal, macro.carb_kcal, macro.fat_kcal];
  const colors = ["#7cdbb0", "#5eb8ff", "#e8a838"];

  const ctx = $("#week-chart-macro").getContext("2d");
  destroyChartIfAny(weekMacroPieChart);
  weekMacroPieChart = new Chart(ctx, {
      type: "pie",
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: colors,
          },
        ],
      },
    options: baseChartOptions({
      plugins: {
        legend: { labels: { color: "#e8edf4" } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const val = ctx.raw ?? 0;
              return `${ctx.label}: ${Math.round(val)} kcal`;
            },
          },
        },
      },
    }),
  });
}

function renderLogsWeekConsumptionPie() {
  const data = logsWeekConsumptionData;
  if (!data || typeof Chart === "undefined") return;
  const days = data.days || [];
  const canvas = $("#logs-week-pie");
  if (!canvas || !days.length) return;
  let sumP = 0;
  let sumC = 0;
  let sumF = 0;
  for (const d of days) {
    sumP += Number(d.protein_g || 0);
    sumC += Number(d.carb_g || 0);
    sumF += Number(d.fat_g || 0);
  }
  const pk = sumP * 4;
  const ck = sumC * 4;
  const fk = sumF * 9;
  const labels = ["Đạm (P)", "Carb (C)", "Béo (F)"];
  const colors = ["#7cdbb0", "#5eb8ff", "#e8a838"];

  destroyChartIfAny(logsWeekPieChart);
  if (pk + ck + fk < 0.0001) {
    logsWeekPieChart = new Chart(canvas.getContext("2d"), {
      type: "pie",
      data: {
        labels: ["Chưa có macro"],
        datasets: [{ data: [1], backgroundColor: ["#3d4f66"] }],
      },
      options: baseChartOptions({
        plugins: {
          legend: { labels: { color: "#e8edf4" } },
          tooltip: { enabled: false },
        },
      }),
    });
  } else {
    logsWeekPieChart = new Chart(canvas.getContext("2d"), {
      type: "pie",
      data: {
        labels,
        datasets: [{ data: [pk, ck, fk], backgroundColor: colors }],
      },
      options: baseChartOptions({
        plugins: {
          legend: { labels: { color: "#e8edf4" } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.label}: ${Math.round(ctx.raw ?? 0)} kcal (tổng 7 ngày)`,
            },
          },
        },
      }),
    });
  }
}

async function loadLogsWeekConsumption() {
  const emptyEl = $("#logs-week-charts-empty");
  const rowEl = $("#logs-week-charts-row");
  if (!rowEl) return;
  destroyLogsWeekCharts();
  try {
    const data = await api("/api/analytics/meals_week?days=7");
    const days = data.days || [];
    logsWeekConsumptionData = data;
    if (!days.length) {
      if (emptyEl) {
        emptyEl.classList.remove("hidden");
        emptyEl.textContent = "Chưa có dữ liệu trong 7 ngày này.";
      }
      rowEl.classList.add("hidden");
      return;
    }
    if (emptyEl) emptyEl.classList.add("hidden");
    rowEl.classList.remove("hidden");

    const labels = days.map((x) => String(x.day_index));
    const slotKeys = ["sang", "trua", "toi", "khac"];
    const datasets = WEEK_MEAL_LABELS.map((mealLabel, idx) => ({
      label: mealLabel,
      data: days.map((di) => Number(di.meals_kcal[slotKeys[idx]] ?? 0)),
      backgroundColor: WEEK_MEAL_COLORS[idx],
      borderColor: WEEK_MEAL_COLORS[idx],
      borderWidth: 1,
      stack: "meals",
    }));

    const ctxBar = $("#logs-week-bar").getContext("2d");
    logsWeekBarChart = new Chart(ctxBar, {
      type: "bar",
      data: { labels, datasets },
      options: baseChartOptions({
        scales: {
          x: { stacked: true, grid: { color: "#2d3a4f" }, ticks: { color: "#e8edf4" } },
          y: { stacked: true, beginAtZero: true, grid: { color: "#2d3a4f" }, ticks: { color: "#e8edf4" } },
        },
        plugins: {
          legend: { labels: { color: "#e8edf4" } },
          tooltip: {
            callbacks: {
              title: (items) => {
                const i = items[0]?.dataIndex;
                if (i == null || !days[i]) return "";
                return `Ngày ${days[i].day_index} (${days[i].label_vn})`;
              },
            },
          },
        },
      }),
    });

    const rangeEl = $("#logs-week-macro-range");
    if (rangeEl) {
      rangeEl.textContent = `${days[0].label_vn} → ${days[days.length - 1].label_vn}`;
    }

    renderLogsWeekConsumptionPie();
    scheduleChartsReflow();
  } catch (e) {
    destroyLogsWeekCharts();
    if (emptyEl) {
      emptyEl.classList.remove("hidden");
      emptyEl.textContent = "Không tải được dữ liệu 7 ngày.";
    }
    rowEl.classList.add("hidden");
  }
}

async function loadWeek() {
  hideBanner();
  try {
    const data = await api("/api/suggest/week");
    currentWeekData = data;

    const chartsWrap = $("#week-charts-wrap");
    if (chartsWrap) chartsWrap.classList.remove("hidden");

    // Fill select day options (1..7) for macro pie
    const pieSel = $("#week-pie-day");
    if (pieSel) {
      pieSel.innerHTML = "";
      data.days
        .slice()
        .sort((a, b) => a.day_index - b.day_index)
        .forEach((d) => {
          const opt = document.createElement("option");
          opt.value = String(d.day_index);
          opt.textContent = `Ngày ${d.day_index}`;
          pieSel.appendChild(opt);
        });
      if (!pieSel.value) pieSel.value = "1";
    }

    // Bind once: when user changes selected day, update macro pie
    if (!weekPieBound) {
      const pieSelEl = $("#week-pie-day");
      if (pieSelEl) {
        pieSelEl.addEventListener("change", () => {
          const v = parseInt(pieSelEl.value, 10) || 1;
          renderWeekMacroPie(v);
          scheduleChartsReflow();
        });
      }
      weekPieBound = true;
    }

    // Render charts
    renderWeekCaloriesBar(data);
    renderWeekMacroPie(parseInt($("#week-pie-day").value, 10) || 1);
    scheduleChartsReflow();

    const box = $("#week-plan");
    box.innerHTML = `
      <div class="week-summary card">
        <p>TDEE: <strong>${data.tdee}</strong> kcal · Mục tiêu nạp: <strong>${data.daily_intake_target}</strong> kcal/ngày</p>
        <p class="hint">${data.macro_note || ""}</p>
        <p class="hint">${data.note || ""}</p>
      </div>
    `;
    data.days.forEach((day) => {
      const d = document.createElement("div");
      d.className = "day";
      const dm = day.daily_macro_target;
      d.innerHTML = `<h4>Ngày ${day.day_index}</h4>
        <p class="day-macro">Cả ngày ~<strong>${day.daily_calorie_target}</strong> kcal —
          mục tiêu macro: <span class="macro-pills">${fmtMacro(dm)}</span>
        </p>`;
      day.meals.forEach((m) => {
        const mEl = document.createElement("div");
        mEl.className = "meal";
        const mm = m.macro_target;
        const ideas = (m.suggestions || []).map(fmtSuggestion).join("") || "<small>—</small>";
        mEl.innerHTML = `
          <div class="meal-head">
            <strong>${m.label}</strong>
            <span class="meal-kcal">~${m.target_calories} kcal (${Math.round((m.calorie_share || 0) * 100)}% calo ngày)</span>
          </div>
          <p class="meal-macro macro-pills">Macro mục tiêu bữa: ${fmtMacro(mm)}
            <span class="hint-inline">(~${mm?.protein_kcal} / ${mm?.carb_kcal} / ${mm?.fat_kcal} kcal từ P / C / F)</span>
          </p>
          <div class="suggestions">${ideas}</div>
        `;
        d.appendChild(mEl);
      });
      box.appendChild(d);
    });
  } catch (e) {
    showBanner(e.message || "Không tạo được gợi ý — kiểm tra hồ sơ.", "error");
  }
}

async function saveProfile(ev) {
  ev.preventDefault();
  const f = ev.target;
  const sex = f.sex.value === "nam" ? "male" : "female";
  const body = {
    age: parseInt(f.age.value, 10) || null,
    sex,
    height_cm: parseFloat(f.height_cm.value) || null,
    weight_kg: parseFloat(f.weight_kg.value) || null,
    activity_level: parseInt(f.activity_level.value, 10),
    target_weight_kg: parseFloat(f.target_weight_kg.value) || null,
    calorie_deficit: parseInt(f.calorie_deficit.value, 10) || 0,
  };
  await api("/api/profile", { method: "PUT", body: JSON.stringify(body) });
  showBanner("Đã lưu hồ sơ.", "ok");
  await refreshMe();
}

let authMode = "login";

function setAuthMode(mode) {
  authMode = mode === "register" ? "register" : "login";
  const title = $("#auth-title");
  const sub = $("#auth-subtitle");
  const btn = $("#auth-submit-btn");
  const sw = $("#auth-switch-mode");
  const pw = $("#auth-password");
  if (!title || !sub || !btn || !sw) return;
  if (authMode === "login") {
    title.textContent = "Đăng nhập";
    sub.textContent = "Chào mừng trở lại — nhập tài khoản để tiếp tục.";
    btn.textContent = "ĐĂNG NHẬP";
    sw.innerHTML = "Chưa có tài khoản? <strong>Tạo tài khoản</strong> →";
    if (pw) pw.setAttribute("autocomplete", "current-password");
  } else {
    title.textContent = "Đăng ký";
    sub.textContent = "Tạo tài khoản mới để lưu hồ sơ, nhật ký ăn uống và gợi ý tuần.";
    btn.textContent = "ĐĂNG KÝ";
    sw.innerHTML = "Đã có tài khoản? <strong>Đăng nhập</strong> →";
    if (pw) pw.setAttribute("autocomplete", "new-password");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof Chart !== "undefined") {
    Chart.defaults.font.family = "'Segoe UI', system-ui, -apple-system, sans-serif";
    Chart.defaults.color = "#e8edf4";
  }

  initModal();

  $("#logs-list")?.addEventListener("click", async (e) => {
    const dayDetail = e.target.closest(".day-detail-btn");
    if (dayDetail) {
      e.preventDefault();
      const day = dayDetail.getAttribute("data-day");
      if (day) openDayOverviewModal(day);
      return;
    }
    const addSlot = e.target.closest(".slot-add");
    if (addSlot) {
      e.preventDefault();
      const day = addSlot.getAttribute("data-log-day");
      const slot = addSlot.getAttribute("data-log-slot");
      if (day && slot) beginLogFromSlot(day, slot);
      return;
    }
    const del = e.target.closest(".slot-del");
    if (del) {
      e.preventDefault();
      const id = del.getAttribute("data-log-id");
      if (!id) return;
      try {
        await api(`/api/log/${id}`, { method: "DELETE" });
        await loadLogs();
        await loadChart();
        await loadLogsWeekConsumption();
      } catch (err) {
        showBanner(err.message, "error");
      }
      return;
    }
    const act = e.target.closest("[data-log-action]");
    if (!act) return;
    const id = act.getAttribute("data-log-id");
    const action = act.getAttribute("data-log-action");
    if (!id) return;
    try {
      if (action === "detail") await openLogDetail(id);
      else if (action === "edit") await openLogEdit(id);
    } catch (err) {
      showBanner(err.message, "error");
    }
  });

  $("#btn-add-day-log")?.addEventListener("click", () => openAddDayFlow());
  $("#btn-log-datetime-clear")?.addEventListener("click", () => {
    const el = $("#log-datetime");
    if (!el) return;
    if (el._flatpickr) el._flatpickr.clear();
    else el.value = "";
  });

  attachFlatpickrDatetime($("#log-datetime"), null);

  window.addEventListener("resize", () => {
    clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(resizeAllCharts, 120);
  });

  setAuthMode("login");
  const switchBtn = $("#auth-switch-mode");
  if (switchBtn) {
    switchBtn.addEventListener("click", () => {
      setAuthMode(authMode === "login" ? "register" : "login");
    });
  }
  const forgotBtn = $("#auth-forgot-btn");
  if (forgotBtn) {
    forgotBtn.addEventListener("click", () => {
      showBanner("Demo: quên mật khẩu chưa được triển khai.", "ok");
    });
  }

  const formAuth = $("#form-auth");
  if (formAuth) {
    formAuth.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const username = (fd.get("username") || "").trim();
      const password = fd.get("password") || "";
      if (authMode === "register") {
        if (username.length < 3) {
          showBanner("Username cần ít nhất 3 ký tự.", "error");
          return;
        }
        if (password.length < 4) {
          showBanner("Mật khẩu cần ít nhất 4 ký tự.", "error");
          return;
        }
      }
      try {
        if (authMode === "register") {
          await api("/api/register", {
            method: "POST",
            body: JSON.stringify({ username, password }),
          });
          await refreshMe();
          showBanner("Đăng ký thành công.", "ok");
        } else {
          await api("/api/login", {
            method: "POST",
            body: JSON.stringify({ username, password }),
          });
          await refreshMe();
          showBanner("Đăng nhập thành công.", "ok");
        }
      } catch (e) {
        showBanner(e.data?.error || e.message, "error");
      }
    });
  }

  $("#form-profile").addEventListener("submit", saveProfile);
  $("#btn-search").addEventListener("click", () => searchFoods().catch((e) => showBanner(e.message, "error")));
  $("#food-q").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      searchFoods().catch((e) => showBanner(e.message, "error"));
    }
  });
  $("#form-log").addEventListener("submit", (ev) => submitLog(ev).catch((e) => showBanner(e.message, "error")));
  $("#chart-days").addEventListener("change", () => loadChart().catch(() => {}));
  $("#btn-week").addEventListener("click", () => loadWeek());

  refreshMe().catch(console.error);
});
