import { supabase } from "./supabaseClient.js";
import { AVATARS, avatarMarkup } from "./avatars.js";

const $ = (id) => document.getElementById(id);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const MAX_PLAYERS = 8; // room limit

// ---------------------------------------------------------------------
// state
// ---------------------------------------------------------------------
const state = {
  room: null,        // current room row
  playerId: null,    // my player id
  selectedAvatar: AVATARS[0],
  players: [],        // all players in room
  channel: null,
  timerHandle: null,
  guessTarget: null,  // {assignment, paper, players}
  currentWritingRound: null,
};

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(`screen-${name}`).classList.add("active");
}

function randomCode(len = 5) {
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Session persistence is intentionally disabled. Every page load starts fresh.
function clearSession() {
  localStorage.removeItem("bp_session");
}

// ---------------------------------------------------------------------
// avatar picker (home screen)
// ---------------------------------------------------------------------
function renderAvatarPicker() {
  const preview = $("avatar-preview");
  if (!preview) return;

  preview.innerHTML = avatarMarkup(state.selectedAvatar, "avatar-svg avatar-preview-img");
  preview.classList.remove("pop");
  void preview.offsetWidth;
  preview.classList.add("pop");
}

function changeAvatar(direction) {
  const current = AVATARS.indexOf(state.selectedAvatar);
  const next = (current + direction + AVATARS.length) % AVATARS.length;
  state.selectedAvatar = AVATARS[next];
  renderAvatarPicker();
}

function continueFromName() {
  const name = $("input-name").value.trim();
  if (!name) return setError("name-error", "Enter your name first.");

  $("mode-name").textContent = name;
  $("mode-avatar").innerHTML = avatarMarkup(state.selectedAvatar, "avatar-svg avatar-mode-img");
  showScreen("mode");
}

function backToName() {
  showScreen("name");
  $("mode-name").textContent = "";
  $("mode-avatar").textContent = "";
}

// ---------------------------------------------------------------------
// create / join
// ---------------------------------------------------------------------
async function createRoom() {
  const name = $("input-name").value.trim();
  if (!name) return setError("name-error", "Enter your name first.");

  let code, existing;
  do {
    code = randomCode();
    ({ data: existing } = await supabase.from("rooms").select("id").eq("code", code).maybeSingle());
  } while (existing);

  const { data: room, error } = await supabase
    .from("rooms")
    .insert({ code })
    .select()
    .single();
  if (error) return setError("name-error", error.message);

  const { data: player, error: pErr } = await supabase
    .from("players")
    .insert({ room_id: room.id, name, avatar: state.selectedAvatar, is_host: true })
    .select()
    .single();
  if (pErr) return setError("name-error", pErr.message);

  clearSession();
  enterRoom(room.id, player.id);
}

async function joinRoom() {
  const name = $("input-name").value.trim();
  const code = $("input-code").value.trim().toUpperCase();
  if (!name) return setError("name-error", "Enter your name first.");
  if (!code) return setError("name-error", "Enter a room code.");

  const { data: room, error } = await supabase.from("rooms").select().eq("code", code).maybeSingle();
  if (error || !room) return setError("name-error", "Room not found.");
  if (room.status !== "lobby") return setError("name-error", "That game already started.");

  const { count } = await supabase
    .from("players")
    .select("id", { count: "exact", head: true })
    .eq("room_id", room.id);
  if ((count ?? 0) >= MAX_PLAYERS) return setError("name-error", `Room is full (max ${MAX_PLAYERS} players).`);

  const { data: player, error: pErr } = await supabase
    .from("players")
    .insert({ room_id: room.id, name, avatar: state.selectedAvatar, is_host: false })
    .select()
    .single();
  if (pErr) return setError("name-error", pErr.message);

  clearSession();
  enterRoom(room.id, player.id);
}

function setError(id, msg) { $(id).textContent = msg; setTimeout(() => { $(id).textContent = ""; }, 4000); }

// ---------------------------------------------------------------------
// entering a room + realtime subscription
// ---------------------------------------------------------------------
async function enterRoom(roomId, playerId) {
  state.playerId = playerId;

  const { data: room } = await supabase.from("rooms").select().eq("id", roomId).single();
  state.room = room;

  await refreshPlayers();
  subscribeRealtime(roomId);
  $("room-bar").classList.remove("hidden");
  $("room-bar-code").textContent = room.code;
  renderForStatus();
  await renderPlayerStrip();
}

async function leaveRoom() {
  clearInterval(state.timerHandle);
  state.timerHandle = null;

  if (state.channel) {
    await supabase.removeChannel(state.channel);
  }

  if (isHost()) {
    const next = state.players.find((p) => p.id !== state.playerId);
    if (next) {
      await supabase.from("players").update({ is_host: true }).eq("id", next.id);
    }
  }

  if (state.playerId) {
    await supabase.from("players").delete().eq("id", state.playerId);
  }

  clearSession();
  state.room = null;
  state.players = [];
  state.playerId = null;
  state.channel = null;
  state.guessTarget = null;
  state.currentWritingRound = null;

  $("room-bar").classList.add("hidden");
  $("player-strip").classList.add("hidden");
  $("player-strip").innerHTML = "";
  $("room-bar-code").textContent = "";
  $("input-code").value = "";
  $("write-text").value = "";
  $("write-status").textContent = "";
  showScreen("name");
}

async function refreshPlayers() {
  const { data } = await supabase.from("players").select().eq("room_id", state.room.id).order("joined_at");
  state.players = data || [];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[char]));
}

async function renderPlayerStrip() {
  const strip = $("player-strip");
  if (!strip || !state.room || !state.playerId) return;

  const status = state.room.status;
  const show = ["writing", "guessing", "reveal"].includes(status);
  strip.classList.toggle("hidden", !show);
  if (!show) return;

  let doneIds = new Set();

  if (status === "writing") {
    const { data: papers } = await supabase.from("papers")
      .select("author_id").eq("room_id", state.room.id).eq("round", state.room.round);
    doneIds = new Set((papers || []).map((p) => p.author_id));
  } else if (status === "guessing") {
    const { data: assignments } = await supabase.from("assignments")
      .select("assigned_to, guessed_player_id").eq("room_id", state.room.id).eq("round", state.room.round);
    doneIds = new Set((assignments || [])
      .filter((a) => a.guessed_player_id !== null)
      .map((a) => a.assigned_to));
  } else {
    doneIds = new Set(state.players.map((p) => p.id));
  }

  strip.innerHTML = "";

  state.players.forEach((p) => {
    const card = document.createElement("div");
    const done = doneIds.has(p.id);
    const me = p.id === state.playerId;

    card.className = `player-tab${done ? " done" : ""}${me ? " me" : ""}`;
    card.title = `${p.name} · ${p.score ?? 0} point${p.score === 1 ? "" : "s"}`;

    const statusLabel =
      status === "writing" ? (done ? "Done" : "Writing…") :
      status === "guessing" ? (done ? "Done" : "Guessing…") :
      "Done";

    card.innerHTML = `
      <div class="player-tab-avatar">${avatarMarkup(p.avatar, "avatar-svg")}</div>
      <div class="player-tab-info">
        <div class="player-tab-name">${escapeHtml(p.name)}</div>
        <div class="player-tab-status"><span class="player-status-dot"></span>${statusLabel}</div>
      </div>
      <div class="player-tab-score">${p.score ?? 0}</div>
    `;
    strip.appendChild(card);
  });
}

function subscribeRealtime(roomId) {
  if (state.channel) supabase.removeChannel(state.channel);

  state.channel = supabase
    .channel(`room-${roomId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
      async (payload) => {
        const previousStatus = state.room?.status;
        const previousRound = state.room?.round;
        state.room = payload.new;

        // During writing, only rerender when the actual round/status changes.
        // This prevents realtime events from wiping text the player is typing.
        if (state.room.status === "writing" && previousStatus === "writing" && previousRound === state.room.round) {
          return;
        }

        renderForStatus();
        await renderPlayerStrip();
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` },
      async () => {
        await refreshPlayers();
        await renderPlayerStrip();

        // Player joins/leaves/score changes should never rebuild the writing form.
        if (state.room?.status === "writing") {
          return;
        }

        renderForStatus();
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "papers", filter: `room_id=eq.${roomId}` },
      async () => {
        if (state.room?.status === "writing") {
          await renderPlayerStrip();
          await maybeAutoAdvanceWriting();
        }
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "assignments", filter: `room_id=eq.${roomId}` },
      async () => {
        if (state.room?.status === "guessing") {
          await renderGuessing();
          await maybeAutoAdvanceGuessing();
        }
      })
    .subscribe();
}

function isHost() {
  const me = state.players.find((p) => p.id === state.playerId);
  return !!me?.is_host;
}

// ---------------------------------------------------------------------
// dispatch UI based on room status
// ---------------------------------------------------------------------
function renderForStatus() {
  if (!state.room) return;
  switch (state.room.status) {
    case "lobby": renderLobby(); showScreen("lobby"); break;
    case "writing": renderWriting(); showScreen("writing"); break;
    case "guessing": renderGuessing(); showScreen("guessing"); break;
    case "reveal": renderReveal(); showScreen("reveal"); break;
    default: showScreen("lobby");
  }
}

// ---------------------------------------------------------------------
// LOBBY
// ---------------------------------------------------------------------
function renderLobby() {
  $("lobby-code").textContent = state.room.code;
  const list = $("lobby-players");
  list.innerHTML = "";
  state.players.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `${avatarMarkup(p.avatar, "avatar-svg lobby-avatar")} ${escapeHtml(p.name)}` +
      (p.is_host ? `<span class="host-tag">HOST</span>` : "");
    list.appendChild(li);
  });

  const host = isHost();
  $("lobby-host-controls").classList.toggle("hidden", !host);
  const countLabel = `${state.players.length}/${MAX_PLAYERS} players`;
  $("lobby-hint").textContent = host
    ? (state.players.length < 3 ? `Need at least 3 players to start. (${countLabel})` : countLabel)
    : `Waiting for the host to start the game… (${countLabel})`;
  $("btn-start").disabled = state.players.length < 3;
}

async function startGame() {
  const seconds = parseInt($("select-seconds").value, 10);
  const endsAt = new Date(Date.now() + seconds * 1000).toISOString();
  await supabase.from("rooms").update({
    status: "writing",
    round: 1,
    round_seconds: seconds,
    writing_ends_at: endsAt,
  }).eq("id", state.room.id).eq("status", "lobby");
}

// ---------------------------------------------------------------------
// WRITING
// ---------------------------------------------------------------------
function renderWriting() {
  $("write-round").textContent = state.room.round;

  // Only initialize the writing form once per round.
  // Realtime player updates must NEVER erase text currently being typed.
  if (state.currentWritingRound === state.room.round) return;

  state.currentWritingRound = state.room.round;
  $("write-text").value = "";
  $("write-text").disabled = false;
  $("btn-submit-paper").disabled = false;
  $("write-status").textContent = "";
  startCountdown(state.room.writing_ends_at);
}

function startCountdown(endsAtISO) {
  clearInterval(state.timerHandle);
  const endsAt = new Date(endsAtISO).getTime();
  const tick = () => {
    const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    const el = $("write-timer");
    el.textContent = remaining;
    el.classList.toggle("low", remaining <= 10);
    if (remaining <= 0) {
      clearInterval(state.timerHandle);
      $("write-text").disabled = true;
      $("btn-submit-paper").disabled = true;
      $("write-status").textContent = "Time's up — shuffling papers…";
      if (isHost()) claimAndDistribute();
    }
  };
  tick();
  state.timerHandle = setInterval(tick, 250);
}

async function submitPaper() {
  const content = $("write-text").value.trim();
  if (!content) return;
  $("btn-submit-paper").disabled = true;
  const { error } = await supabase.from("papers").insert({
    room_id: state.room.id,
    round: state.room.round,
    author_id: state.playerId,
    content,
  });
  if (error) {
    // likely already submitted (unique constraint) — that's fine
    $("write-status").textContent = "Submitted. Waiting for others…";
  } else {
    $("write-status").textContent = "Submitted. Waiting for others…";
    $("write-text").disabled = true;
  }
  await renderPlayerStrip();
  await maybeAutoAdvanceWriting();
}

// if everyone has submitted early, don't make people wait for the clock
async function maybeAutoAdvanceWriting() {
  if (state.room.status !== "writing") return;
  const { data: papers } = await supabase
    .from("papers").select("author_id").eq("room_id", state.room.id).eq("round", state.room.round);
  if ((papers?.length || 0) >= state.players.length && isHost()) {
    claimAndDistribute();
  }
}

// ---------------------------------------------------------------------
// SHUFFLE + DISTRIBUTE (race-safe: only the client that wins the
// conditional status update actually does the work)
// ---------------------------------------------------------------------
async function claimAndDistribute() {
  const { data: claimed } = await supabase
    .from("rooms")
    .update({ status: "distributing" })
    .eq("id", state.room.id)
    .eq("status", "writing")
    .select();
  if (!claimed || claimed.length === 0) return; // someone else already claimed it

  await backfillMissingPapers();
  await assignPapers();

  await supabase.from("rooms").update({ status: "guessing" }).eq("id", state.room.id);
}

async function backfillMissingPapers() {
  const { data: papers } = await supabase
    .from("papers").select("author_id").eq("room_id", state.room.id).eq("round", state.room.round);
  const wrote = new Set((papers || []).map((p) => p.author_id));
  const missing = state.players.filter((p) => !wrote.has(p.id));
  if (missing.length === 0) return;

  await supabase.from("papers").insert(
    missing.map((p) => ({
      room_id: state.room.id,
      round: state.room.round,
      author_id: p.id,
      content: "🤷 (didn't write anything in time)",
      auto_filled: true,
    }))
  );
}

// derangement: every paper goes to someone who didn't write it
function buildDerangement(players, papers) {
  const n = players.length;
  for (let attempt = 0; attempt < 300; attempt++) {
    const order = shuffle(papers);
    if (order.every((paper, i) => paper.author_id !== players[i].id)) {
      return players.map((p, i) => ({ assigned_to: p.id, paper_id: order[i].id }));
    }
  }
  // fallback: fix remaining conflicts by swapping with the next slot
  const order = shuffle(papers);
  for (let i = 0; i < n; i++) {
    if (order[i].author_id === players[i].id) {
      const j = (i + 1) % n;
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  return players.map((p, i) => ({ assigned_to: p.id, paper_id: order[i].id }));
}

async function assignPapers() {
  await refreshPlayers();
  const { data: papers } = await supabase
    .from("papers").select().eq("room_id", state.room.id).eq("round", state.room.round);

  const rows = buildDerangement(shuffle(state.players), papers).map((r) => ({
    room_id: state.room.id,
    round: state.room.round,
    paper_id: r.paper_id,
    assigned_to: r.assigned_to,
  }));
  await supabase.from("assignments").insert(rows);
}

// ---------------------------------------------------------------------
// GUESSING
// ---------------------------------------------------------------------
async function renderGuessing() {
  await renderPlayerStrip();
  const { data: assignment } = await supabase
    .from("assignments").select()
    .eq("room_id", state.room.id).eq("round", state.room.round).eq("assigned_to", state.playerId)
    .maybeSingle();
  if (!assignment) return;

  const { data: paper } = await supabase.from("papers").select().eq("id", assignment.paper_id).single();

  $("guess-paper-text").textContent = paper.content;

  const grid = $("guess-player-grid");
  grid.innerHTML = "";
  const already = !!assignment.guessed_player_id;

  state.players
    .filter((p) => p.id !== state.playerId)
    .forEach((p) => {
      const card = document.createElement("div");
      card.className = "player-card" + (assignment.guessed_player_id === p.id ? " picked" : "");
      card.innerHTML = `${avatarMarkup(p.avatar, "avatar-svg guess-avatar")} ${escapeHtml(p.name)}`;
      if (!already) {
        card.onclick = () => submitGuess(assignment.id, p.id);
      }
      grid.appendChild(card);
    });

  $("guess-status").textContent = already
    ? "Guess locked in. Waiting for everyone else…"
    : "Tap who you think wrote this.";
}

async function submitGuess(assignmentId, guessedPlayerId) {
  await supabase
    .from("assignments")
    .update({ guessed_player_id: guessedPlayerId })
    .eq("id", assignmentId)
    .is("guessed_player_id", null); // only the first click sticks
  await maybeAutoAdvanceGuessing();
}

async function maybeAutoAdvanceGuessing() {
  const { data: assignments } = await supabase
    .from("assignments").select("guessed_player_id")
    .eq("room_id", state.room.id).eq("round", state.room.round);
  const allGuessed = (assignments || []).length > 0 &&
    assignments.every((a) => a.guessed_player_id !== null);
  if (allGuessed) claimAndReveal();
}

// ---------------------------------------------------------------------
// REVEAL + scoring (also race-safe via conditional status update)
// ---------------------------------------------------------------------
async function claimAndReveal() {
  const { data: claimed } = await supabase
    .from("rooms")
    .update({ status: "scoring" })
    .eq("id", state.room.id)
    .eq("status", "guessing")
    .select();
  if (!claimed || claimed.length === 0) return;

  const { data: assignments } = await supabase
    .from("assignments").select("*, papers(author_id)")
    .eq("room_id", state.room.id).eq("round", state.room.round);

  for (const a of assignments) {
    if (a.guessed_player_id === a.papers.author_id) {
      const player = state.players.find((p) => p.id === a.assigned_to);
      const newScore = (player?.score || 0) + 1;
      await supabase.from("players").update({ score: newScore }).eq("id", a.assigned_to);
    }
  }

  await supabase.from("rooms").update({ status: "reveal" }).eq("id", state.room.id);
}

async function renderReveal() {
  await refreshPlayers();
  await renderPlayerStrip();
  $("reveal-round").textContent = state.room.round;

  const { data: assignments } = await supabase
    .from("assignments").select("*, papers(content, author_id)")
    .eq("room_id", state.room.id).eq("round", state.room.round);

  const byId = Object.fromEntries(state.players.map((p) => [p.id, p]));
  const list = $("reveal-list");
  list.innerHTML = "";
  (assignments || []).forEach((a) => {
    const author = byId[a.papers.author_id];
    const guesser = byId[a.assigned_to];
    const guessed = byId[a.guessed_player_id];
    const correct = a.guessed_player_id === a.papers.author_id;
    const div = document.createElement("div");
    div.className = "reveal-item";
    div.innerHTML = `
      <div class="content">"${a.papers.content}"</div>
      <div>Written by <strong>${avatarMarkup(author?.avatar, "avatar-svg inline-avatar")} ${escapeHtml(author?.name || "Unknown")}</strong></div>
      <div>${avatarMarkup(guesser?.avatar, "avatar-svg inline-avatar")} ${escapeHtml(guesser?.name || "Unknown")} guessed <strong>${avatarMarkup(guessed?.avatar, "avatar-svg inline-avatar")} ${escapeHtml(guessed?.name || "—")}</strong>
        — <span class="verdict ${correct ? "correct" : "wrong"}">${correct ? "correct!" : "wrong"}</span></div>
    `;
    list.appendChild(div);
  });

  const board = $("scoreboard");
  board.innerHTML = "<strong>Scoreboard</strong>";
  [...state.players].sort((a, b) => b.score - a.score).forEach((p) => {
    const row = document.createElement("div");
    row.className = "score-row";
    row.innerHTML = `<span>${avatarMarkup(p.avatar, "avatar-svg inline-avatar")} ${escapeHtml(p.name)}</span><span>${p.score}</span>`;
    board.appendChild(row);
  });

  const host = isHost();
  $("reveal-host-controls").classList.toggle("hidden", !host);
  $("reveal-hint").textContent = host ? "" : "Waiting for the host to start the next round…";
}

async function nextRound() {
  state.currentWritingRound = null;
  const seconds = state.room.round_seconds;
  const endsAt = new Date(Date.now() + seconds * 1000).toISOString();
  await supabase.from("rooms").update({
    status: "writing",
    round: state.room.round + 1,
    writing_ends_at: endsAt,
  }).eq("id", state.room.id).eq("status", "reveal");
}

// ---------------------------------------------------------------------
// wire up events
// ---------------------------------------------------------------------
renderAvatarPicker();

$("avatar-prev").onclick = () => changeAvatar(-1);
$("avatar-next").onclick = () => changeAvatar(1);
$("btn-continue").onclick = continueFromName;
$("btn-back-name").onclick = backToName;

$("btn-create").onclick = createRoom;
$("btn-join").onclick = joinRoom;
$("btn-start").onclick = startGame;
$("btn-submit-paper").onclick = submitPaper;
$("btn-next-round").onclick = nextRound;
$("btn-leave").onclick = leaveRoom;

$("input-name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") continueFromName();
});

$("input-code").addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinRoom();
});

// Always start on the name screen when the website opens.
clearSession();
$("room-bar").classList.add("hidden");
showScreen("name");
