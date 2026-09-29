const AVATAR_BASE = "assets/avatars/";

export const AVATARS = [
  "comic.svg",
  "knight.svg",
  "mermaid.svg",
  "john.svg",
  "dragon.svg",
  "detective.svg",
  "pirate.svg"
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
