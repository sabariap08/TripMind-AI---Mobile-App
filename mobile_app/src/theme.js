/**
 * Design tokens.
 *
 * Built for a phone held in one hand on a moving train, which drives most of
 * these numbers:
 *
 *   touch.min  48    above the 44px WCAG 2.5.5 floor, because a thumb is
 *                    worse than a stylus and a platform in a hurry is worse
 *                    still.
 *   fs.input   16    iOS and Android both zoom a focused input when the font
 *                    is under 16px, which breaks the layout mid-typing.
 *   space.*    4pt grid, so nothing lands on a half pixel.
 *
 * Colour is a single deep green ramp plus a semantic set. Only four hues carry
 * meaning (action, success, warning, danger); everything else is neutral, so a
 * red number on a screen always means the same thing.
 */

export const colors = {
  brand900: '#06251B',
  brand800: '#0B3D2E',
  brand700: '#12553F',
  brand600: '#1A6E52',
  brand500: '#228A67',
  brand300: '#6FC3A4',
  brand100: '#D6EFE4',
  brand50: '#EFF9F4',

  ink: '#0E1512',
  ink70: '#4A5550',
  ink50: '#6E7A75',
  ink30: '#A7B0AC',
  ink15: '#D6DCDA',
  ink08: '#EAEEEC',
  ink04: '#F5F7F6',
  white: '#FFFFFF',

  success: '#1A7F4B',
  successBg: '#E4F5EB',
  warning: '#B26A00',
  warningBg: '#FDF1DF',
  danger: '#C0392B',
  dangerBg: '#FBE9E7',
  info: '#1B5E9E',
  infoBg: '#E6F0F9',

  overlay: 'rgba(6, 37, 27, 0.45)',
};

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
};

export const type = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700', color: colors.ink },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', color: colors.ink },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '700', color: colors.ink },
  subheading: { fontSize: 16, lineHeight: 22, fontWeight: '600', color: colors.ink },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400', color: colors.ink },
  bodyStrong: { fontSize: 15, lineHeight: 22, fontWeight: '600', color: colors.ink },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '500', color: colors.ink70 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500', color: colors.ink50 },
  mono: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.ink70 },
  input: { fontSize: 16, lineHeight: 22, fontWeight: '400', color: colors.ink },
};

export const touch = {
  min: 48,
  comfortable: 52,
};

export const shadow = {
  card: {
    shadowColor: '#06251B',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  raised: {
    shadowColor: '#06251B',
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
};

export const statusTone = {
  neutral: { fg: colors.ink70, bg: colors.ink08 },
  brand: { fg: colors.brand700, bg: colors.brand50 },
  success: { fg: colors.success, bg: colors.successBg },
  warning: { fg: colors.warning, bg: colors.warningBg },
  danger: { fg: colors.danger, bg: colors.dangerBg },
  info: { fg: colors.info, bg: colors.infoBg },
};

export default { colors, space, radius, type, touch, shadow, statusTone };
