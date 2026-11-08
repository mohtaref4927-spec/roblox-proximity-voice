// Roblox Proximity Voice - starter server
// This starter implements Roblox profile-description ownership verification,
// live radar transport, and a protected Roblox game-server ingest endpoint.
// WebRTC voice and Discord OAuth are intentionally separate next phases.

"use strict";

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = Number(process.env.PORT || 3000);
const INGEST_SECRET = process.env.ROBLOX_INGEST_SECRET || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const VERIFY_TTL_MS = 10 * 60 * 1000;
const MAX_PLAYERS_PER_SERVER = 100;

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(express.static("public", { extensions: ["html"] }));

// In-memory starter stores. Use a database before production deployment.
const verificationSessions = new Map();
const linkedAccounts = new Map();
const liveServers = new Map();

function cleanText(value, max = 64) {
  return String(value ?? "").trim().slice(0, max);
}

function makeCode() {
  return "RV-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

function publicError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

function requireIngestSecret(req, res, next) {
  const supplied = req.get("x-roblox-secret") || "";
  if (!INGEST_SECRET || !safeEqual(supplied, INGEST_SECRET)) {
    return publicError(res, 401, "Unauthorized game server");
  }
  next();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validPosition(value) {
  return Number.isFinite(value) && Math.abs(value) < 1000000;
}

function normalizePlayers(players) {
  if (!Array.isArray(players)) return null;
  if (players.length > MAX_PLAYERS_PER_SERVER) return null;

  const normalized = [];
  for (const player of players) {
    const userId = Number(player.userId);
    const x = Number(player.x);
    const y = Number(player.y);
    const z = Number(player.z);

    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    if (![x, y, z].every(validPosition)) continue;

    normalized.push({
      userId,
      name: cleanText(player.name || `Player ${userId}`, 32),
      x,
      y,
      z,
      updatedAt: Date.now()
    });
  }
  return normalized;
}

async function lookupRobloxUser(username) {
  const response = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      usernames: [username],
      excludeBannedUsers: false
    }),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Roblox username lookup returned ${response.status}`);
  }

  const payload = await response.json();
  return payload.data?.[0] || null;
}

async function getRobloxDescription(userId) {
  const response = await fetch(`https://users.roblox.com/v1/users/${userId}`, {
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Roblox profile lookup returned ${response.status}`);
  }

  const payload = await response.json();
  return String(payload.description || "");
}

function removeExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of verificationSessions) {
    if (session.expiresAt <= now) verificationSessions.delete(id);
  }
}

setInterval(removeExpiredSessions, 60 * 1000).unref();

// Health endpoint for quick local checks.
app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    service: "Roblox Proximity Voice",
    time: new Date().toISOString()
  });
});

// Step 1: create a short-lived Roblox ownership challenge.
app.post("/api/roblox/start", async (req, res) => {
  try {
    const username = cleanText(req.body?.username, 32);
    if (!username) return publicError(res, 400, "اكتب اسم Roblox أولاً");

    const user = await lookupRobloxUser(username);
    if (!user) return publicError(res, 404, "لم نعثر على حساب بهذا الاسم");

    const sessionId = crypto.randomUUID();
    const code = makeCode();

    verificationSessions.set(sessionId, {
      userId: user.id,
      username: user.name,
      code,
      expiresAt: Date.now() + VERIFY_TTL_MS
    });

    return res.json({
      success: true,
      sessionId,
      code,
      username: user.name,
      userId: user.id,
      profileUrl: `https://www.roblox.com/users/${user.id}/profile`,
      expiresInSeconds: VERIFY_TTL_MS / 1000
    });
  } catch (error) {
    console.error("Roblox start error:", error.message);
    return publicError(res, 502, "تعذر الوصول إلى Roblox الآن، حاول مرة أخرى");
  }
});

// Step 2: confirm the challenge appears in the public profile description.
app.post("/api/roblox/verify", async (req, res) => {
  try {
    const sessionId = cleanText(req.body?.sessionId, 80);
    const session = verificationSessions.get(sessionId);

    if (!session || session.expiresAt <= Date.now()) {
      verificationSessions.delete(sessionId);
      return publicError(res, 400, "انتهت صلاحية الكود. أنشئ كوداً جديداً");
    }

    const description = await getRobloxDescription(session.userId);
    if (!description.includes(session.code)) {
      return publicError(res, 409, "لم يظهر الكود في وصف الحساب بعد");
    }

    const account = {
      userId: session.userId,
      username: session.username,
      verifiedAt: new Date().toISOString()
    };

    linkedAccounts.set(session.userId, account);
    verificationSessions.delete(sessionId);

    return res.json({ success: true, account });
  } catch (error) {
    console.error("Roblox verify error:", error.message);
    return publicError(res, 502, "تعذر فحص وصف Roblox الآن، حاول مرة أخرى");
  }
});

// Public status endpoint. It exposes only the linked public Roblox identity.
app.get("/api/roblox/account/:userId", (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId)) {
    return publicError(res, 400, "Invalid user id");
  }

  const account = linkedAccounts.get(userId);
  if (!account) return res.json({ success: true, linked: false });
  return res.json({ success: true, linked: true, account });
});

// Roblox game servers send their current player positions here.
// The secret must be stored in Roblox server-side code, never in a LocalScript.
app.post("/api/roblox/update", requireIngestSecret, (req, res) => {
  const serverId = cleanText(req.body?.serverId, 100);
  const players = normalizePlayers(req.body?.players);

  if (!serverId || !players) {
    return publicError(res, 400, "Invalid serverId or players payload");
  }

  liveServers.set(serverId, {
    players,
    updatedAt: Date.now()
  });

  io.to(serverId).emit("radar:update", players);
  return res.json({ success: true, count: players.length });
});

// Browser joins a specific Roblox server's radar room.
io.on("connection", (socket) => {
  socket.on("watch", (rawServerId) => {
    const serverId = cleanText(rawServerId, 100);
    if (!serverId) return;

    // A socket may watch one room at a time.
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }

    socket.join(serverId);
    const current = liveServers.get(serverId);
    socket.emit("radar:update", current?.players || []);
  });

  socket.on("disconnect", () => {
    // Socket.IO automatically removes the socket from its rooms.
  });
});

// Remove stale game-server snapshots from memory.
setInterval(() => {
  const cutoff = Date.now() - 15000;
  for (const [serverId, snapshot] of liveServers) {
    if (snapshot.updatedAt < cutoff) {
      liveServers.delete(serverId);
      io.to(serverId).emit("radar:update", []);
    }
  }
}, 5000).unref();

server.listen(PORT, () => {
  console.log(`Roblox Voice running at ${PUBLIC_BASE_URL}`);
  console.log(`Health check: ${PUBLIC_BASE_URL}/api/health`);
  if (!INGEST_SECRET) {
    console.warn("WARNING: ROBLOX_INGEST_SECRET is not configured.");
    console.warn("The Roblox position ingest endpoint will reject requests.");
  }
});
