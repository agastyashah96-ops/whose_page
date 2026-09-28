import { supabase } from "./supabaseClient.js";
import { AVATARS } from "./avatars.js";

const $ = (id) => document.getElementById(id);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

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

// ---------------------------------------------------------------------
// avatar picker (home screen)
// ---------------------------------------------------------------------
function renderAvatarPicker() {
  const preview = $("avatar-preview");
  if (!preview || !AVATARS.length) return;
  preview.src = state.selectedAvatar;
  preview.alt = "Selected avatar";
  preview.classList.remove("pop");
  void preview.offsetWidth;
  preview.classList.add("pop");
}

function changeAvatar(direction) {
  if (!AVATARS.length) return;
  const current = AVATARS.indexOf(state.selectedAvatar);
  const next = ((current < 0 ? 0 : current) + direction + AVATARS.length) % AVATARS.length;
  state.selectedAvatar = AVATARS[next];
  renderAvatarPicker();
}

function continueFromName() {
  const name = $("input-name").value.trim();
  if (!name) return setError("name-error", "Enter your name first.");
  $("mode-name").textContent = name;
  $("mode-avatar").src = state.selectedAvatar;
  showScreen("mode");
}

function backToName() {
  showScreen("name");
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

  const { data: player, error: pErr } = await supabase
    .from("players")
    .insert({ room_id: room.id, name, avatar: state.selectedAvatar, is_host: false })
    .select()
    .single();
  if (pErr) return setError("name-error", pErr.message);

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
}

async function leaveRoom() {
  clearInterval(state.timerHandle);
  state.timerHandle = null;

  if (state.channel) {
    await supabase.removeChannel(state.channel);
  }

  if (state.playerId && isHost()) {
    const next = state.players.find((p) => p.id !== state.playerId);
    if (next) {
      await supabase.from("players").update({ is_host: true }).eq("id", next.id);
    }
  }

  if (state.playerId) {
    await supabase.from("players").delete().eq("id", state.playerId);
  }

  state.room = null;
  state.players = [];
  state.playerId = null;
  state.channel = null;
  state.guessTarget = null;

  $("room-bar").classList.add("hidden");
  $("room-bar-code").textContent = "";
  $("player-strip")?.classList.add("hidden");
  $("input-code").value = "";
  $("input-name").value = "";
  $("write-text").value = "";
  $("write-status").textContent = "";

  showScreen("name");
}

async function refreshPlayers() {
  const { data } = await supabase.from("players").select().eq("room_id", state.room.id).order("joined_at");
  state.players = data || [];
}

function subscribeRealtime(roomId) {
  if (state.channel) supabase.removeChannel(state.channel);

  state.channel = supabase
    .channel(`room-${roomId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
      async (payload) => {
        state.room = payload.new;
        renderForStatus();
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` },
      async () => {
        await refreshPlayers();
        renderForStatus();
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "papers", filter: `room_id=eq.${roomId}` },
      async () => {
        if (state.room?.status === "writing") await maybeAutoAdvanceWriting();
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
// Skribbl-style horizontal player strip
// ---------------------------------------------------------------------
async function renderPlayerStrip() {
  const strip = $("player-strip");
  if (!strip || !state.room || !state.players.length) return;

  const { data: papers } = await supabase
    .from("papers")
    .select("author_id")
    .eq("room_id", state.room.id)
    .eq("round", state.room.round);

  const submitted = new Set((papers || []).map((p) => p.author_id));
  strip.classList.remove("hidden");
  strip.innerHTML = "";

  state.players.forEach((p) => {
    const item = document.createElement("div");
    item.className = "player-chip" + (p.id === state.playerId ? " me" : "");
    if (submitted.has(p.id)) item.classList.add("submitted");

    const avatar = document.createElement("img");
    avatar.src = p.avatar;
    avatar.alt = "";
    avatar.className = "player-chip-avatar";

    const info = document.createElement("div");
    info.className = "player-chip-info";

    const name = document.createElement("span");
    name.className = "player-chip-name";
    name.textContent = p.name;

    const score = document.createElement("span");
    score.className = "player-chip-score";
    score.textContent = `${p.score ?? 0} pts`;

    const status = document.createElement("span");
    status.className = "player-chip-status";
    status.textContent = submitted.has(p.id) ? "✓" : "";

    info.append(name, score);
    item.append(avatar, info, status);
    strip.appendChild(item);
  });
}

// ---------------------------------------------------------------------
// dispatch UI based on room status
// ---------------------------------------------------------------------
function renderForStatus() {
  if (!state.room) {
    $("room-bar").classList.add("hidden");
    $("player-strip")?.classList.add("hidden");
    return;
  }

  $("room-bar").classList.remove("hidden");
  $("room-bar-code").textContent = state.room.code;

  switch (state.room.status) {
    case "lobby":
      $("player-strip")?.classList.add("hidden");
      renderLobby();
      showScreen("lobby");
      break;
    case "writing":
      renderWriting();
      renderPlayerStrip();
      showScreen("writing");
      break;
    case "guessing":
      renderPlayerStrip();
      renderGuessing();
      showScreen("guessing");
      break;
    case "reveal":
      renderPlayerStrip();
      renderReveal();
      showScreen("reveal");
      break;
    default:
      $("player-strip")?.classList.add("hidden");
      showScreen("lobby");
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
    const img = document.createElement("img");
    img.className = "mini-avatar";
    img.src = p.avatar;
    img.alt = "";
    li.append(img, document.createTextNode(p.name));
    if (p.is_host) {
      const tag = document.createElement("span");
      tag.className = "host-tag";
      tag.textContent = "HOST";
      li.appendChild(tag);
    }
    list.appendChild(li);
  });

  const host = isHost();
  $("lobby-host-controls").classList.toggle("hidden", !host);
  $("lobby-hint").textContent = host
    ? (state.players.length < 3 ? "Need at least 3 players to start." : "")
    : "Waiting for the host to start the game…";
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
  clearInterval(state.timerHandle);
  state.timerHandle = null;
  $("write-timer-state").textContent = "Submitted";
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
      const img = document.createElement("img");
      img.className = "mini-avatar";
      img.src = p.avatar;
      img.alt = "";
      card.append(img, document.createTextNode(p.name));
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
      <div>Written by <strong>${author?.avatar} ${author?.name}</strong></div>
      <div>${guesser?.avatar} ${guesser?.name} guessed <strong>${guessed?.avatar || ""} ${guessed?.name || "—"}</strong>
        — <span class="verdict ${correct ? "correct" : "wrong"}">${correct ? "correct!" : "wrong"}</span></div>
    `;
    list.appendChild(div);
  });

  const board = $("scoreboard");
  board.innerHTML = "<strong>Scoreboard</strong>";
  [...state.players].sort((a, b) => b.score - a.score).forEach((p) => {
    const row = document.createElement("div");
    row.className = "score-row";
    row.innerHTML = `<span>${p.avatar} ${p.name}</span><span>${p.score}</span>`;
    board.appendChild(row);
  });

  const host = isHost();
  $("reveal-host-controls").classList.toggle("hidden", !host);
  $("reveal-hint").textContent = host ? "" : "Waiting for the host to start the next round…";
}

async function nextRound() {
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

// IMPORTANT: there is intentionally NO automatic room rejoin here.
// Opening/reloading the site always starts at the name screen.
clearInterval(state.timerHandle);
$("room-bar").classList.add("hidden");
$("player-strip")?.classList.add("hidden");
showScreen("name");
