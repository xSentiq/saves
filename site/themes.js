// Peak Vault colour themes. Loaded in <head> so the saved theme applies before anything is drawn.
// Each theme is just a background + an accent; every other colour is derived from those two.
// The choice is stored in the "vault_theme" cookie (per browser, 1 year).
(() => {
  const THEMES = [
    { id: "default", name: "Default" }, // the original look, uses the values in :root
    { id: "v1",  name: "Variant 1",  bg: "#0A0A0A", accent: "#B6FF00" },
    { id: "v2",  name: "Variant 2",  bg: "#101A46", accent: "#245BFF" },
    { id: "v3",  name: "Variant 3",  bg: "#080808", accent: "#C1121F" },
    { id: "v4",  name: "Variant 4",  bg: "#24150F", accent: "#D96B27" },
    { id: "v5",  name: "Variant 5",  bg: "#292929", accent: "#C88E9B" },
    { id: "v6",  name: "Variant 6",  bg: "#F1E9D8", accent: "#701C32" },
    { id: "v7",  name: "Variant 7",  bg: "#080808", accent: "#BFC3C7" },
    { id: "v8",  name: "Variant 8",  bg: "#123B2A", accent: "#E5FF00" },
    { id: "v9",  name: "Variant 9",  bg: "#32104F", accent: "#FF3CAC" },
    { id: "v10", name: "Variant 10", bg: "#19152F", accent: "#A5E7FF" },
  ];

  const hex = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const toHex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t)); // t = share of b
  const lum = (h) => {
    const [r, g, b] = hex(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  function derive(t) {
    const light = lum(t.bg) > 0.4;
    const ink = light ? mix(t.bg, "#000000", 0.86) : mix(t.bg, "#ffffff", 0.92);
    // accent as text must stay readable on the background: nudge it towards the text colour if needed
    let accentText = t.accent;
    for (let k = 1; k <= 10 && contrast(accentText, t.bg) < 4; k++) accentText = mix(t.accent, ink, k * 0.1);
    return {
      "--bg": t.bg,
      "--panel": mix(t.bg, ink, light ? 0.05 : 0.06),
      "--panel-2": mix(t.bg, ink, light ? 0.1 : 0.11),
      "--line": mix(t.bg, ink, light ? 0.2 : 0.2),
      "--ink": ink,
      "--muted": mix(t.bg, ink, 0.6),
      "--gold": t.accent,
      "--gold-text": accentText,
      "--on-accent": lum(t.accent) > 0.35 ? mix(t.bg, "#000000", 0.6) : "#ffffff",
      "--input": light ? mix(t.bg, "#ffffff", 0.55) : mix(t.bg, "#000000", 0.35),
      "--media": light ? mix(t.bg, "#000000", 0.08) : mix(t.bg, "#000000", 0.4),
      "--header": t.bg + "e0",
      "--soft": light ? "#00000008" : "#ffffff08",
      "--glow-1": t.accent + "18",
      "--glow-2": t.accent + "0a",
      "--cat": light ? "#b4531a" : "#ff9f5a",
      "--dog": light ? "#1f6aa8" : "#7cc4ff",
      "--danger": light ? "#c0262d" : "#ff6b6b",
      "color-scheme": light ? "light" : "dark",
    };
  }

  const root = document.documentElement;
  const KEYS = Object.keys(derive(THEMES[1]));

  function apply(id) {
    const t = THEMES.find((x) => x.id === id) || THEMES[0];
    for (const k of KEYS) root.style.removeProperty(k);
    if (t.bg) for (const [k, v] of Object.entries(derive(t))) root.style.setProperty(k, v);
    root.dataset.theme = t.id;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t.bg || "#14110f";
    return t.id;
  }

  function saved() {
    try { return (document.cookie.match(/(?:^|;\s*)vault_theme=([\w-]+)/) || [])[1] || "default"; } catch { return "default"; }
  }

  function save(id) {
    try {
      document.cookie = `vault_theme=${encodeURIComponent(id)}; Max-Age=31536000; Path=/; SameSite=Lax` +
        (location.protocol === "https:" ? "; Secure" : "");
    } catch { /* cookies blocked: theme just won't be remembered */ }
  }

  window.VAULT_THEMES = { list: THEMES, apply, save, saved, current: apply(saved()) };
})();
