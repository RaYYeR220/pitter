/** Where the daylight choice is remembered, on this device only. */
export const THEME_STORAGE_KEY = 'pitter-theme'

/** The browser's chrome follows the screen: dark, daylight, or the flood while heavy rain is paying. */
export const THEME_COLOR = { dark: '#0a0a0b', daylight: '#edebe6', raining: '#ff5a1f' } as const

/**
 * Runs before the page paints, so a chosen daylight screen never flashes dark first. A constant, kept tiny and
 * inline; it only reads the one value this page writes itself.
 */
export const THEME_BOOT = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='daylight'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`
