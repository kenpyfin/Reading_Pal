/** Phone layout: portrait phones, and short landscape phones wider than 768px.
 *
 * iPhone landscape heights are about 320–430px. A 500px ceiling keeps
 * tablet landscape (about 768px tall) on the desktop layout.
 *
 * CSS @media blocks repeat this query. Update both together.
 */
export const MOBILE_LAYOUT_QUERY =
  '(max-width: 768px), (max-height: 500px) and (orientation: landscape)';

/** Type size and line spacing stay on the desktop reader bar at this width and up.
 * Below it they move into Menu. CSS in BookView.css repeats this cutoff.
 */
export const DESKTOP_FONT_ON_BAR_QUERY = '(min-width: 1200px)';

export function matchesMobileLayout() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
}

export function matchesWideDesktop() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(DESKTOP_FONT_ON_BAR_QUERY).matches;
}

export function subscribeWideDesktop(onChange) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const media = window.matchMedia(DESKTOP_FONT_ON_BAR_QUERY);
  const handleChange = () => onChange(media.matches);
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }
  media.addListener(handleChange);
  return () => media.removeListener(handleChange);
}

export function subscribeMobileLayout(onChange) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
  const handleChange = () => onChange(media.matches);
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }
  media.addListener(handleChange);
  return () => media.removeListener(handleChange);
}
