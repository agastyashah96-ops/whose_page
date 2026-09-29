const AVATAR_BASE = "assets/avatars/";

export const AVATARS = [
  "alien.svg",
  "bear.svg",
  "cat.svg",
  "cyclops.svg",
  "fox.svg",
  "ghost.svg",
  "panda.svg",
  "robot.svg",
];

export function avatarMarkup(avatar, className = "avatar-svg") {
  if (typeof avatar === "string" && avatar.toLowerCase().endsWith(".svg")) {
    const safeName = avatar.split("/").pop();
    if (AVATARS.includes(safeName)) {
      return `<img class="${className}" src="${AVATAR_BASE}${safeName}" alt="" draggable="false">`;
    }
  }

  // Backward-compatible fallback for rooms created before SVG avatars.
  return `<span class="${className} avatar-fallback">${avatar || "?"}</span>`;
}
