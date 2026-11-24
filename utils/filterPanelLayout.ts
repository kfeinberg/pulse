// The filter panel shares the map's right rail with the report button.
export const FILTER_TOGGLE_SIZE = 50;
export const FILTER_PANEL_GAP = 8;
export const FILTER_PANEL_BOTTOM_PADDING = 18;

export function filterPanelLayout(
  width: number,
  height: number,
  insets: { top: number; bottom: number; left: number; right: number },
) {
  const top = Math.max(60, insets.top + 8);
  const right = Math.max(16, insets.right + 8);
  const left = Math.max(16, insets.left + 8);
  // The existing bottom-right button is 50pt tall and 40pt off the edge.
  const bottom = Math.max(102, insets.bottom + 12);
  return {
    top,
    right,
    width: Math.max(0, Math.min(242, width - left - right)),
    maxHeight: Math.max(0, height - top - FILTER_TOGGLE_SIZE - FILTER_PANEL_GAP - bottom),
  };
}
