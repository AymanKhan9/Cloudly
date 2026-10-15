export const THEME_KEY = "cloudly-theme";

/** Runs in <head> before paint, so a saved theme never flashes the other one. */
export const themeScript = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
