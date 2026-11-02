// floor-menu.test.mjs — the Floors button (owner, 28/10/2026): one clear way to reach every department.
//   1 floorMenu: every floor top first, each with its own departments; an empty floor says so; a snapshot without a building is one list
//   2 the page: the button on the stage, F opens it, Shift+F keeps the fps readout, the hints say so
// No engine, no model call, $0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { floorMenu } from '../src/web/ui/floors.js';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('1: floorMenu lists every floor top first with its departments', () => {
  const snap = {
    building: { floors: [{ floor: 0, id: 'shared', name: 'Shared services', shared: true, lounge: true }, { floor: 1, id: 'shop', name: 'Shop' }, { floor: 2, id: 'new', name: 'New business', empty: true }] },
    departments: [{ key: 'research', name: 'RESEARCH', floor: 1 }, { key: 'finance', name: 'FINANCE', floor: 0 }, { key: 'design', name: 'DESIGN', floor: 1 }, { key: 'compliance', name: 'COMPLIANCE', floor: 0 }]
  };
  assert.deepEqual(floorMenu(snap), [
    { floor: 2, name: 'New business', shared: false, empty: true, departments: [] },
    { floor: 1, name: 'Shop', shared: false, empty: false, departments: [{ key: 'research', name: 'RESEARCH' }, { key: 'design', name: 'DESIGN' }] },
    { floor: 0, name: 'Shared services', shared: true, empty: false, departments: [{ key: 'finance', name: 'FINANCE' }, { key: 'compliance', name: 'COMPLIANCE' }] }
  ]);
  // the legacy and fixtures views have no building: one list of every department
  assert.deepEqual(floorMenu({ departments: [{ key: 'a', name: 'A' }] }), [{ floor: null, name: 'This office', shared: false, empty: false, departments: [{ key: 'a', name: 'A' }] }]);
  assert.deepEqual(floorMenu(null), [{ floor: null, name: 'This office', shared: false, empty: false, departments: [] }]);
});

test('2: the page has the Floors button; F opens it, Shift+F is the fps readout', () => {
  const html = read('src/web/index.html'), main = read('src/web/main.js');
  assert.match(html, /<button id="floor-btn"[^>]*>.*Floors <b>F<\/b><\/button>/);
  assert.match(html, /<div id="floor-menu" class="floor-menu hidden"/);
  assert.match(html, /<span><b>F<\/b> floors<\/span><span><b>⇧F<\/b> fps<\/span>/);
  assert.match(main, /else if \(\(k === 'f' \|\| k === 'F'\) && e\.shiftKey\) togglePerf\(\);\n  else if \(k === 'f' \|\| k === 'F'\) \{ if \(floorMenu\.isOpen\(\)\) floorMenu\.hide\(\); else/);
  assert.match(main, /createFloorMenu\(\{ button: \$\('#floor-btn'\), root: \$\('#floor-menu'\), onFloor: \(n\) => setFloor\(n\), onDept: \(key\) => focusDept\(key\), onEng: \(\) => openEng\(\) \}\)/);
});
