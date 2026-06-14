import { initializeApp }          from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, addDoc, getDocs,
  deleteDoc, doc, updateDoc, query, where, getDoc, setDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ================================================================
// Toast 通知ユーティリティ (Firebase初期化エラー表示でも使うため最上部に配置)
// ================================================================
function showToast(msg, type = "info", durationMs = 3500) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  const remove = () => {
    toast.classList.add("exit");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  };
  const t = setTimeout(remove, durationMs);
  toast.addEventListener("click", () => { clearTimeout(t); remove(); });
}

// ================================================================
// Firebase 初期化 (環境変数 / config.js / Hosting予約済みURL から取得)
// ================================================================
let firebaseConfig;
try {
  // 1. ローカルの config.js の読み込みを試みる
  const configModule = await import("./config.js");
  firebaseConfig = configModule.firebaseConfig;
} catch (e) {
  // 2. config.js がない場合は Firebase Hosting の予約済みURLから取得を試みる
  try {
    const response = await fetch("/__/firebase/init.json");
    firebaseConfig = await response.json();
  } catch (err) {
    console.error("Firebase configuration could not be loaded.", err);
  }
}

let app, db, auth;
if (firebaseConfig) {
  try {
    app  = initializeApp(firebaseConfig);
    db   = getFirestore(app);
    auth = getAuth(app);
  } catch (e) {
    console.error("Firebase initialization failed.", e);
    showToast("Firebaseの初期化に失敗しました。設定を確認してください。", "error", 10000);
  }
} else {
  console.warn("Firebase config is missing. App might not function properly.");
  setTimeout(() => {
    showToast("Firebase設定が見つかりません。config.jsを作成するか、Hosting環境で実行してください。", "warning", 10000);
  }, 1000);
}

// ================================================================
// 状態管理
// ================================================================
let xp        = 0;
let level     = 1;
let streak    = 0;
let lastLogin = null;   // ISO date string  e.g. "2026-06-10"
let badges    = [];
let bestLevel = 1;
let currentUser = null; // Firebase User オブジェクト

// ================================================================
// 紙吹雪アニメーション
// ================================================================
function launchConfetti() {
  const container = document.getElementById("confetti-container");
  if (!container) return;
  const colors = ["#6c63ff","#00d4aa","#ffb347","#ff5e6c","#fff"];
  for (let i = 0; i < 80; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left           = `${Math.random() * 100}vw`;
    piece.style.background     = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = `${1.5 + Math.random() * 2}s`;
    piece.style.animationDelay    = `${Math.random() * 0.8}s`;
    piece.style.transform      = `rotate(${Math.random() * 360}deg)`;
    piece.style.width          = `${6 + Math.random() * 8}px`;
    piece.style.height         = `${8 + Math.random() * 10}px`;
    container.appendChild(piece);
    piece.addEventListener("animationend", () => piece.remove(), { once: true });
  }
}

// ================================================================
// ユーティリティ
// ================================================================
function getWeekNumber(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${weekNo}`;
}

// タイムゾーンバグの修正: UTCではなくローカル日付を返す
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getRemainingDays(dueDate) {
  const now = new Date();
  const end = new Date(dueDate);
  return Math.ceil((end - now) / (1000 * 60 * 60 * 24));
}

function createProgressBar(current, target, unit = "分") {
  const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;

  const wrap = document.createElement("div");
  wrap.className = "progress-wrap";

  const label = document.createElement("div");
  label.className = "progress-label";
  label.innerHTML = `<span>累計 ${current} / ${target} ${unit}</span><span class="pct">${pct}%</span>`;

  const bar = document.createElement("div");
  bar.className = "progress-bar";
  const inner = document.createElement("div");
  inner.className = "progress";
  inner.style.width = "0%";
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { inner.style.width = `${pct}%`; });
  });
  bar.appendChild(inner);

  wrap.appendChild(label);
  wrap.appendChild(bar);
  return wrap;
}

// ================================================================
// Firestore ヘルパー
// ================================================================
function userCollection(colName) {
  if (!db || !currentUser) return null;
  return collection(db, "users", currentUser.uid, colName);
}

// ================================================================
// 認証
// ================================================================
document.getElementById("tab-login")?.addEventListener("click", () => {
  switchAuthTab("login");
});
document.getElementById("tab-register")?.addEventListener("click", () => {
  switchAuthTab("register");
});

function switchAuthTab(mode) {
  const tabLogin    = document.getElementById("tab-login");
  const tabRegister = document.getElementById("tab-register");
  const panelLogin    = document.getElementById("panel-login");
  const panelRegister = document.getElementById("panel-register");
  if (!tabLogin) return;
  if (mode === "login") {
    tabLogin.classList.add("active");
    tabRegister.classList.remove("active");
    tabLogin.setAttribute("aria-selected", "true");
    tabRegister.setAttribute("aria-selected", "false");
    panelLogin.hidden    = false;
    panelRegister.hidden = true;
  } else {
    tabRegister.classList.add("active");
    tabLogin.classList.remove("active");
    tabRegister.setAttribute("aria-selected", "true");
    tabLogin.setAttribute("aria-selected", "false");
    panelRegister.hidden = false;
    panelLogin.hidden    = true;
  }
}

document.getElementById("registerBtn")?.addEventListener("click", async () => {
  if (!auth) { showToast("Firebaseが初期化されていません", "error"); return; }
  const email    = document.getElementById("email-register").value.trim();
  const password = document.getElementById("password-register").value;
  setAuthStatus("登録中...");
  try {
    await createUserWithEmailAndPassword(auth, email, password);
    showToast("🎉 登録完了！ようこそStudyQuestへ！", "success");
  } catch (e) {
    setAuthStatus("エラー: " + friendlyAuthError(e.code));
    showToast("登録に失敗しました: " + friendlyAuthError(e.code), "error");
  }
});

document.getElementById("loginBtn")?.addEventListener("click", async () => {
  if (!auth) { showToast("Firebaseが初期化されていません", "error"); return; }
  const email    = document.getElementById("email-login").value.trim();
  const password = document.getElementById("password-login").value;
  setAuthStatus("ログイン中...");
  try {
    await signInWithEmailAndPassword(auth, email, password);
    showToast("✅ ログインしました！", "success");
  } catch (e) {
    setAuthStatus("エラー: " + friendlyAuthError(e.code));
    showToast("ログインに失敗しました: " + friendlyAuthError(e.code), "error");
  }
});

document.getElementById("logoutBtn")?.addEventListener("click", async () => {
  if (!auth) return;
  try {
    await signOut(auth);
    showToast("ログアウトしました", "info");
  } catch (e) {
    console.error("Logout error:", e);
    showToast("ログアウトに失敗しました", "error");
  }
});

function setAuthStatus(msg) {
  const el = document.getElementById("authStatus");
  if (el) el.textContent = msg;
}

function friendlyAuthError(code) {
  const map = {
    "auth/user-not-found":      "メールアドレスが見つかりません",
    "auth/wrong-password":      "パスワードが間違っています",
    "auth/invalid-email":       "メールアドレスの形式が正しくありません",
    "auth/email-already-in-use":"このメールアドレスはすでに使用されています",
    "auth/weak-password":       "パスワードは6文字以上にしてください",
    "auth/too-many-requests":   "しばらく時間をおいてから試してください",
    "auth/invalid-credential":  "メールアドレスまたはパスワードが正しくありません",
  };
  return map[code] || code;
}

if (auth) {
  onAuthStateChanged(auth, async (user) => {
    const authContainer = document.getElementById("auth-container");
    const appContainer  = document.getElementById("app-container");
    if (!authContainer || !appContainer) return;

    if (user) {
      currentUser = user;
      authContainer.style.display = "none";
      appContainer.style.display  = "block";
      setAuthStatus("");

      await loadUserProgress();
      updateStreak();
      await saveUserProgress();
      updateUI();
      await loadGoals();
      await loadGlobalTasks();
      await resetDailyProgress();
      await resetWeeklyProgress();
    } else {
      currentUser = null;
      authContainer.style.display = "flex";
      appContainer.style.display  = "none";
    }
  });
}

// ================================================================
// ゲーミフィケーション状態管理
// ================================================================
async function loadUserProgress() {
  if (!db || !currentUser) return;
  try {
    const snap = await getDoc(doc(db, "users", currentUser.uid));
    if (snap.exists()) {
      const d = snap.data();
      xp        = d.xp        ?? 0;
      level     = d.level     ?? 1;
      streak    = d.streak    ?? 0;
      lastLogin = d.lastLogin ?? null;
      badges    = Array.isArray(d.badges) ? d.badges : [];
      bestLevel = d.bestLevel ?? 1;
    }
  } catch (e) {
    console.error("loadUserProgress error:", e);
  }
}

async function saveUserProgress() {
  if (!db || !currentUser) return;
  try {
    await setDoc(doc(db, "users", currentUser.uid), {
      xp, level, streak, lastLogin, badges, bestLevel
    }, { merge: true });
  } catch (e) {
    console.error("saveUserProgress error:", e);
  }
}

async function addXP(amount) {
  if (!currentUser) return;
  xp += amount;
  while (xp >= level * 100) {
    xp = xp - level * 100;
    level++;
    launchConfetti();
    showToast(`🎉 レベルアップ！ Lv.${level} に到達！`, "success", 5000);
  }
  if (level > bestLevel) {
    bestLevel = level;
    showToast(`🏆 新記録！ 最高レベル Lv.${bestLevel}！`, "success", 4000);
  }
  await checkBadges();
  await saveUserProgress();
  updateUI();
}

function updateStreak() {
  const today     = todayISO();
  const yesterday = new Date(Date.now() - 86400000);
  const y = yesterday.getFullYear();
  const m = String(yesterday.getMonth() + 1).padStart(2, '0');
  const d = String(yesterday.getDate()).padStart(2, '0');
  const yesterdayStr = `${y}-${m}-${d}`;

  if (lastLogin === today) return;
  if (lastLogin === yesterdayStr) {
    streak++;
  } else {
    streak = 1;
  }
  lastLogin = today;
}

async function checkBadges() {
  let changed = false;
  const add = (badge) => {
    if (!badges.includes(badge)) {
      badges.push(badge);
      showToast(`🏅 バッジ獲得: ${badge}`, "success", 4500);
      changed = true;
    }
  };
  if (streak >= 3)  add("🔥 3日連続ログイン");
  if (streak >= 7)  add("🔥 1週間連続達成");
  if (streak >= 30) add("⚡ 1ヶ月連続達成");
  if (level >= 3)   add("⭐ Lv3到達");
  if (level >= 5)   add("⭐ Lv5到達");
  if (level >= 10)  add("💎 Lv10到達");
  if (changed) await saveUserProgress();
}

function celebrateGoal(title) {
  launchConfetti();
  showToast(`🎆 目標達成！「${title}」をクリアしました！`, "success", 5000);
}

function updateUI() {
  updateHeaderStats();
  updateProfileCard();
  updateBadgeList();
  updateRanking();
  updateAvatar();
  updateStory();
}

function updateHeaderStats() {
  const el = document.getElementById("headerStats");
  if (!el) return;
  el.innerHTML = `
    <div class="header-stat"><span class="stat-icon">⚡</span> Lv.${level}</div>
    <div class="header-stat"><span class="stat-icon">✨</span> XP ${xp}/${level * 100}</div>
    <div class="header-stat"><span class="stat-icon">🔥</span> ${streak}日連続</div>
  `;
}

function updateProfileCard() {
  const profileLevel = document.getElementById("profileLevel");
  const xpBar        = document.getElementById("xpBar");
  const profileXP    = document.getElementById("profileXP");
  const streakCount  = document.getElementById("streakCount");
  if (profileLevel) profileLevel.textContent = `Lv.${level}`;
  if (xpBar)        xpBar.style.width = `${Math.min(100, (xp / (level * 100)) * 100)}%`;
  if (profileXP)    profileXP.textContent = `${xp} / ${level * 100} XP`;
  if (streakCount)  streakCount.textContent = streak;
}

function updateBadgeList() {
  const el = document.getElementById("badgeContainer");
  if (!el) return;
  el.innerHTML = badges.map(b => `<li>${b}</li>`).join("");
}

function updateRanking() {
  const el = document.getElementById("rankingStatus");
  if (!el) return;
  el.innerHTML = `最高レベル記録: <strong>Lv.${bestLevel}</strong>`;
}

function updateAvatar() {
  const el = document.getElementById("avatar");
  if (!el) return;
  if      (level < 3)  el.textContent = "🐣";
  else if (level < 5)  el.textContent = "🐥";
  else if (level < 8)  el.textContent = "🦉";
  else if (level < 12) el.textContent = "🦅";
  else                 el.textContent = "🐉";
}

const storyStages = [
  { level: 1,  title: "旅立ち",     text: "あなたは冒険を始めたばかりの学びの旅人。知識の地平線が広がっている。" },
  { level: 3,  title: "新しい村",   text: "新しい村に到着し、知識の図書館を発見した。学びが深まっていく。" },
  { level: 5,  title: "仲間の承認", text: "学びの力が増し、仲間があなたを認め始めた。" },
  { level: 8,  title: "知識の扉",   text: "フクロウの知恵を授かり、次の世界への扉が開いた。" },
  { level: 12, title: "伝説の始まり", text: "あなたは今や伝説の域。知識の竜として新たな使命を帯びる。" },
];

function updateStory() {
  const el = document.getElementById("storyContainer");
  if (!el) return;
  const unlocked = storyStages.filter(s => level >= s.level);
  if (unlocked.length === 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = unlocked.map(s => `
    <div class="story-card">
      <h4>Lv.${s.level} — ${s.title}</h4>
      <p>${s.text}</p>
    </div>
  `).join("");
}

// ================================================================
// 今日・週間進捗
// ================================================================
async function getTodayProgress(goalId) {
  const coll = userCollection("progress");
  if (!coll) return 0;
  const today = todayISO();
  const q = query(coll,
    where("goalId", "==", goalId),
    where("date",   "==", today));
  const snap = await getDocs(q);
  let total = 0;
  snap.forEach(d => {
    const data = d.data();
    total += (data.rounds !== undefined ? data.rounds : Math.round((data.minutes || 0) / 25));
  });
  return total;
}

async function getWeeklyProgress(goalId) {
  const coll = userCollection("progress");
  if (!coll) return 0;
  const week = getWeekNumber(new Date());
  const q = query(coll,
    where("goalId", "==", goalId),
    where("week",   "==", week));
  const snap = await getDocs(q);
  let total = 0;
  snap.forEach(d => {
    const data = d.data();
    total += (data.rounds !== undefined ? data.rounds : Math.round((data.minutes || 0) / 25));
  });
  return total;
}

async function updateProgressDisplay(goalId) {
  const todayRounds = await getTodayProgress(goalId);
  const weekRounds  = await getWeeklyProgress(goalId);
  const todayEl = document.getElementById(`today-${goalId}`);
  const weekEl  = document.getElementById(`week-${goalId}`);
  if (todayEl) todayEl.querySelector(".value").textContent = `${todayRounds} 回`;
  if (weekEl)  weekEl.querySelector(".value").textContent  = `${weekRounds} 回`;
}

// ================================================================
// ゴール CRUD
// ================================================================
document.getElementById("addGoalBtn")?.addEventListener("click", async () => {
  const coll = userCollection("goals");
  if (!coll) return;
  const title         = document.getElementById("goalInput").value.trim();
  const dueDate       = document.getElementById("goalDueDate").value;
  const targetRounds  = parseInt(document.getElementById("goalTargetRounds").value);

  if (!title) { showToast("目標タイトルを入力してください", "warning"); return; }
  if (!dueDate) { showToast("期限日を入力してください", "warning"); return; }
  if (!targetRounds || targetRounds <= 0) { showToast("目標回数を正しく入力してください", "warning"); return; }

  try {
    await addDoc(coll, {
      title,
      dueDate,
      targetRounds,
      total: 0,
      completedRounds: 0,
      tasks: [],
      createdAt: new Date().toISOString()
    });
    document.getElementById("goalInput").value          = "";
    document.getElementById("goalDueDate").value        = "";
    document.getElementById("goalTargetRounds").value   = "";
    showToast(`🎯 目標「${title}」を追加しました！`, "success");
    await loadGoals();
  } catch (e) {
    console.error("addGoal error:", e);
    showToast("目標の追加に失敗しました", "error");
  }
});

async function loadGoals() {
  const coll = userCollection("goals");
  if (!coll) return;
  const container = document.getElementById("goalsContainer");
  if (!container) return;
  container.innerHTML = "";

  try {
    const snap = await getDocs(coll);
    if (snap.empty) {
      container.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:20px;">目標がありません。上のフォームから追加してください。</p>`;
      return;
    }

    const goals = [];
    snap.forEach(d => goals.push({ id: d.id, ...d.data() }));
    goals.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

    goals.forEach(goalData => renderGoalCard(goalData, container));
  } catch (e) {
    console.error("loadGoals error:", e);
    showToast("目標の読み込みに失敗しました", "error");
  }
}

function renderGoalCard(goalData, container) {
  const goalId = goalData.id;
  const remaining = goalData.dueDate ? getRemainingDays(goalData.dueDate) : null;
  const isNear = remaining !== null && remaining <= 3;

  const section = document.createElement("div");
  section.className = "goal-section" + (isNear ? " deadline-near" : "");

  // ===== ヘッダー =====
  const header = document.createElement("div");
  header.className = "goal-header";
  header.setAttribute("role", "button");
  header.setAttribute("aria-expanded", "false");
  header.setAttribute("tabindex", "0");

  const title = document.createElement("h2");
  title.textContent = goalData.title;

  const deadlineSpan = document.createElement("span");
  deadlineSpan.className = "deadline-text" + (isNear ? " warning" : "");
  if (goalData.dueDate) {
    deadlineSpan.textContent = remaining !== null
      ? (remaining < 0 ? `期限切れ (${Math.abs(remaining)}日前)` : `期限まで ${remaining}日`)
      : `期限: ${goalData.dueDate}`;
  }

  const toggleBtn = document.createElement("button");
  toggleBtn.className   = "toggle-btn";
  toggleBtn.textContent = "▶";
  toggleBtn.setAttribute("aria-label", "詳細を開閉");

  const toggleHandler = (e) => {
    e.stopPropagation();
    const isOpen = section.classList.toggle("open");
    toggleBtn.textContent = "▶";
    header.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) updateProgressDisplay(goalId);
  };
  header.addEventListener("click", toggleHandler);
  header.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") toggleHandler(e); });

  header.appendChild(title);
  header.appendChild(deadlineSpan);
  header.appendChild(toggleBtn);
  section.appendChild(header);

  // ===== 詳細エリア =====
  const details = document.createElement("div");
  details.className = "goal-details";

  const inner = document.createElement("div");
  inner.className = "goal-details-inner";

  const completedRounds = goalData.completedRounds || Math.round((goalData.total || 0) / 25) || 0;
  const targetRounds = goalData.targetRounds || Math.round((goalData.targetMinutes || 25) / 25) || 1;
  inner.appendChild(createProgressBar(completedRounds, targetRounds, "回"));

  const statsWrap = document.createElement("div");
  statsWrap.className = "progress-stats";
  statsWrap.innerHTML = `
    <div class="progress-stat-item" id="today-${goalId}">
      <span class="label">📅 今日</span>
      <span class="value">読み込み中…</span>
    </div>
    <div class="progress-stat-item" id="week-${goalId}">
      <span class="label">📆 今週</span>
      <span class="value">読み込み中…</span>
    </div>
  `;
  inner.appendChild(statsWrap);

  const taskFormGrid = document.createElement("div");
  taskFormGrid.className = "task-form-grid";

  const taskInputEl = document.createElement("input");
  taskInputEl.placeholder = "タスク内容";
  taskInputEl.setAttribute("aria-label", "タスク内容");

  const timeInputEl = document.createElement("input");
  timeInputEl.type = "number";
  timeInputEl.placeholder = "回数 (25分集中/5分休憩)";
  timeInputEl.min = "1";
  timeInputEl.setAttribute("aria-label", "回数");

  const addTaskBtn = document.createElement("button");
  addTaskBtn.className   = "btn btn-success btn-sm";
  addTaskBtn.textContent = "+ タスク";
  addTaskBtn.addEventListener("click", async () => {
    const task = taskInputEl.value.trim();
    const rounds = parseInt(timeInputEl.value);
    if (!task) { showToast("タスク内容を入力してください", "warning"); return; }
    if (!rounds || rounds <= 0) { showToast("回数を正しく入力してください", "warning"); return; }
    const newTasks = [...(goalData.tasks || []), { task, rounds }];
    try {
      await updateDoc(doc(db, "users", currentUser.uid, "goals", goalId), {
        tasks: newTasks
      });
      showToast("タスクを追加しました ✅", "success");
      await loadGoals();
    } catch (e) {
      console.error("addTask error:", e);
      showToast("タスクの追加に失敗しました", "error");
    }
  });

  taskFormGrid.appendChild(taskInputEl);
  taskFormGrid.appendChild(timeInputEl);
  taskFormGrid.appendChild(addTaskBtn);
  inner.appendChild(taskFormGrid);

  const ul = document.createElement("ul");
  ul.className = "goal-task-list";
  (goalData.tasks || []).forEach((t, i) => {
    const li = document.createElement("li");
    li.className = "goal-task-item";
    
    const textSpan = document.createElement("span");
    textSpan.className = "task-text";
    textSpan.textContent = t.task;
    
    const rounds = t.rounds || Math.round((t.time || 25) / 25) || 1;
    const timeSpan = document.createElement("span");
    timeSpan.className = "task-time";
    timeSpan.textContent = `${rounds}回`;
    
    const startBtn = document.createElement("button");
    startBtn.className = "btn btn-primary btn-sm";
    startBtn.textContent = "▶ スタート";
    startBtn.style.padding = "4px 8px";
    startBtn.style.fontSize = "12px";
    startBtn.style.minHeight = "auto";
    startBtn.addEventListener("click", () => {
      startPomodoro(goalId, i, t, goalData);
    });

    const delBtn = document.createElement("button");
    delBtn.className   = "btn-icon";
    delBtn.textContent = "🗑";
    delBtn.title = "タスクを削除";
    delBtn.addEventListener("click", async () => {
      const newTasks = [...(goalData.tasks || [])];
      newTasks.splice(i, 1);
      try {
        await updateDoc(doc(db, "users", currentUser.uid, "goals", goalId), {
          tasks: newTasks
        });
        showToast("タスクを削除しました", "info");
        await loadGoals();
      } catch (e) {
        console.error("deleteTask error:", e);
        showToast("削除に失敗しました", "error");
      }
    });
    
    li.appendChild(textSpan);
    li.appendChild(timeSpan);
    li.appendChild(startBtn);
    li.appendChild(delBtn);
    ul.appendChild(li);
  });
  inner.appendChild(ul);

  // ===== 履歴セクション =====
  const historyWrap = document.createElement("div");
  historyWrap.className = "goal-history-section";
  
  const historyTitle = document.createElement("div");
  historyTitle.className = "goal-history-title";
  historyTitle.style.display = "flex";
  historyTitle.style.alignItems = "center";
  historyTitle.style.justifyContent = "space-between";
  historyTitle.innerHTML = `<span>📊 ポモドーロ学習履歴</span>`;
  
  const historyList = document.createElement("div");
  historyList.className = "goal-history-list";
  
  const toggleHistBtn = document.createElement("button");
  toggleHistBtn.className = "btn-toggle-history";
  toggleHistBtn.textContent = "表示/非表示";
  toggleHistBtn.addEventListener("click", () => {
    historyList.classList.toggle("collapsed");
  });
  
  historyTitle.appendChild(toggleHistBtn);
  historyWrap.appendChild(historyTitle);
  
  if (goalData.pomodoroHistory && goalData.pomodoroHistory.length > 0) {
    goalData.pomodoroHistory.forEach(item => {
      const itemEl = document.createElement("div");
      itemEl.className = "goal-history-item";
      
      const meta = document.createElement("div");
      meta.className = "goal-history-meta";
      meta.innerHTML = `<span>📅 ${item.date}</span><span>⏱ ${item.minutes || (item.rounds * 25)}分 (${item.rounds}回)</span>`;
      
      const task = document.createElement("div");
      task.className = "goal-history-task";
      task.textContent = item.task;
      
      itemEl.appendChild(meta);
      itemEl.appendChild(task);
      
      if (item.reflection) {
        const refl = document.createElement("div");
        refl.className = "goal-history-reflection";
        refl.textContent = `気づき・学び: ${item.reflection}`;
        itemEl.appendChild(refl);
      }
      
      historyList.appendChild(itemEl);
    });
  } else {
    const emptyMsg = document.createElement("div");
    emptyMsg.style.color = "var(--text-muted)";
    emptyMsg.style.fontSize = "12px";
    emptyMsg.style.textAlign = "center";
    emptyMsg.textContent = "履歴はまだありません。";
    historyList.appendChild(emptyMsg);
  }
  historyWrap.appendChild(historyList);
  inner.appendChild(historyWrap);

  const actions = document.createElement("div");
  actions.className = "goal-actions";

  const editTargetBtn = document.createElement("button");
  editTargetBtn.className   = "btn btn-ghost btn-sm";
  editTargetBtn.textContent = "⚙ 目標回数編集";
  editTargetBtn.addEventListener("click", async () => {
    const currentTarget = goalData.targetRounds || Math.round((goalData.targetMinutes || 25) / 25) || 1;
    const newTarget = parseInt(prompt("新しい目標回数（ポモドーロ数）を入力", currentTarget));
    if (!newTarget || newTarget <= 0) return;
    try {
      await updateDoc(doc(db, "users", currentUser.uid, "goals", goalId), { targetRounds: newTarget });
      showToast("目標回数を更新しました", "success");
      await loadGoals();
    } catch (e) {
      showToast("更新に失敗しました", "error");
    }
  });

  const deleteGoalBtn = document.createElement("button");
  deleteGoalBtn.className   = "btn btn-danger btn-sm";
  deleteGoalBtn.textContent = "🗑 ゴール削除";
  deleteGoalBtn.addEventListener("click", async () => {
    if (!confirm(`「${goalData.title}」を削除しますか？関連する進捗もすべて削除されます。`)) return;
    try {
      const batch = writeBatch(db);

      // 1. 目標の削除をバッチに追加
      const goalDocRef = doc(db, "users", currentUser.uid, "goals", goalId);
      batch.delete(goalDocRef);

      // 2. 関連するすべての進捗ドキュメントをバッチに追加
      const progressSnap = await getDocs(
        query(userCollection("progress"), where("goalId", "==", goalId))
      );
      progressSnap.forEach(ps => {
        const progressDocRef = doc(db, "users", currentUser.uid, "progress", ps.id);
        batch.delete(progressDocRef);
      });

      // 3. アトミックコミット（すべて削除されるか、エラー時はすべてロールバックされる）
      await batch.commit();

      showToast(`🗑 「${goalData.title}」を削除しました`, "info");
      await loadGoals();
    } catch (e) {
      console.error("deleteGoal error:", e);
      showToast("削除に失敗しました", "error");
    }
  });

  actions.appendChild(editTargetBtn);
  actions.appendChild(deleteGoalBtn);
  inner.appendChild(actions);

  details.appendChild(inner);
  section.appendChild(details);
  container.appendChild(section);

  updateProgressDisplay(goalId);
}

// ================================================================
// タスク管理（日・週）
// ================================================================
document.getElementById("addGlobalTaskBtn")?.addEventListener("click", async () => {
  const coll = userCollection("tasks");
  if (!coll) return;
  const taskInput = document.getElementById("taskInput");
  const taskType  = document.getElementById("taskType");
  const task = taskInput?.value.trim();
  const type = taskType?.value;
  if (!task) { showToast("タスク内容を入力してください", "warning"); return; }
  try {
    await addDoc(coll, {
      text: task,
      type,
      createdAt: new Date().toISOString()
    });
    taskInput.value = "";
    showToast(`📋 タスクを追加しました！`, "success");
    await loadGlobalTasks();
  } catch (e) {
    console.error("addGlobalTask error:", e);
    showToast("タスクの追加に失敗しました", "error");
  }
});

async function loadGlobalTasks() {
  const coll = userCollection("tasks");
  if (!coll) return;
  const dayTasksEl  = document.getElementById("dayTasks");
  const weekTasksEl = document.getElementById("weekTasks");
  if (!dayTasksEl || !weekTasksEl) return;
  dayTasksEl.innerHTML  = "";
  weekTasksEl.innerHTML = "";

  try {
    const snap  = await getDocs(coll);
    const tasks = [];
    snap.forEach(d => tasks.push({ id: d.id, ...d.data() }));
    tasks.sort((a, b) => {
      if (a.type !== b.type) return a.type === "day" ? -1 : 1;
      return (a.createdAt || "").localeCompare(b.createdAt || "");
    });

    tasks.forEach(t => {
      const li = document.createElement("li");

      const checkSpan = document.createElement("span");
      checkSpan.className = "task-check";
      checkSpan.textContent = t.type === "day" ? "📅" : "📆";

      const label = document.createElement("span");
      label.className = "task-label";
      label.textContent = t.text;

      const hint = document.createElement("span");
      hint.className = "delete-hint";
      hint.textContent = "クリックで完了";

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn-delete-task";
      deleteBtn.textContent = "🗑";
      deleteBtn.title = "タスクを消去";
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`タスク「${t.text}」を消去しますか？（※XPは獲得できません）`)) return;
        try {
          await deleteDoc(doc(db, "users", currentUser.uid, "tasks", t.id));
          showToast("📋 タスクを消去しました", "info");
          await loadGlobalTasks();
        } catch (err) {
          console.error("deleteGlobalTask error:", err);
          showToast("消去に失敗しました", "error");
        }
      });

      li.appendChild(checkSpan);
      li.appendChild(label);
      li.appendChild(hint);
      li.appendChild(deleteBtn);
      li.setAttribute("role", "button");
      li.setAttribute("tabindex", "0");
      li.setAttribute("aria-label", `${t.text} — クリックで完了、ゴミ箱アイコンで消去`);

      const completeTask = async () => {
        try {
          await deleteDoc(doc(db, "users", currentUser.uid, "tasks", t.id));
          const xpAmt = t.type === "day" ? 5 : 10;
          await addXP(xpAmt);
          showToast(`✅ タスク完了！ +${xpAmt} XP`, "success");
          await loadGlobalTasks();
        } catch (e) {
          console.error("completeTask error:", e);
          showToast("タスクの完了に失敗しました", "error");
        }
      };
      li.addEventListener("click", completeTask);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") completeTask(); });

      if (t.type === "day") dayTasksEl.appendChild(li);
      else weekTasksEl.appendChild(li);
    });
  } catch (e) {
    console.error("loadGlobalTasks error:", e);
    showToast("タスクの読み込みに失敗しました", "error");
  }
}

// ================================================================
// 自動リセット（互換性のために残し、過去データ保持のため処理は廃止）
// ================================================================
async function resetDailyProgress() {
  // 過去の進捗データを残すことで、週間進捗の正しい集計や学習履歴の保持が可能になります。
}

async function resetWeeklyProgress() {
  // 同上
}

// ================================================================
// ポモドーロタイマーロジック
// ================================================================
let pomodoroInterval = null;
let pomodoroState = "idle"; // focus, overtime, break
let pomodoroTimeLeft = 0;
let pomodoroOvertimeSeconds = 0;
let pomodoroCurrentRound = 1;
let pomodoroTotalRounds = 1;
let pomodoroFocusMinutesAcc = 0;
let currentGoalId = "";
let currentTaskIndex = -1;
let currentTaskText = "";
let goalDataForTimer = null;

const FOCUS_DURATION = 25 * 60; // 25分
const BREAK_DURATION = 5 * 60;  // 5分
const CIRCUMFERENCE = 2 * Math.PI * 90; // 565.48

window.startPomodoro = function(goalId, taskIndex, task, goalData) {
  // メイン画面を非表示、タイマー画面を表示
  document.getElementById("app-container").style.display = "none";
  document.getElementById("pomodoro-container").style.display = "flex";
  
  // 状態初期化
  currentGoalId = goalId;
  currentTaskIndex = taskIndex;
  currentTaskText = task.task;
  goalDataForTimer = goalData;
  
  pomodoroCurrentRound = 1;
  pomodoroTotalRounds = task.rounds || Math.round((task.time || 25) / 25) || 1;
  pomodoroFocusMinutesAcc = 0;
  
  document.getElementById("pomodoro-task-name").textContent = currentTaskText;
  
  // UI初期設定
  document.body.classList.remove("pomodoro-focus-ended");
  document.getElementById("pomodoro-alert").style.display = "none";
  document.getElementById("pomodoro-overtime-display").style.display = "none";
  document.getElementById("pomodoro-next-dialog").style.display = "none";
  document.getElementById("pomodoro-reflection").style.display = "none";
  
  startFocusSession();
};

function updateTimerCircle(ratio, strokeColor = null) {
  const circle = document.getElementById("timer-progress-circle");
  if (!circle) return;
  const offset = CIRCUMFERENCE * (1 - ratio);
  circle.style.strokeDashoffset = offset;
  if (strokeColor) {
    circle.style.stroke = strokeColor;
  }
}

function startFocusSession() {
  clearInterval(pomodoroInterval);
  pomodoroState = "focus";
  pomodoroTimeLeft = FOCUS_DURATION;
  pomodoroOvertimeSeconds = 0;
  
  document.body.classList.remove("pomodoro-focus-ended");
  document.getElementById("pomodoro-status").textContent = "集中時間";
  document.getElementById("pomodoro-status").style.color = "var(--accent)";
  document.getElementById("pomodoro-round-indicator").textContent = `${pomodoroCurrentRound} / ${pomodoroTotalRounds} 回目`;
  document.getElementById("pomodoro-alert").style.display = "none";
  document.getElementById("pomodoro-overtime-display").style.display = "none";
  document.getElementById("pomodoro-action-btn").style.display = "none";
  
  updateTimerCircle(1, "var(--accent)");
  
  pomodoroInterval = setInterval(tickTimer, 1000);
  tickTimer(); // 初回描画
}

function startBreakSession() {
  clearInterval(pomodoroInterval);
  pomodoroState = "break";
  pomodoroTimeLeft = BREAK_DURATION;
  
  document.body.classList.remove("pomodoro-focus-ended");
  document.getElementById("pomodoro-status").textContent = "休憩時間";
  document.getElementById("pomodoro-status").style.color = "var(--accent-2)";
  document.getElementById("pomodoro-alert").style.display = "none";
  document.getElementById("pomodoro-overtime-display").style.display = "none";
  document.getElementById("pomodoro-action-btn").style.display = "none";
  
  updateTimerCircle(1, "var(--accent-2)");
  
  pomodoroInterval = setInterval(tickTimer, 1000);
  tickTimer();
}

function tickTimer() {
  if (pomodoroState === "focus") {
    if (pomodoroTimeLeft > 0) {
      pomodoroTimeLeft--;
      renderTime(pomodoroTimeLeft);
      updateTimerCircle(pomodoroTimeLeft / FOCUS_DURATION);
    } else {
      // 集中時間終了 -> 延長カウントアップ状態へ
      transitionToOvertime();
    }
  } else if (pomodoroState === "overtime") {
    pomodoroOvertimeSeconds++;
    renderOvertime(pomodoroOvertimeSeconds);
  } else if (pomodoroState === "break") {
    if (pomodoroTimeLeft > 0) {
      pomodoroTimeLeft--;
      renderTime(pomodoroTimeLeft);
      updateTimerCircle(pomodoroTimeLeft / BREAK_DURATION);
    } else {
      // 休憩時間終了 -> 繰り返し/戻るダイアログ表示
      transitionToBreakEnd();
    }
  }
}

function renderTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  document.getElementById("pomodoro-timer-text").textContent = `${m}:${s}`;
}

function transitionToOvertime() {
  clearInterval(pomodoroInterval);
  pomodoroState = "overtime";
  
  // 視覚的にお知らせ (背景赤色点滅、インジケータ色変更)
  document.body.classList.add("pomodoro-focus-ended");
  
  document.getElementById("pomodoro-status").textContent = "集中終了！";
  document.getElementById("pomodoro-status").style.color = "var(--danger)";
  
  // 延長時間テキスト表示
  const otDisplay = document.getElementById("pomodoro-overtime-display");
  otDisplay.style.display = "block";
  otDisplay.textContent = "+00:00";
  
  // 警告ボックスと休憩へボタンを表示
  const alertBox = document.getElementById("pomodoro-alert");
  alertBox.style.display = "block";
  alertBox.innerHTML = `🎉 集中時間が終了しました！<br>作業をキリの良いところで終えて、ボタンを押して休憩に入ってください。`;
  
  const actionBtn = document.getElementById("pomodoro-action-btn");
  actionBtn.style.display = "block";
  actionBtn.textContent = "休憩を開始する ☕";
  
  // カウントアップタイマーを始動
  pomodoroInterval = setInterval(tickTimer, 1000);
}

function renderOvertime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  document.getElementById("pomodoro-overtime-display").textContent = `+${m}:${s}`;
}

// 「休憩を開始する」ボタン押下時
document.getElementById("pomodoro-action-btn")?.addEventListener("click", () => {
  if (pomodoroState === "overtime") {
    // 延長時間を含めた集中時間（分）を加算
    const elapsedMinutes = 25 + Math.ceil(pomodoroOvertimeSeconds / 60);
    pomodoroFocusMinutesAcc += elapsedMinutes;
    
    // 休憩開始
    startBreakSession();
  }
});

function transitionToBreakEnd() {
  clearInterval(pomodoroInterval);
  document.getElementById("pomodoro-status").textContent = "休憩終了";
  document.getElementById("pomodoro-timer-text").textContent = "00:00";
  
  // 繰り返しますかダイアログを表示
  document.getElementById("pomodoro-next-dialog").style.display = "block";
}

// 繰り返すボタン
document.getElementById("pomodoro-repeat-btn")?.addEventListener("click", () => {
  document.getElementById("pomodoro-next-dialog").style.display = "none";
  // ラウンドを進めて再開
  pomodoroCurrentRound++;
  startFocusSession();
});

// 終了して戻るボタン
document.getElementById("pomodoro-finish-early-btn")?.addEventListener("click", () => {
  document.getElementById("pomodoro-next-dialog").style.display = "none";
  showReflectionScreen();
});

function showReflectionScreen() {
  clearInterval(pomodoroInterval);
  document.getElementById("pomodoro-reflection").style.display = "block";
  document.getElementById("pomodoro-reflection-input").value = "";
}

// 中断ボタン
document.getElementById("pomodoro-abort-btn")?.addEventListener("click", () => {
  if (confirm("タイマーを中断して戻りますか？現在までの学習実績は保存されません。")) {
    clearInterval(pomodoroInterval);
    document.getElementById("pomodoro-container").style.display = "none";
    document.getElementById("app-container").style.display = "block";
  }
});

// スキップボタン（動作検証用）
document.getElementById("pomodoro-skip-btn")?.addEventListener("click", () => {
  if (pomodoroState === "focus" || pomodoroState === "break") {
    pomodoroTimeLeft = Math.min(pomodoroTimeLeft, 3); // 残り3秒に短縮
    showToast("🕒 タイマーをスキップしました (残り3秒)", "info");
  }
});

// 振り返り保存ボタン
document.getElementById("pomodoro-submit-reflection-btn")?.addEventListener("click", async () => {
  const reflection = document.getElementById("pomodoro-reflection-input").value.trim();
  const completedRounds = pomodoroState === "break" ? pomodoroCurrentRound - 1 : pomodoroCurrentRound;
  
  // 0回完了の場合は保存せずに戻ることも可能にする
  if (completedRounds <= 0) {
    showToast("完了したポモドーロがありません。", "warning");
    document.getElementById("pomodoro-container").style.display = "none";
    document.getElementById("app-container").style.display = "block";
    return;
  }
  
  const totalMinutes = pomodoroFocusMinutesAcc;
  const now = new Date();
  
  try {
    // 1. 進捗情報をprogressに記録
    await addDoc(userCollection("progress"), {
      goalId: currentGoalId,
      minutes: totalMinutes,
      rounds: completedRounds,
      date: todayISO(),
      week: getWeekNumber(now)
    });
    
    // 2. 目標側の累積時間と履歴を更新
    const newTotal = (goalDataForTimer.total || 0) + totalMinutes;
    const newCompletedRounds = (goalDataForTimer.completedRounds || 0) + completedRounds;
    const historyItem = {
      task: currentTaskText,
      rounds: completedRounds,
      minutes: totalMinutes,
      reflection: reflection,
      date: todayISO(),
      createdAt: new Date().toISOString()
    };
    const newHistory = [...(goalDataForTimer.pomodoroHistory || []), historyItem];
    
    // タスク一覧から現在のタスクを削除する（完了したため）
    const newTasks = [...(goalDataForTimer.tasks || [])];
    newTasks.splice(currentTaskIndex, 1);
    
    await updateDoc(doc(db, "users", currentUser.uid, "goals", currentGoalId), {
      total: newTotal,
      completedRounds: newCompletedRounds,
      pomodoroHistory: newHistory,
      tasks: newTasks
    });
    
    // 3. XP加算（ポモドーロ完了回数のみをXP対象とする: 1回につき20XP）
    const xpReward = completedRounds * 20;
    await addXP(xpReward);
    
    showToast(`⏱ ${completedRounds}回完了！ +${xpReward} XPを獲得！`, "success");
    
    // 目標達成お祝いチェック
    const targetRounds = goalDataForTimer.targetRounds || Math.round((goalDataForTimer.targetMinutes || 25) / 25) || 1;
    if (newCompletedRounds >= targetRounds) {
      celebrateGoal(goalDataForTimer.title);
      await addXP(100);
    }
    
    // アプリ画面に戻る
    document.getElementById("pomodoro-container").style.display = "none";
    document.getElementById("app-container").style.display = "block";
    await loadGoals();
  } catch (e) {
    console.error("Save Pomodoro progress error:", e);
    showToast("学習記録の保存に失敗しました", "error");
  }
});

// ================================================================
// タスクリスト（1日/週間）の表示・非表示切り替えイベントリスナー
// ================================================================
document.getElementById("toggleDayTasksBtn")?.addEventListener("click", () => {
  document.getElementById("dayTasks").classList.toggle("collapsed");
});
document.getElementById("toggleWeekTasksBtn")?.addEventListener("click", () => {
  document.getElementById("weekTasks").classList.toggle("collapsed");
});