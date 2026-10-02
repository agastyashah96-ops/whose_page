import { supabase } from "./supabaseClient.js";
import { AVATARS, avatarMarkup } from "./avatars.js";
import { BUILT_IN_TOPICS } from "./topics.js";

const $ = (id) => document.getElementById(id);

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_PLAYERS = 8;
const MAX_CUSTOM_TOPICS = 10;

// ---------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------
const state = {
  room: null,
  playerId: null,
  selectedAvatar: AVATARS[0],
  players: [],
  channel: null,
  timerHandle: null,
  guessTarget: null,
  currentWritingRound: null,
  guessRenderSeq: 0,
  submittingGuess: false,
  revealCards: [],
  revealIndex: 0,
  revealRound: null,
  kickSelectedId: null,
};

let noticeTimer = null;

let creatingRoom = false;
let joiningRoom = false;
let leavingRoom = false;
let startingGame = false;
let submittingPaper = false;
let startingNextRound = false;
let kickingPlayer = false;
let initialized = false;

// ---------------------------------------------------------------------
// SCREENS
// ---------------------------------------------------------------------
const TITLE_SCREENS = ["name", "mode", "lobby"];

function showScreen(name) {
  document
    .querySelectorAll(".screen")
    .forEach((s) => s.classList.remove("active"));

  const screen = $(`screen-${name}`);

  if (screen) {
    screen.classList.add("active");
  }

  const title = $("site-title");

  if (title) {
    title.classList.toggle(
      "hidden",
      !TITLE_SCREENS.includes(name)
    );
  }
}

// ---------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------
function randomCode(len = 5) {
  let out = "";

  for (let i = 0; i < len; i++) {
    out += CODE_CHARS[
      Math.floor(Math.random() * CODE_CHARS.length)
    ];
  }

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

function clearSession() {
  localStorage.removeItem("bp_session");
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[char]
  );
}

function setError(id, msg) {
  const el = $(id);

  if (!el) return;

  el.textContent = msg;

  setTimeout(() => {
    if (el.textContent === msg) {
      el.textContent = "";
    }
  }, 4000);
}

function showLobbyNotice(msg) {
  const el = $("lobby-notice");

  if (!el) return;

  el.textContent = msg;
  el.classList.remove("hidden");

  clearTimeout(noticeTimer);

  noticeTimer = setTimeout(() => {
    el.classList.add("hidden");
    el.textContent = "";
  }, 6000);
}

// Safe event binding.
function bindClick(id, handler) {
  const el = $(id);

  if (!el) {
    console.warn(`[Blank Page] Missing element: #${id}`);
    return;
  }

  el.onclick = handler;
}

function bindChange(id, handler) {
  const el = $(id);

  if (!el) {
    console.warn(`[Blank Page] Missing element: #${id}`);
    return;
  }

  el.onchange = handler;
}

// ---------------------------------------------------------------------
// AVATAR PICKER
// ---------------------------------------------------------------------
function renderAvatarPicker() {
  const preview = $("avatar-preview");

  if (!preview) return;

  preview.innerHTML = avatarMarkup(
    state.selectedAvatar,
    "avatar-svg avatar-preview-img"
  );

  preview.classList.remove("pop");

  void preview.offsetWidth;

  preview.classList.add("pop");
}

function changeAvatar(direction) {
  const current = AVATARS.indexOf(
    state.selectedAvatar
  );

  const next =
    (current + direction + AVATARS.length) %
    AVATARS.length;

  state.selectedAvatar = AVATARS[next];

  renderAvatarPicker();
}

function continueFromName() {
  const input = $("input-name");

  if (!input) return;

  const name = input.value.trim();

  if (!name) {
    return setError(
      "name-error",
      "Enter your name first."
    );
  }

  if ($("mode-name")) {
    $("mode-name").textContent = name;
  }

  if ($("mode-avatar")) {
    $("mode-avatar").innerHTML = avatarMarkup(
      state.selectedAvatar,
      "avatar-svg avatar-mode-img"
    );
  }

  showScreen("mode");
}

function backToName() {
  showScreen("name");

  if ($("mode-name")) {
    $("mode-name").textContent = "";
  }

  if ($("mode-avatar")) {
    $("mode-avatar").textContent = "";
  }
}

// ---------------------------------------------------------------------
// CREATE ROOM
// ---------------------------------------------------------------------
async function createRoom() {
  if (creatingRoom) return;

  creatingRoom = true;

  const button = $("btn-create");

  if (button) {
    button.disabled = true;
    button.classList.add("loading");

    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }

    button.textContent = "Creating...";
  }

  try {
    const input = $("input-name");

    if (!input) return;

    const name = input.value.trim();

    if (!name) {
      setError(
        "name-error",
        "Enter your name first."
      );
      return;
    }

    let code;
    let existing;

    do {
      code = randomCode();

      const result = await supabase
        .from("rooms")
        .select("id")
        .eq("code", code)
        .maybeSingle();

      existing = result.data;
    } while (existing);

    const {
      data: room,
      error,
    } = await supabase
      .from("rooms")
      .insert({ code })
      .select()
      .single();

    if (error) {
      setError("name-error", error.message);
      return;
    }

    const {
      data: player,
      error: pErr,
    } = await supabase
      .from("players")
      .insert({
        room_id: room.id,
        name,
        avatar: state.selectedAvatar,
        is_host: true,
      })
      .select()
      .single();

    if (pErr) {
      setError("name-error", pErr.message);
      return;
    }

    clearSession();

    await enterRoom(
      room.id,
      player.id
    );
  } catch (error) {
    console.error(
      "Create room error:",
      error
    );

    setError(
      "name-error",
      "Could not create the room."
    );
  } finally {
    creatingRoom = false;

    if (button) {
      button.disabled = false;
      button.classList.remove("loading");

      if (button.dataset.originalText) {
        button.textContent =
          button.dataset.originalText;
      }
    }
  }
}

// ---------------------------------------------------------------------
// JOIN ROOM
// ---------------------------------------------------------------------
async function joinRoom() {
  if (joiningRoom) return;

  joiningRoom = true;

  const button = $("btn-join");

  if (button) {
    button.disabled = true;
    button.classList.add("loading");

    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }

    button.textContent = "Joining...";
  }

  try {
    const nameInput = $("input-name");
    const codeInput = $("input-code");

    if (!nameInput || !codeInput) {
      return;
    }

    const name = nameInput.value.trim();

    const code = codeInput.value
      .trim()
      .toUpperCase();

    if (!name) {
      setError(
        "name-error",
        "Enter your name first."
      );
      return;
    }

    if (!code) {
      setError(
        "name-error",
        "Enter a room code."
      );
      return;
    }

    const {
      data: room,
      error,
    } = await supabase
      .from("rooms")
      .select()
      .eq("code", code)
      .maybeSingle();

    if (error || !room) {
      setError(
        "name-error",
        "Room not found."
      );
      return;
    }

    if (room.status !== "lobby") {
      setError(
        "name-error",
        "That game already started."
      );
      return;
    }

    const { count } =
      await supabase
        .from("players")
        .select("id", {
          count: "exact",
          head: true,
        })
        .eq("room_id", room.id);

    if ((count ?? 0) >= MAX_PLAYERS) {
      setError(
        "name-error",
        `Room is full (max ${MAX_PLAYERS} players).`
      );
      return;
    }

    const {
      data: player,
      error: pErr,
    } = await supabase
      .from("players")
      .insert({
        room_id: room.id,
        name,
        avatar: state.selectedAvatar,
        is_host: false,
      })
      .select()
      .single();

    if (pErr) {
      setError(
        "name-error",
        pErr.message
      );
      return;
    }

    clearSession();

    await enterRoom(
      room.id,
      player.id
    );
  } catch (error) {
    console.error(
      "Join room error:",
      error
    );

    setError(
      "name-error",
      "Could not join the room."
    );
  } finally {
    joiningRoom = false;

    if (button) {
      button.disabled = false;
      button.classList.remove("loading");

      if (button.dataset.originalText) {
        button.textContent =
          button.dataset.originalText;
      }
    }
  }
}

// ---------------------------------------------------------------------
// ENTER ROOM
// ---------------------------------------------------------------------
async function enterRoom(
  roomId,
  playerId
) {
  state.playerId = playerId;

  const {
    data: room,
    error,
  } = await supabase
    .from("rooms")
    .select()
    .eq("id", roomId)
    .single();

  if (error || !room) {
    setError(
      "name-error",
      "Could not enter the room."
    );
    return;
  }

  state.room = room;

  await refreshPlayers();

  subscribeRealtime(roomId);

  $("room-bar")?.classList.remove("hidden");

  if ($("room-bar-code")) {
    $("room-bar-code").textContent =
      room.code;
  }

  renderForStatus();

  await renderPlayerStrip();
}

// ---------------------------------------------------------------------
// LEAVE ROOM
// ---------------------------------------------------------------------
async function leaveRoom() {
  if (leavingRoom) return;

  leavingRoom = true;

  try {
    clearInterval(state.timerHandle);

    state.timerHandle = null;

    if (state.channel) {
      await supabase.removeChannel(
        state.channel
      );

      state.channel = null;
    }

    if (isHost()) {
      const next =
        state.players.find(
          (p) =>
            p.id !==
            state.playerId
        );

      if (next) {
        await supabase
          .from("players")
          .update({
            is_host: true,
          })
          .eq(
            "id",
            next.id
          );
      }
    }

    if (state.playerId) {
      await supabase
        .from("players")
        .delete()
        .eq(
          "id",
          state.playerId
        );
    }

    clearSession();

    state.room = null;
    state.players = [];
    state.playerId = null;
    state.channel = null;
    state.guessTarget = null;
    state.currentWritingRound = null;
    state.revealCards = [];
    state.revealIndex = 0;
    state.revealRound = null;
    state.kickSelectedId = null;

    clearTimeout(noticeTimer);
    $("lobby-notice")?.classList.add("hidden");

    $("room-bar")?.classList.add("hidden");

    $("player-strip")?.classList.add("hidden");

    if ($("player-strip")) {
      $("player-strip").innerHTML = "";
    }

    if ($("room-bar-code")) {
      $("room-bar-code").textContent = "";
    }

    if ($("input-code")) {
      $("input-code").value = "";
    }

    if ($("write-text")) {
      $("write-text").value = "";
    }

    if ($("write-status")) {
      $("write-status").textContent = "";
    }

    if ($("input-topic")) {
      $("input-topic").value = "";
    }

    showScreen("name");
  } catch (error) {
    console.error(
      "Leave room error:",
      error
    );
  } finally {
    leavingRoom = false;
  }
}

// ---------------------------------------------------------------------
// PLAYERS
// ---------------------------------------------------------------------
async function refreshPlayers() {
  if (!state.room) return;

  const {
    data,
    error,
  } = await supabase
    .from("players")
    .select()
    .eq(
      "room_id",
      state.room.id
    )
    .order("joined_at");

  if (!error) {
    state.players = data || [];
  }
}

async function renderPlayerStrip() {
  const strip = $("player-strip");

  if (
    !strip ||
    !state.room ||
    !state.playerId
  ) {
    return;
  }

  const status = state.room.status;

  const show = [
    "writing",
    "guessing",
    "reveal",
  ].includes(status);

  strip.classList.toggle(
    "hidden",
    !show
  );

  if (!show) return;

  let doneIds = new Set();
  const progress = {};

  if (status === "writing") {
    const { data: papers } =
      await supabase
        .from("papers")
        .select("author_id")
        .eq(
          "room_id",
          state.room.id
        )
        .eq(
          "round",
          state.room.round
        );

    doneIds = new Set(
      (papers || []).map(
        (p) => p.author_id
      )
    );
  } else if (status === "guessing") {
    const {
      data: assignments,
    } = await supabase
      .from("assignments")
      .select(
        "assigned_to, guessed_player_id"
      )
      .eq(
        "room_id",
        state.room.id
      )
      .eq(
        "round",
        state.room.round
      );

    (assignments || []).forEach((a) => {
      const pr =
        (progress[a.assigned_to] ||= {
          total: 0,
          answered: 0,
        });

      pr.total++;

      if (
        a.guessed_player_id !==
        null
      ) {
        pr.answered++;
      }
    });

    doneIds = new Set(
      state.players
        .filter((pl) => {
          const pr =
            progress[pl.id];

          return (
            !pr ||
            pr.answered >=
              pr.total
          );
        })
        .map(
          (pl) => pl.id
        )
    );
  } else {
    doneIds = new Set(
      state.players.map(
        (p) => p.id
      )
    );
  }

  strip.innerHTML = "";

  state.players.forEach((p) => {
    const card =
      document.createElement("div");

    const done =
      doneIds.has(p.id);

    const me =
      p.id === state.playerId;

    card.className =
      `player-tab${done ? " done" : ""}${me ? " me" : ""}`;

    card.title =
      `${p.name} · ${p.score ?? 0} point${
        p.score === 1 ? "" : "s"
      }`;

    const statusLabel =
      status === "writing"
        ? done
          ? "Done"
          : "Writing…"
        : status === "guessing"
          ? done
            ? "Done"
            : `${
                progress[p.id]?.answered ?? 0
              }/${
                progress[p.id]?.total ?? 0
              }`
          : "Done";

    card.innerHTML = `
      <div class="player-tab-avatar">
        ${avatarMarkup(
          p.avatar,
          "avatar-svg"
        )}
      </div>

      <div class="player-tab-info">
        <div class="player-tab-name">
          ${escapeHtml(p.name)}
        </div>

        <div class="player-tab-status">
          <span class="player-status-dot"></span>
          ${statusLabel}
        </div>
      </div>

      <div class="player-tab-score">
        ${p.score ?? 0}
      </div>
    `;

    strip.appendChild(card);
  });
}

// ---------------------------------------------------------------------
// REALTIME
// ---------------------------------------------------------------------
function subscribeRealtime(roomId) {
  if (state.channel) {
    supabase.removeChannel(
      state.channel
    );
  }

  state.channel =
    supabase
      .channel(`room-${roomId}`)

      // ROOMS
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rooms",
          filter: `id=eq.${roomId}`,
        },
        async (payload) => {
          const previousStatus =
            state.room?.status;

          const previousRound =
            state.room?.round;

          state.room = payload.new;

          // Never rebuild writing form
          // while player is typing.
          if (
            state.room.status ===
              "writing" &&
            previousStatus ===
              "writing" &&
            previousRound ===
              state.room.round
          ) {
            await renderPlayerStrip();
            return;
          }

          renderForStatus();

          await renderPlayerStrip();
        }
      )

      // PLAYERS
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "players",
          filter: `room_id=eq.${roomId}`,
        },
        async (payload) => {
          // ---------------------------------------------------------
          // KICK DETECTION
          // ---------------------------------------------------------
          if (
            payload.eventType ===
              "DELETE" &&
            payload.old?.id ===
              state.playerId
          ) {
            alert(
              "You were removed from the room."
            );

            await leaveRoom();
            return;
          }

          await refreshPlayers();

          await renderPlayerStrip();

          // Never rebuild writing screen
          // because somebody joined/left.
          if (
            state.room?.status ===
            "writing"
          ) {
            return;
          }

          renderForStatus();
        }
      )

      // PAPERS
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "papers",
          filter: `room_id=eq.${roomId}`,
        },
        async () => {
          if (
            state.room?.status ===
            "writing"
          ) {
            await renderPlayerStrip();

            await maybeAutoAdvanceWriting();
          }
        }
      )

      // ASSIGNMENTS
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "assignments",
          filter: `room_id=eq.${roomId}`,
        },
        async () => {
          if (
            state.room?.status ===
            "guessing"
          ) {
            await renderGuessing();

            await maybeAutoAdvanceGuessing();
          }
        }
      )

      // KICK NOTICE (broadcast by the host)
      .on(
        "broadcast",
        { event: "kicked" },
        ({ payload }) => {
          if (payload?.name) {
            showLobbyNotice(
              `${payload.name} was kicked from the room.`
            );
          }
        }
      )

      .subscribe();
}

function isHost() {
  const me =
    state.players.find(
      (p) =>
        p.id ===
        state.playerId
    );

  return !!me?.is_host;
}

// ---------------------------------------------------------------------
// SCREEN DISPATCH
// ---------------------------------------------------------------------
function renderForStatus() {
  if (!state.room) return;

  switch (
    state.room.status
  ) {
    case "lobby":
      renderLobby();
      showScreen("lobby");
      break;

    case "writing":
      renderWriting();
      showScreen("writing");
      break;

    case "guessing":
      renderGuessing();
      showScreen("guessing");
      break;

    case "reveal":
      renderReveal();
      showScreen("reveal");
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------
// KICK PLAYER
// ---------------------------------------------------------------------
async function kickPlayer(playerId) {
  if (kickingPlayer) return;

  if (!state.room || !state.playerId) {
    return;
  }

  if (!isHost()) {
    alert("Only the host can kick players.");
    return;
  }

  if (playerId === state.playerId) {
    alert("You cannot kick yourself.");
    return;
  }

  const player =
    state.players.find(
      (p) =>
        p.id === playerId
    );

  if (!player) {
    return;
  }

  const confirmed = confirm(
    `Kick ${player.name} from the room?`
  );

  if (!confirmed) {
    return;
  }

  kickingPlayer = true;

  const button =
    document.querySelector(
      `.kick-player[data-player-id="${playerId}"]`
    );

  if (button) {
    button.disabled = true;
    button.textContent = "Kicking...";
  }

  try {
    const {
      error,
    } = await supabase
      .from("players")
      .delete()
      .eq(
        "id",
        playerId
      )
      .eq(
        "room_id",
        state.room.id
      );

    if (error) {
      console.error(
        "Kick player error:",
        error
      );

      alert(
        "Could not kick the player: " +
          error.message
      );

      if (button) {
        button.disabled = false;
        button.textContent = "Kick";
      }

      return;
    }

    state.kickSelectedId = null;

    // Tell everyone else in the lobby who was kicked.
    state.channel?.send({
      type: "broadcast",
      event: "kicked",
      payload: { name: player.name },
    });

    showLobbyNotice(
      `${player.name} was kicked from the room.`
    );

    await refreshPlayers();

    renderLobby();
  } catch (error) {
    console.error(
      "Kick player error:",
      error
    );

    alert(
      "Could not kick the player."
    );

    if (button) {
      button.disabled = false;
      button.textContent = "Kick";
    }
  } finally {
    kickingPlayer = false;
  }
}

// ---------------------------------------------------------------------
// LOBBY
// ---------------------------------------------------------------------
function renderLobby() {
  if (!state.room) return;

  if ($("lobby-code")) {
    $("lobby-code").textContent =
      state.room.code;
  }

  const list =
    $("lobby-players");

  const host =
    isHost();

  if (list) {
    list.innerHTML = "";

    if (
      state.kickSelectedId &&
      !state.players.some(
        (p) =>
          p.id ===
          state.kickSelectedId
      )
    ) {
      state.kickSelectedId = null;
    }

    state.players.forEach((p) => {
      const li =
        document.createElement("li");

      const kickable =
        host &&
        p.id !== state.playerId;

      if (kickable) {
        li.classList.add(
          "kickable"
        );

        li.classList.toggle(
          "kick-open",
          state.kickSelectedId ===
            p.id
        );

        li.onclick = () => {
          state.kickSelectedId =
            state.kickSelectedId ===
            p.id
              ? null
              : p.id;

          renderLobby();
        };
      }

      li.innerHTML = `
        <div class="lobby-player-info">

          ${avatarMarkup(
            p.avatar,
            "avatar-svg lobby-avatar"
          )}

          <span>
            ${escapeHtml(p.name)}
          </span>

          ${
            p.is_host
              ? `<span class="host-tag">HOST</span>`
              : ""
          }

        </div>

        ${
          host &&
          p.id !== state.playerId
            ? `
              <button
                type="button"
                class="kick-player"
                data-player-id="${p.id}"
              >
                Kick
              </button>
            `
            : ""
        }
      `;

      list.appendChild(li);

      // Bind this specific kick button.
      const kickButton =
        li.querySelector(
          ".kick-player"
        );

      if (kickButton) {
        kickButton.onclick = (e) => {
          e.stopPropagation();

          kickPlayer(
            p.id
          );
        };
      }
    });
  }

  $("lobby-host-controls")
    ?.classList.toggle(
      "hidden",
      !host
    );

  const countLabel =
    `${state.players.length}/${MAX_PLAYERS} players`;

  if ($("lobby-hint")) {
    $("lobby-hint").textContent =
      host
        ? state.players.length < 3
          ? `Need at least 3 players to start. (${countLabel})`
          : countLabel
        : `Waiting for the host to start the game… (${countLabel})`;
  }

  if ($("btn-start")) {
    $("btn-start").disabled =
      state.players.length < 3;
  }

  // EXTEMPORE
  const extempore =
    !!state.room.extempore;

  if ($("toggle-extempore")) {
    $("toggle-extempore").checked =
      extempore;
  }

  $("extempore-options")
    ?.classList.toggle(
      "hidden",
      !(host && extempore)
    );

  if ($("lobby-mode-note")) {
    $("lobby-mode-note").textContent =
      extempore
        ? "🎤 Extempore mode: everyone writes on the same topic each round."
        : "";
  }

  // CUSTOM TOPICS
  const topicList =
    $("custom-topic-list");

  if (topicList) {
    topicList.innerHTML = "";

    (
      state.room.custom_topics || []
    ).forEach(
      (topic, index) => {
        const li =
          document.createElement(
            "li"
          );

        li.className =
          "topic-chip";

        const span =
          document.createElement(
            "span"
          );

        span.textContent =
          topic;

        const remove =
          document.createElement(
            "button"
          );

        remove.type = "button";
        remove.textContent = "✕";

        remove.setAttribute(
          "aria-label",
          `Remove topic ${topic}`
        );

        remove.onclick = () =>
          removeCustomTopic(
            index
          );

        li.appendChild(span);
        li.appendChild(remove);

        topicList.appendChild(li);
      }
    );
  }
}

// ---------------------------------------------------------------------
// EXTEMPORE
// ---------------------------------------------------------------------
async function toggleExtempore() {
  if (
    !state.room ||
    !isHost()
  ) {
    return;
  }

  const checkbox =
    $("toggle-extempore");

  if (!checkbox) return;

  const on =
    checkbox.checked;

  const { error } =
    await supabase
      .from("rooms")
      .update({
        extempore: on,
      })
      .eq(
        "id",
        state.room.id
      );

  if (error) {
    checkbox.checked = !on;

    alert(
      "Could not change Extempore mode: " +
        error.message
    );
  }
}

async function addCustomTopic() {
  if (
    !state.room ||
    !isHost()
  ) {
    return;
  }

  const input =
    $("input-topic");

  if (!input) return;

  const text =
    input.value
      .trim()
      .replace(/\s+/g, " ");

  if (!text) return;

  const list =
    state.room.custom_topics ||
    [];

  if (
    list.length >=
    MAX_CUSTOM_TOPICS
  ) {
    return setError(
      "topic-error",
      `Up to ${MAX_CUSTOM_TOPICS} custom topics.`
    );
  }

  if (
    list.some(
      (t) =>
        t.toLowerCase() ===
        text.toLowerCase()
    )
  ) {
    return setError(
      "topic-error",
      "You already added that one."
    );
  }

  const next = [
    ...list,
    text,
  ];

  input.value = "";

  state.room.custom_topics =
    next;

  renderLobby();

  const { error } =
    await supabase
      .from("rooms")
      .update({
        custom_topics: next,
      })
      .eq(
        "id",
        state.room.id
      );

  if (error) {
    setError(
      "topic-error",
      error.message
    );
  }
}

async function removeCustomTopic(
  index
) {
  if (
    !state.room ||
    !isHost()
  ) {
    return;
  }

  const next =
    (
      state.room.custom_topics ||
      []
    ).filter(
      (_, i) => i !== index
    );

  state.room.custom_topics =
    next;

  renderLobby();

  const { error } =
    await supabase
      .from("rooms")
      .update({
        custom_topics: next,
      })
      .eq(
        "id",
        state.room.id
      );

  if (error) {
    setError(
      "topic-error",
      error.message
    );
  }
}

// ---------------------------------------------------------------------
// TOPICS
// ---------------------------------------------------------------------
function pickTopic(room) {
  const custom =
    room.custom_topics ||
    [];

  let used =
    room.used_topics ||
    [];

  const unused = (list) =>
    list.filter(
      (t) =>
        !used.includes(t)
    );

  let pool =
    unused(custom);

  if (pool.length === 0) {
    pool =
      unused(
        BUILT_IN_TOPICS
      );
  }

  if (pool.length === 0) {
    used = [];

    pool =
      custom.length
        ? custom
        : BUILT_IN_TOPICS;
  }

  const topic =
    pool[
      Math.floor(
        Math.random() *
          pool.length
      )
    ];

  return {
    topic,
    used: [
      ...used,
      topic,
    ],
  };
}

function renderTopicLine(id) {
  const el = $(id);

  if (!el) return;

  const topic =
    state.room?.extempore
      ? state.room.topic
      : null;

  el.textContent =
    topic
      ? `Topic: ${topic}`
      : "";

  el.classList.toggle(
    "hidden",
    !topic
  );
}

// ---------------------------------------------------------------------
// START GAME
// ---------------------------------------------------------------------
async function startGame() {
  if (startingGame) return;

  if (
    !state.room ||
    !isHost()
  ) {
    return;
  }

  startingGame = true;

  const button =
    $("btn-start");

  if (button) {
    button.disabled = true;

    if (!button.dataset.originalText) {
      button.dataset.originalText =
        button.textContent;
    }

    button.textContent =
      "Starting...";
  }

  try {
    const seconds =
      parseInt(
        $("select-seconds")
          ?.value,
        10
      ) || 60;

    const endsAt =
      new Date(
        Date.now() +
          seconds * 1000
      ).toISOString();

    const update = {
      status: "writing",
      round: 1,
      round_seconds:
        seconds,
      writing_ends_at:
        endsAt,
    };

    if (
      state.room.extempore
    ) {
      const {
        topic,
        used,
      } =
        pickTopic({
          ...state.room,
          used_topics: [],
        });

      update.topic =
        topic;

      update.used_topics =
        used;
    }

    const { error } =
      await supabase
        .from("rooms")
        .update(update)
        .eq(
          "id",
          state.room.id
        )
        .eq(
          "status",
          "lobby"
        );

    if (error) {
      alert(
        "Could not start the game: " +
          error.message
      );
    }
  } finally {
    startingGame = false;

    if (button) {
      button.disabled =
        state.players.length <
        3;

      if (
        button.dataset
          .originalText
      ) {
        button.textContent =
          button.dataset
            .originalText;
      }
    }
  }
}

// ---------------------------------------------------------------------
// WRITING
// ---------------------------------------------------------------------
function renderWriting() {
  if (!state.room) return;

  if ($("write-round")) {
    $("write-round").textContent =
      state.room.round;
  }

  const topic =
    state.room.extempore
      ? state.room.topic
      : null;

  $("write-topic")
    ?.classList.toggle(
      "hidden",
      !topic
    );

  if ($("write-topic-text")) {
    $("write-topic-text").textContent =
      topic || "";
  }

  if ($("write-text")) {
    $("write-text").placeholder =
      topic
        ? "Write about the topic above — make it good, funny or weird. Someone will have to guess it's you."
        : "Write anything — a confession, a lie, a weird fact. Someone will have to guess it's you.";
  }

  // DO NOT RESET THE TEXTAREA
  if (
    state.currentWritingRound ===
    state.room.round
  ) {
    return;
  }

  state.currentWritingRound =
    state.room.round;

  if ($("write-text")) {
    $("write-text").value = "";
    $("write-text").disabled =
      false;
  }

  if ($("btn-submit-paper")) {
    $("btn-submit-paper").disabled =
      false;
  }

  if ($("write-status")) {
    $("write-status").textContent =
      "";
  }

  startCountdown(
    state.room.writing_ends_at
  );
}

// ---------------------------------------------------------------------
// COUNTDOWN
// ---------------------------------------------------------------------
function startCountdown(
  endsAtISO
) {
  clearInterval(
    state.timerHandle
  );

  if (!endsAtISO) return;

  const endsAt =
    new Date(
      endsAtISO
    ).getTime();

  const tick = () => {
    const remaining =
      Math.max(
        0,
        Math.round(
          (endsAt -
            Date.now()) /
            1000
        )
      );

    const el =
      $("write-timer");

    if (el) {
      el.textContent =
        remaining;

      el.classList.toggle(
        "low",
        remaining <= 10
      );
    }

    if (remaining <= 0) {
      clearInterval(
        state.timerHandle
      );

      if ($("write-text")) {
        $("write-text").disabled =
          true;
      }

      if ($("btn-submit-paper")) {
        $("btn-submit-paper").disabled =
          true;
      }

      if ($("write-status")) {
        $("write-status").textContent =
          "Time's up — shuffling papers…";
      }

      if (isHost()) {
        claimAndDistribute();
      }
    }
  };

  tick();

  state.timerHandle =
    setInterval(
      tick,
      250
    );
}

// ---------------------------------------------------------------------
// SUBMIT PAPER
// ---------------------------------------------------------------------
async function submitPaper() {
  if (submittingPaper) {
    return;
  }

  if (
    !state.room ||
    !state.playerId
  ) {
    return;
  }

  const textarea =
    $("write-text");

  if (!textarea) return;

  const content =
    textarea.value.trim();

  if (!content) return;

  submittingPaper = true;

  const button =
    $("btn-submit-paper");

  if (button) {
    button.disabled = true;

    if (!button.dataset.originalText) {
      button.dataset.originalText =
        button.textContent;
    }

    button.textContent =
      "Submitted";
  }

  try {
    const { error } =
      await supabase
        .from("papers")
        .insert({
          room_id:
            state.room.id,
          round:
            state.room.round,
          author_id:
            state.playerId,
          content,
        });

    if ($("write-status")) {
      $("write-status").textContent =
        error
          ? "Could not submit. Try again."
          : "Submitted. Waiting for others…";
    }

    if (!error) {
      textarea.disabled = true;
    }

    await renderPlayerStrip();

    await maybeAutoAdvanceWriting();
  } catch (error) {
    console.error(
      "Submit paper error:",
      error
    );

    if ($("write-status")) {
      $("write-status").textContent =
        "Could not submit. Try again.";
    }

    if (button) {
      button.disabled = false;
    }
  } finally {
    submittingPaper = false;

    if (button) {
      if (
        button.dataset
          .originalText
      ) {
        button.textContent =
          button.dataset
            .originalText;
      }
    }
  }
}

// ---------------------------------------------------------------------
// AUTO ADVANCE WRITING
// ---------------------------------------------------------------------
async function maybeAutoAdvanceWriting() {
  if (
    !state.room ||
    state.room.status !==
      "writing"
  ) {
    return;
  }

  const { data: papers } =
    await supabase
      .from("papers")
      .select("author_id")
      .eq(
        "room_id",
        state.room.id
      )
      .eq(
        "round",
        state.room.round
      );

  if (
    (papers?.length || 0) >=
      state.players.length &&
    isHost()
  ) {
    await claimAndDistribute();
  }
}

// ---------------------------------------------------------------------
// SHUFFLE + DISTRIBUTE
// ---------------------------------------------------------------------
async function claimAndDistribute() {
  if (!state.room) return;

  const { data: claimed } =
    await supabase
      .from("rooms")
      .update({
        status:
          "distributing",
      })
      .eq(
        "id",
        state.room.id
      )
      .eq(
        "status",
        "writing"
      )
      .select();

  if (
    !claimed ||
    claimed.length === 0
  ) {
    return;
  }

  await backfillMissingPapers();

  const made =
    await assignPapers();

  await supabase
    .from("rooms")
    .update({
      status:
        made > 0
          ? "guessing"
          : "reveal",
    })
    .eq(
      "id",
      state.room.id
    );
}

async function backfillMissingPapers() {
  const { data: papers } =
    await supabase
      .from("papers")
      .select("author_id")
      .eq(
        "room_id",
        state.room.id
      )
      .eq(
        "round",
        state.room.round
      );

  const wrote =
    new Set(
      (papers || []).map(
        (p) => p.author_id
      )
    );

  const missing =
    state.players.filter(
      (p) =>
        !wrote.has(p.id)
    );

  if (missing.length === 0) {
    return;
  }

  await supabase
    .from("papers")
    .insert(
      missing.map((p) => ({
        room_id:
          state.room.id,
        round:
          state.room.round,
        author_id:
          p.id,
        content:
          "🤷 (didn't write anything in time)",
        auto_filled: true,
      }))
    );
}

// ---------------------------------------------------------------------
// ASSIGN PAPERS
// ---------------------------------------------------------------------
async function assignPapers() {
  await refreshPlayers();

  const { data: papers } =
    await supabase
      .from("papers")
      .select()
      .eq(
        "room_id",
        state.room.id
      )
      .eq(
        "round",
        state.room.round
      );

  const realPapers =
    (papers || []).filter(
      (p) =>
        !p.auto_filled
    );

  const rows = [];

  realPapers.forEach(
    (paper) => {
      state.players.forEach(
        (player) => {
          if (
            player.id ===
            paper.author_id
          ) {
            return;
          }

          rows.push({
            room_id:
              state.room.id,
            round:
              state.room.round,
            paper_id:
              paper.id,
            assigned_to:
              player.id,
          });
        }
      );
    }
  );

  if (rows.length > 0) {
    const { error } =
      await supabase
        .from("assignments")
        .insert(rows);

    if (error) {
      console.error(
        "Could not create assignments:",
        error
      );

      alert(
        "Could not deal the papers: " +
          error.message
      );

      return 0;
    }
  }

  return rows.length;
}

// ---------------------------------------------------------------------
// GUESSING
// ---------------------------------------------------------------------
async function renderGuessing() {
  const seq =
    ++state.guessRenderSeq;

  renderTopicLine(
    "guess-topic"
  );

  await renderPlayerStrip();

  if (!state.room) return;

  const { data } =
    await supabase
      .from("assignments")
      .select(
        "id, guessed_player_id, papers(content)"
      )
      .eq(
        "room_id",
        state.room.id
      )
      .eq(
        "round",
        state.room.round
      )
      .eq(
        "assigned_to",
        state.playerId
      )
      .order("id");

  if (
    seq !==
    state.guessRenderSeq
  ) {
    return;
  }

  const mine =
    data || [];

  const total =
    mine.length;

  const answered =
    mine.filter(
      (a) =>
        a.guessed_player_id !==
        null
    ).length;

  const current =
    mine.find(
      (a) =>
        a.guessed_player_id ===
        null
    );

  const grid =
    $("guess-player-grid");

  if (grid) {
    grid.innerHTML = "";
  }

  if (total === 0) {
    if ($("guess-progress")) {
      $("guess-progress").textContent =
        "";
    }

    if ($("guess-paper-text")) {
      $("guess-paper-text").textContent =
        "There's nothing for you to guess this round.";
    }

    if ($("guess-status")) {
      $("guess-status").textContent =
        "Waiting for everyone else…";
    }

    return;
  }

  if (!current) {
    $("guess-progress").textContent =
      `${total} of ${total} guessed`;

    $("guess-paper-text").textContent =
      "All your guesses are locked in. 🔒";

    $("guess-status").textContent =
      "Waiting for everyone else…";

    return;
  }

  $("guess-progress").textContent =
    `Paper ${answered + 1} of ${total}`;

  $("guess-paper-text").textContent =
    current.papers.content;

  $("guess-status").textContent =
    "Who wrote this paper? Tap a player.";

  if (!grid) return;

  state.players
    .filter(
      (p) =>
        p.id !==
        state.playerId
    )
    .forEach(
      (p) => {
        const card =
          document.createElement(
            "div"
          );

        card.className =
          "player-card";

        card.innerHTML = `
          ${avatarMarkup(
            p.avatar,
            "avatar-svg guess-avatar"
          )}

          ${escapeHtml(
            p.name
          )}
        `;

        card.onclick = () =>
          submitGuess(
            current.id,
            p.id
          );

        grid.appendChild(
          card
        );
      }
    );
}

// ---------------------------------------------------------------------
// SUBMIT GUESS
// ---------------------------------------------------------------------
async function submitGuess(
  assignmentId,
  guessedPlayerId
) {
  if (
    state.submittingGuess
  ) {
    return;
  }

  state.submittingGuess =
    true;

  try {
    await supabase
      .from("assignments")
      .update({
        guessed_player_id:
          guessedPlayerId,
      })
      .eq(
        "id",
        assignmentId
      )
      .is(
        "guessed_player_id",
        null
      );

    await renderGuessing();

    await maybeAutoAdvanceGuessing();
  } finally {
    state.submittingGuess =
      false;
  }
}

// ---------------------------------------------------------------------
// AUTO ADVANCE GUESSING
// ---------------------------------------------------------------------
async function maybeAutoAdvanceGuessing() {
  if (
    state.room?.status !==
    "guessing"
  ) {
    return;
  }

  const {
    data: assignments,
  } = await supabase
    .from("assignments")
    .select(
      "guessed_player_id"
    )
    .eq(
      "room_id",
      state.room.id
    )
    .eq(
      "round",
      state.room.round
    );

  const allGuessed =
    (assignments || [])
      .length > 0 &&
    assignments.every(
      (a) =>
        a.guessed_player_id !==
        null
    );

  if (allGuessed) {
    await claimAndReveal();
  }
}

// ---------------------------------------------------------------------
// REVEAL + SCORING
// ---------------------------------------------------------------------
async function claimAndReveal() {
  if (!state.room) return;

  const {
    data: claimed,
  } = await supabase
    .from("rooms")
    .update({
      status: "scoring",
    })
    .eq(
      "id",
      state.room.id
    )
    .eq(
      "status",
      "guessing"
    )
    .select();

  if (
    !claimed ||
    claimed.length === 0
  ) {
    return;
  }

  await refreshPlayers();

  const {
    data: assignments,
  } = await supabase
    .from("assignments")
    .select(
      "assigned_to, guessed_player_id, papers(author_id)"
    )
    .eq(
      "room_id",
      state.room.id
    )
    .eq(
      "round",
      state.room.round
    );

  const gained = {};

  (
    assignments || []
  ).forEach((a) => {
    if (
      a.guessed_player_id ===
      a.papers.author_id
    ) {
      gained[
        a.assigned_to
      ] =
        (gained[
          a.assigned_to
        ] || 0) + 1;
    }
  });

  for (
    const [
      playerId,
      points,
    ] of Object.entries(
      gained
    )
  ) {
    const player =
      state.players.find(
        (p) =>
          p.id ===
          playerId
      );

    await supabase
      .from("players")
      .update({
        score:
          (player?.score ||
            0) + points,
      })
      .eq(
        "id",
        playerId
      );
  }

  await supabase
    .from("rooms")
    .update({
      status: "reveal",
    })
    .eq(
      "id",
      state.room.id
    );
}

// ---------------------------------------------------------------------
// REVEAL SCREEN
// ---------------------------------------------------------------------
async function renderReveal() {
  await refreshPlayers();

  await renderPlayerStrip();

  if ($("reveal-round")) {
    $("reveal-round").textContent =
      state.room.round;
  }

  renderTopicLine(
    "reveal-topic"
  );

  const {
    data: assignments,
  } = await supabase
    .from("assignments")
    .select(
      "paper_id, assigned_to, guessed_player_id, papers(content, author_id)"
    )
    .eq(
      "room_id",
      state.room.id
    )
    .eq(
      "round",
      state.room.round
    );

  const byId =
    Object.fromEntries(
      state.players.map(
        (p) => [p.id, p]
      )
    );

  const papers =
    new Map();

  const roundPoints =
    {};

  (
    assignments || []
  ).forEach((a) => {
    if (
      !papers.has(
        a.paper_id
      )
    ) {
      papers.set(
        a.paper_id,
        {
          paper:
            a.papers,
          guesses: [],
        }
      );
    }

    papers
      .get(a.paper_id)
      .guesses.push(a);

    if (
      a.guessed_player_id ===
      a.papers.author_id
    ) {
      roundPoints[
        a.assigned_to
      ] =
        (roundPoints[
          a.assigned_to
        ] || 0) + 1;
    }
  });

  const orderOf =
    (authorId) =>
      state.players.findIndex(
        (p) =>
          p.id ===
          authorId
      );

  const groups =
    [...papers.values()]
      .sort(
        (x, y) =>
          orderOf(
            x.paper.author_id
          ) -
          orderOf(
            y.paper.author_id
          )
      );

  if (
    state.revealRound !==
    state.room.round
  ) {
    state.revealRound =
      state.room.round;

    state.revealIndex = 0;
  }

  state.revealCards =
    groups.map(
      ({
        paper,
        guesses,
      }) => {
        const author =
          byId[
            paper.author_id
          ];

        const lines =
          guesses
            .map((a) => {
              const guesser =
                byId[
                  a.assigned_to
                ];

              const guessed =
                byId[
                  a.guessed_player_id
                ];

              const correct =
                a.guessed_player_id ===
                paper.author_id;

              return `
                <div class="guess-line">
                  ${avatarMarkup(
                    guesser?.avatar,
                    "avatar-svg inline-avatar"
                  )}

                  ${escapeHtml(
                    guesser?.name ||
                    "Unknown"
                  )}

                  guessed

                  <strong>
                    ${avatarMarkup(
                      guessed?.avatar,
                      "avatar-svg inline-avatar"
                    )}

                    ${escapeHtml(
                      guessed?.name ||
                      "—"
                    )}
                  </strong>

                  —

                  <span class="verdict ${
                    correct
                      ? "correct"
                      : "wrong"
                  }">
                    ${
                      correct
                        ? "correct!"
                        : "wrong"
                    }
                  </span>
                </div>
              `;
            })
            .join("");

        return `
          <div class="reveal-item">

            <div class="content">
              "${escapeHtml(
                paper.content
              )}"
            </div>

            <div>
              Written by

              <strong>
                ${avatarMarkup(
                  author?.avatar,
                  "avatar-svg inline-avatar"
                )}

                ${escapeHtml(
                  author?.name ||
                  "Unknown"
                )}
              </strong>
            </div>

            ${lines}

          </div>
        `;
      }
    );

  showRevealPaper();

  const board =
    $("scoreboard");

  if (!board) return;

  board.innerHTML =
    "<strong>Scoreboard</strong>";

  [...state.players]
    .sort(
      (a, b) =>
        (b.score || 0) -
        (a.score || 0)
    )
    .forEach((p) => {
      const gain =
        roundPoints[p.id] ||
        0;

      const row =
        document.createElement(
          "div"
        );

      row.className =
        "score-row";

      row.innerHTML = `
        <span>
          ${avatarMarkup(
            p.avatar,
            "avatar-svg inline-avatar"
          )}

          ${escapeHtml(
            p.name
          )}
        </span>

        <span>
          ${
            gain
              ? `<span class="round-gain">+${gain}</span> `
              : ""
          }

          ${p.score || 0}
        </span>
      `;

      board.appendChild(
        row
      );
    });

  const host =
    isHost();

  $("reveal-host-controls")
    ?.classList.toggle(
      "hidden",
      !host
    );

  if ($("reveal-hint")) {
    $("reveal-hint").textContent =
      host
        ? ""
        : "Waiting for the host to start the next round…";
  }
}

// ---------------------------------------------------------------------
// REVEAL NAVIGATION
// ---------------------------------------------------------------------
function showRevealPaper(
  animate = false
) {
  const total =
    state.revealCards.length;

  const list =
    $("reveal-list");

  const prev =
    $("reveal-prev");

  const next =
    $("reveal-next");

  if (
    !list ||
    !prev ||
    !next
  ) {
    return;
  }

  if (total === 0) {
    list.innerHTML =
      `<div class="reveal-item">Nobody wrote anything this round.</div>`;

    if ($("reveal-counter")) {
      $("reveal-counter").textContent =
        "";
    }

    prev.classList.add("hidden");
    next.classList.add("hidden");

    return;
  }

  state.revealIndex =
    Math.min(
      Math.max(
        state.revealIndex,
        0
      ),
      total - 1
    );

  list.innerHTML =
    state.revealCards[
      state.revealIndex
    ];

  if (animate) {
    list.classList.remove(
      "swap"
    );

    void list.offsetWidth;

    list.classList.add(
      "swap"
    );
  }

  if ($("reveal-counter")) {
    $("reveal-counter").textContent =
      `Paper ${
        state.revealIndex + 1
      } of ${total}`;
  }

  prev.classList.remove(
    "hidden"
  );

  next.classList.remove(
    "hidden"
  );

  prev.disabled =
    state.revealIndex === 0;

  next.disabled =
    state.revealIndex ===
    total - 1;
}

function moveReveal(
  direction
) {
  state.revealIndex +=
    direction;

  showRevealPaper(true);
}

// ---------------------------------------------------------------------
// NEXT ROUND
// ---------------------------------------------------------------------
async function nextRound() {
  if (startingNextRound) {
    return;
  }

  if (
    !state.room ||
    !isHost()
  ) {
    return;
  }

  startingNextRound = true;

  const button =
    $("btn-next-round");

  if (button) {
    button.disabled = true;

    if (!button.dataset.originalText) {
      button.dataset.originalText =
        button.textContent;
    }

    button.textContent =
      "Starting...";
  }

  try {
    state.currentWritingRound =
      null;

    const seconds =
      state.room.round_seconds;

    const endsAt =
      new Date(
        Date.now() +
          seconds * 1000
      ).toISOString();

    const update = {
      status: "writing",
      round:
        state.room.round + 1,
      writing_ends_at:
        endsAt,
    };

    if (
      state.room.extempore
    ) {
      const {
        topic,
        used,
      } =
        pickTopic(
          state.room
        );

      update.topic =
        topic;

      update.used_topics =
        used;
    }

    const { error } =
      await supabase
        .from("rooms")
        .update(update)
        .eq(
          "id",
          state.room.id
        )
        .eq(
          "status",
          "reveal"
        );

    if (error) {
      alert(
        "Could not start the next round: " +
          error.message
      );
    }
  } finally {
    startingNextRound =
      false;

    if (button) {
      button.disabled =
        false;

      if (
        button.dataset
          .originalText
      ) {
        button.textContent =
          button.dataset
            .originalText;
      }
    }
  }
}

// =====================================================================
// STARTUP LOADER
// =====================================================================

function setLoaderStatus(text) {
  const status =
    $("startup-status");

  if (status) {
    status.textContent =
      text;
  }
}

function setLoaderProgress(percent) {
  percent = Math.max(
    0,
    Math.min(
      100,
      percent
    )
  );

  const bar =
    $("startup-progress");

  const text =
    document.querySelector(
      ".startup-percent"
    );

  if (bar) {
    bar.style.width =
      `${percent}%`;

    bar.style.transform =
      "translateZ(0)";
  }

  if (text) {
    text.textContent =
      `${percent}%`;
  }

  if (bar) {
    void bar.offsetWidth;
  }
}

function preloadImage(src) {
  return new Promise(
    (resolve) => {
      const img =
        new Image();

      let finished = false;

      const done = (result) => {
        if (finished) return;

        finished = true;

        resolve(result);
      };

      img.onload = () =>
        done(true);

      img.onerror = () =>
        done(false);

      img.src = src;

      setTimeout(
        () => done(false),
        3000
      );
    }
  );
}

// ---------------------------------------------------------------------
// PRELOAD AVATARS
// ---------------------------------------------------------------------
async function preloadAvatars() {
  const avatarBase =
    "assets/avatars/";

  const total =
    AVATARS.length;

  for (
    let i = 0;
    i < total;
    i++
  ) {
    const avatar =
      AVATARS[i];

    setLoaderStatus(
      `Loading avatar ${
        i + 1
      } of ${total}...`
    );

    await preloadImage(
      `${avatarBase}${avatar}`
    );

    const progress =
      10 +
      Math.round(
        ((i + 1) /
          total) *
          30
      );

    setLoaderProgress(
      progress
    );

    await new Promise(
      (resolve) =>
        requestAnimationFrame(
          resolve
        )
    );
  }
}

// ---------------------------------------------------------------------
// DOM CHECK
// ---------------------------------------------------------------------
function checkRequiredElements() {
  const required = [
    "screen-name",
    "screen-mode",
    "screen-lobby",
    "screen-writing",
    "screen-guessing",
    "screen-reveal",
    "avatar-preview",
    "input-name",
    "input-code",
    "btn-create",
    "btn-join",
    "btn-start",
    "btn-submit-paper",
  ];

  const missing =
    required.filter(
      (id) => !$(id)
    );

  if (missing.length) {
    console.warn(
      "[Blank Page] Missing DOM elements:",
      missing
    );
  }

  return missing;
}

// ---------------------------------------------------------------------
// EVENT INITIALIZATION
// ---------------------------------------------------------------------
function initializeButtonFunctions() {
  if (initialized) return;

  initialized = true;

  renderAvatarPicker();

  // AVATAR
  bindClick(
    "avatar-prev",
    () => changeAvatar(-1)
  );

  bindClick(
    "avatar-next",
    () => changeAvatar(1)
  );

  // NAME / MODE
  bindClick(
    "btn-continue",
    continueFromName
  );

  bindClick(
    "btn-back-name",
    backToName
  );

  // ROOM
  bindClick(
    "btn-create",
    createRoom
  );

  bindClick(
    "btn-join",
    joinRoom
  );

  bindClick(
    "btn-start",
    startGame
  );

  bindClick(
    "btn-submit-paper",
    submitPaper
  );

  bindClick(
    "btn-next-round",
    nextRound
  );

  bindClick(
    "btn-leave",
    leaveRoom
  );

  // EXTEMPORE
  bindChange(
    "toggle-extempore",
    toggleExtempore
  );

  bindClick(
    "btn-add-topic",
    addCustomTopic
  );

  const topicInput =
    $("input-topic");

  if (topicInput) {
    topicInput.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key ===
          "Enter"
        ) {
          event.preventDefault();

          addCustomTopic();
        }
      }
    );
  }

  // REVEAL
  bindClick(
    "reveal-prev",
    () => moveReveal(-1)
  );

  bindClick(
    "reveal-next",
    () => moveReveal(1)
  );

  // LEFT / RIGHT ARROWS
  document.addEventListener(
    "keydown",
    (event) => {
      const revealScreen =
        $("screen-reveal");

      if (
        !revealScreen ||
        !revealScreen.classList.contains(
          "active"
        )
      ) {
        return;
      }

      if (
        event.key ===
        "ArrowLeft"
      ) {
        const button =
          $("reveal-prev");

        if (
          button &&
          !button.disabled
        ) {
          moveReveal(-1);
        }
      }

      if (
        event.key ===
        "ArrowRight"
      ) {
        const button =
          $("reveal-next");

        if (
          button &&
          !button.disabled
        ) {
          moveReveal(1);
        }
      }
    }
  );

  // ENTER → CONTINUE
  const nameInput =
    $("input-name");

  if (nameInput) {
    nameInput.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key ===
          "Enter"
        ) {
          event.preventDefault();

          continueFromName();
        }
      }
    );
  }

  // ENTER → JOIN
  const codeInput =
    $("input-code");

  if (codeInput) {
    codeInput.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key ===
          "Enter"
        ) {
          event.preventDefault();

          joinRoom();
        }
      }
    );
  }
}

// =====================================================================
// STARTUP
// =====================================================================
async function startup() {
  try {
    setLoaderStatus(
      "Preparing Blank Page..."
    );

    setLoaderProgress(5);

    clearSession();

    setLoaderStatus(
      "Preparing a fresh session..."
    );

    setLoaderProgress(10);

    await new Promise(
      (resolve) =>
        requestAnimationFrame(
          resolve
        )
    );

    await preloadAvatars();

    setLoaderStatus(
      "Preparing game interface..."
    );

    setLoaderProgress(45);

    await new Promise(
      (resolve) =>
        requestAnimationFrame(
          resolve
        )
    );

    checkRequiredElements();

    setLoaderProgress(55);

    setLoaderStatus(
      "Loading buttons and controls..."
    );

    initializeButtonFunctions();

    setLoaderProgress(65);

    setLoaderStatus(
      "Preparing player controls..."
    );

    setLoaderProgress(75);

    setLoaderStatus(
      "Setting up the game..."
    );

    $("room-bar")?.classList.add(
      "hidden"
    );

    $("player-strip")?.classList.add(
      "hidden"
    );

    if ($("player-strip")) {
      $("player-strip").innerHTML =
        "";
    }

    showScreen("name");

    setLoaderProgress(85);

    setLoaderStatus(
      "Almost ready..."
    );

    await new Promise(
      (resolve) =>
        requestAnimationFrame(
          () =>
            requestAnimationFrame(
              resolve
            )
        )
    );

    setLoaderProgress(95);

    setLoaderStatus(
      "Ready!"
    );

    setLoaderProgress(100);

    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          300
        )
    );

    const loader =
      $("startup-loader");

    if (loader) {
      loader.classList.add(
        "loaded"
      );

      setTimeout(() => {
        loader.remove();
      }, 500);
    }
  } catch (error) {
    console.error(
      "[Blank Page] Startup error:",
      error
    );

    try {
      initializeButtonFunctions();

      $("room-bar")?.classList.add(
        "hidden"
      );

      showScreen("name");

      setLoaderStatus(
        "Ready!"
      );

      setLoaderProgress(
        100
      );
    } catch (fallbackError) {
      console.error(
        "[Blank Page] Loader fallback error:",
        fallbackError
      );
    }

    const loader =
      $("startup-loader");

    if (loader) {
      loader.classList.add(
        "loaded"
      );

      setTimeout(() => {
        loader.remove();
      }, 500);
    }
  }
}

// =====================================================================
// GO
// =====================================================================
startup();
