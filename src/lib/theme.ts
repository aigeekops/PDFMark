import type { MarkColor, MarkKind } from '../types';

export const COLOR_HEX: Record<MarkColor, string> = {
  yellow: '#F5D565',
  green: '#8FD6A0',
  blue: '#92C7F0',
  pink: '#F3A8BE',
  purple: '#C4AEE8',
};

/** Faint fill used behind the glyphs; the bar itself carries the saturated colour. */
export const COLOR_FILL_ALPHA = 0.34;

export const KIND_STROKE: Record<MarkKind, number> = {
  highlight: 0,
  underline: 2,
  strike: 2,
  box: 1.5,
};
