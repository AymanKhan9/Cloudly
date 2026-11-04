export const THEME_KEY = "cloudly-theme";
/** "closed" when the sidebar is collapsed. */
export const RAIL_KEY = "cloudly-rail";

/** Runs in <head> before paint, so a saved theme (or a closed sidebar) never flashes the other way. */
export const themeScript = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;if(localStorage.getItem("${RAIL_KEY}")==="closed")document.documentElement.dataset.rail="closed"}catch(e){}`;
