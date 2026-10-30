/**
 * The red waves from the picture pins when "Highlight photos" is pressed: the
 * same timing on the globe (a shader, scene.js) and the map (canvas, map2d.js).
 * Each wave grows from the pin and fades as it goes; the last one ends with
 * the highlight.
 */
export const RIPPLE_COLOR = '#FF3B30';
/** How far a wave travels from its pin, CSS px at the page's normal type size. */
export const RIPPLE_RADIUS_PX = 34;
export const RIPPLE_S = 2;
export const RIPPLE_WAVES = 3;
/** One wave's life, and the gap between one wave starting and the next. */
export const RIPPLE_WAVE_S = 1.1;
export const RIPPLE_GAP_S = 0.45;
