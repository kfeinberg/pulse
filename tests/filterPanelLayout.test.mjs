import assert from 'node:assert/strict';
import test from 'node:test';
import { filterPanelLayout, FILTER_PANEL_GAP, FILTER_TOGGLE_SIZE } from '../utils/filterPanelLayout.ts';

const fitsVertically = (height, panel) => height - panel.top - FILTER_TOGGLE_SIZE - FILTER_PANEL_GAP - panel.maxHeight;

test('filter panel stays between the notch and bottom-right map controls', () => {
  const height = 852;
  const panel = filterPanelLayout(393, height, { top: 59, bottom: 34, left: 0, right: 0 });
  assert.deepEqual(panel, { top: 67, right: 16, width: 242, maxHeight: 625 });
  assert.equal(fitsVertically(height, panel), 102);
});

test('short layouts scroll without enforcing a minimum height that overlaps map controls', () => {
  const height = 320;
  const panel = filterPanelLayout(640, height, { top: 0, bottom: 21, left: 44, right: 44 });
  assert.equal(panel.maxHeight, 100);
  assert.equal(panel.right, 52);
  assert.equal(fitsVertically(height, panel), 102);
});

test('narrow layouts respect both side insets and never return negative sizes', () => {
  const insets = { top: 0, bottom: 0, left: 24, right: 32 };
  assert.equal(filterPanelLayout(220, 640, insets).width, 148);
  const tiny = filterPanelLayout(40, 140, insets);
  assert.equal(tiny.width, 0);
  assert.equal(tiny.maxHeight, 0);
});
