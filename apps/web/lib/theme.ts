export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const THEME_STORAGE_KEY = "rivet-theme";
/** The setter the pre-paint script installs, so the toggle has one path to call. */
export const THEME_SETTER = "__rivetSetTheme";

export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/**
 * The inline pre-paint script, as a string.
 *
 * It stays inline and it stays the only place the decision is made. Rivet had
 * no theme switcher, and the four-line script that followed the OS bought two
 * things worth keeping: every page is a server component, and there is no
 * flash of the light palette before a provider mounts. A `next-themes`-style
 * context would cost both. So the script grows a stored preference and a
 * setter, the toggle calls the setter, and nothing else ever touches the
 * `dark` class.
 *
 * Every `localStorage` access is wrapped, because a private window or blocked
 * site data makes the accessor throw, and a theme preference is not worth a
 * blank page. Falling through to the OS is the right answer there anyway.
 *
 * `data-theme` on the root is what the toggle reads back after hydration, so
 * the stored preference never has to be serialized into the server's HTML.
 */
export const THEME_SCRIPT = `(function(){
var K=${JSON.stringify(THEME_STORAGE_KEY)};
var m=window.matchMedia("(prefers-color-scheme: dark)");
function read(){try{var v=localStorage.getItem(K);return v==="light"||v==="dark"?v:"system"}catch(e){return "system"}}
function apply(){var p=read();var r=document.documentElement;r.classList.toggle("dark",p==="dark"||(p==="system"&&m.matches));r.setAttribute("data-theme",p)}
window.${THEME_SETTER}=function(p){try{p==="system"?localStorage.removeItem(K):localStorage.setItem(K,p)}catch(e){}apply()};
apply();
m.addEventListener("change",apply);
})();`;
