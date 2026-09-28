// SVG avatars live in assets/avatars/ in the repository.
// We discover the SVG filenames from GitHub so you don't have to maintain
// a second list when you add/remove avatars.
const AVATAR_API =
  "https://api.github.com/repos/ondiot/whose_page_premium/contents/assets/avatars";

export const AVATARS = await fetch(AVATAR_API)
  .then(async (res) => {
    if (!res.ok) throw new Error("Could not load avatar list");
    const files = await res.json();
    return files
      .filter((file) => file.type === "file" && file.name.toLowerCase().endsWith(".svg"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((file) => file.download_url);
  })
  .catch(() => []);

// A local path can still be supplied manually if the repo is being tested
// without GitHub access. Add your SVG filenames here if needed.
// Example: "assets/avatars/my-avatar.svg"
export const LOCAL_AVATAR_FALLBACKS = [];
