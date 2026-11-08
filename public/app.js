/* NEARBY dashboard interactions */
"use strict";

const socket = io();
const elements = {
  connectionStatus: document.getElementById("connectionStatus"),
  connectionDot: document.getElementById("connectionDot"),
  robloxStatus: document.getElementById("robloxStatus"),
  robloxBadge: document.getElementById("robloxBadge"),
  robloxSubstatus: document.getElementById("robloxSubstatus"),
  playerCount: document.getElementById("playerCount"),
  radarPlayers: document.getElementById("radarPlayers"),
  radarMessage: document.getElementById("radarMessage"),
  startForm: document.getElementById("robloxStartForm"),
  username: document.getElementById("robloxUsername"),
  startButton: document.getElementById("startVerification"),
  verificationBox: document.getElementById("verificationBox"),
  verificationCode: document.getElementById("verificationCode"),
  copyCode: document.getElementById("copyCode"),
  profileLink: document.getElementById("profileLink"),
  verifyButton: document.getElementById("verifyButton"),
  expiryNote: document.getElementById("expiryNote"),
  serverId: document.getElementById("serverId"),
  joinServerButton: document.getElementById("joinServerButton"),
  refreshButton: document.getElementById("refreshButton"),
  toast: document.getElementById("toast")
};

let verificationSessionId = null;
let linkedAccount = null;
let toastTimer = null;
let watchedServerId = null;

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3400);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || "حدث خطأ غير متوقع");
  }
  return payload;
}

function setConnection(connected) {
  elements.connectionStatus.textContent = connected ? "متصل" : "غير متصل";
  elements.connectionDot.classList.toggle("muted", !connected);
}

function setRobloxLinked(account) {
  linkedAccount = account;
  elements.robloxStatus.textContent = account.username;
  elements.robloxBadge.textContent = "تم الربط";
  elements.robloxBadge.classList.add("verified");
  elements.robloxSubstatus.textContent = `تم التحقق من الحساب #${account.userId}`;
}

function setRobloxUnlinked() {
  linkedAccount = null;
  elements.robloxStatus.textContent = "غير مربوط";
  elements.robloxBadge.textContent = "غير مربوط";
  elements.robloxBadge.classList.remove("verified");
  elements.robloxSubstatus.textContent = "اربط حسابك لإثبات هويتك";
}

function setBusy(button, busy, busyText, normalText) {
  button.disabled = busy;
  button.dataset.normalText ||= normalText || button.textContent;
  button.textContent = busy ? busyText : button.dataset.normalText;
}

socket.on("connect", () => {
  setConnection(true);
  if (watchedServerId) socket.emit("watch", watchedServerId);
});

socket.on("disconnect", () => {
  setConnection(false);
});

socket.on("connect_error", () => {
  setConnection(false);
});

socket.on("radar:update", (players) => {
  renderRadar(Array.isArray(players) ? players : []);
});

function renderRadar(players) {
  elements.radarPlayers.replaceChildren();
  elements.playerCount.textContent = String(players.length);

  if (!players.length) {
    elements.radarMessage.textContent =
      "لا توجد بيانات لاعبين حالياً. تأكد أن سكربت Roblox يرسل المواقع.";
    return;
  }

  elements.radarMessage.textContent =
    `يتم عرض ${players.length} لاعب من نفس جلسة Roblox.`;

  // This first radar uses world X/Z coordinates relative to a fixed 100-stud range.
  // A later iteration will receive the local player's position and center the radar on them.
  const RANGE = 100;

  for (const player of players) {
    const x = Number(player.x) || 0;
    const z = Number(player.z) || 0;
    const clampedX = Math.max(-RANGE, Math.min(RANGE, x));
    const clampedZ = Math.max(-RANGE, Math.min(RANGE, z));

    const dot = document.createElement("span");
    const far = Math.hypot(x, z) > 60;
    dot.className = `radar-player-dot${far ? " far" : ""}`;
    dot.style.left = `${50 + (clampedX / RANGE) * 42}%`;
    dot.style.top = `${50 + (clampedZ / RANGE) * 42}%`;
    dot.dataset.name = String(player.name || player.userId || "Player");
    dot.title = `${dot.dataset.name} (${Math.round(Math.hypot(x, z))} studs)`;
    elements.radarPlayers.append(dot);
  }
}

elements.startForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = elements.username.value.trim();
  if (!username) return showToast("اكتب اسم حساب Roblox");

  setBusy(elements.startButton, true, "جاري إنشاء الكود...");
  try {
    const result = await requestJson("/api/roblox/start", {
      method: "POST",
      body: JSON.stringify({ username })
    });

    verificationSessionId = result.sessionId;
    elements.verificationCode.textContent = result.code;
    elements.profileLink.href = result.profileUrl;
    elements.verificationBox.classList.remove("hidden");
    elements.expiryNote.textContent =
      `الكود صالح لمدة ${Math.floor(result.expiresInSeconds / 60)} دقائق`;
    showToast("تم إنشاء كود التحقق. ضعه في وصف حساب Roblox.");
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(elements.startButton, false);
  }
});

elements.copyCode.addEventListener("click", async () => {
  const code = elements.verificationCode.textContent;
  try {
    await navigator.clipboard.writeText(code);
    showToast("تم نسخ كود التحقق");
  } catch {
    showToast(`انسخ الكود يدوياً: ${code}`);
  }
});

elements.verifyButton.addEventListener("click", async () => {
  if (!verificationSessionId) {
    showToast("أنشئ كود تحقق أولاً");
    return;
  }

  setBusy(elements.verifyButton, true, "جاري التحقق...");
  try {
    const result = await requestJson("/api/roblox/verify", {
      method: "POST",
      body: JSON.stringify({ sessionId: verificationSessionId })
    });

    setRobloxLinked(result.account);
    verificationSessionId = null;
    elements.verificationBox.classList.add("hidden");
    showToast(`تم ربط حساب ${result.account.username} بنجاح`);
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(elements.verifyButton, false);
  }
});

elements.joinServerButton.addEventListener("click", () => {
  const serverId = elements.serverId.value.trim();
  if (!serverId) {
    showToast("أدخل Server ID أولاً");
    return;
  }
  if (!socket.connected) {
    showToast("الموقع غير متصل بالسيرفر");
    return;
  }

  watchedServerId = serverId;
  socket.emit("watch", serverId);
  elements.radarMessage.textContent = `تم طلب بيانات السيرفر: ${serverId}`;
  showToast("تم الاتصال بغرفة الرادار");
});

elements.refreshButton.addEventListener("click", async () => {
  try {
    const health = await requestJson("/api/health");
    showToast(health.success ? "السيرفر يعمل بشكل طبيعي" : "السيرفر غير متاح");
  } catch {
    showToast("تعذر الوصول إلى السيرفر");
  }
});

async function checkInitialHealth() {
  try {
    await requestJson("/api/health");
    setConnection(socket.connected);
  } catch {
    setConnection(false);
  }
}

checkInitialHealth();

// The page intentionally does not request microphone permission yet.
// Microphone capture becomes useful only after signaling and WebRTC peer
// connections are implemented on both sides.
