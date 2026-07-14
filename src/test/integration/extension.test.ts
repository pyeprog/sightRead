import * as assert from 'assert';
import * as vscode from 'vscode';
import type { Compositor, SpotlightRender } from '../../vs/compositor';
import type { EntriesViewFeature } from '../../vs/entriesView';
import type { MarkerRepository } from '../../vs/highlighter';
import type { MarkersViewFeature } from '../../vs/markersView';
import type { SegmentsViewFeature } from '../../vs/segmentsView';

interface TestApi {
  _test: {
    repo: MarkerRepository;
    compositor: Compositor;
    markersView: MarkersViewFeature;
    entriesView: EntriesViewFeature;
    segmentsView: SegmentsViewFeature;
  };
}

const EXTENSION_ID = 'WaylongLeon.sightread';

async function getApi(): Promise<TestApi> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} not found`);
  return (await ext.activate()) as TestApi;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('SightRead integration', () => {
  test('activates and registers all commands', async () => {
    await getApi();
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'sightread.foldSkeleton',
      'sightread.unfoldSkeleton',
      'sightread.mark',
      'sightread.markFavorite',
      'sightread.markPickColor',
      'sightread.markSegment',
      'sightread.markSegmentWithNote',
      'sightread.removeSegmentMarkers',
      'sightread.editMarkerNote',
      'sightread.editMarkerNoteItem',
      'sightread.removeMarkersInSelection',
      'sightread.removeMarkersInFunction',
      'sightread.removeMarkersInFile',
      'sightread.removeAllMarkers',
      'sightread.spotlightCycle',
      'sightread.spotlightOff',
      'sightread.toggleVariableTint',
      'sightread.goToSegment',
      'sightread.goToEntry',
      'sightread.refreshEntries',
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test('markers: add, shift on edit above, auto-delete on edit inside', async () => {
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: 'line0\nline1\nline2\nline3\nline4\n',
      language: 'plaintext',
    });
    const editor = await vscode.window.showTextDocument(doc);

    editor.selection = new vscode.Selection(1, 0, 2, 5);
    await vscode.commands.executeCommand('sightread.markFavorite');
    let markers = api._test.repo.get(doc.uri);
    assert.strictEqual(markers.length, 1);
    assert.deepStrictEqual([markers[0].startLine, markers[0].endLine], [1, 2]);

    // edit above → marker shifts down
    await editor.edit((eb) => eb.insert(new vscode.Position(0, 0), 'inserted\n'));
    await sleep(100);
    markers = api._test.repo.get(doc.uri);
    assert.strictEqual(markers.length, 1);
    assert.deepStrictEqual([markers[0].startLine, markers[0].endLine], [2, 3]);

    // edit inside → marker auto-deletes
    await editor.edit((eb) => eb.insert(new vscode.Position(2, 1), 'zz'));
    await sleep(100);
    assert.strictEqual(api._test.repo.get(doc.uri).length, 0);
  });

  test('markers view lists marked locations with preview snapshots', async () => {
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: 'const answer = 42;\nsecond line\nthird line\n',
      language: 'plaintext',
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 5);
    await vscode.commands.executeCommand('sightread.markFavorite');

    const marker = api._test.repo.get(doc.uri)[0];
    assert.ok(marker, 'marker should exist');
    assert.strictEqual(marker.preview, 'const answer = 42;');

    const roots = api._test.markersView.getChildren();
    const fileNode = roots.find(
      (n) => n.kind === 'file' && n.uri.toString() === doc.uri.toString(),
    );
    assert.ok(fileNode, 'markers view should list the marked file');
    const children = api._test.markersView.getChildren(fileNode);
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].kind, 'marker');

    const item = api._test.markersView.getTreeItem(children[0]);
    assert.strictEqual(item.label, 'const answer = 42;');
    assert.strictEqual(item.command?.command, 'sightread.revealLocation');

    await vscode.commands.executeCommand('sightread.removeMarker', children[0]);
    assert.strictEqual(api._test.repo.get(doc.uri).length, 0);
  });

  test('removeMarkersInFile clears markers', async () => {
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: 'a\nb\nc\n',
      language: 'plaintext',
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 1, 1);
    await vscode.commands.executeCommand('sightread.markFavorite');
    assert.strictEqual(api._test.repo.get(doc.uri).length, 1);
    await vscode.commands.executeCommand('sightread.removeMarkersInFile');
    assert.strictEqual(api._test.repo.get(doc.uri).length, 0);
  });

  test('fold/unfold skeleton inside a class method never folds the class', async function () {
    this.timeout(30000);
    await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: [
        'class A {', //            0
        '  method() {', //         1
        '    const a = 1;', //     2
        '    if (a) {', //         3
        '      use(a);', //        4
        '      more(a);', //       5
        '    }', //                6
        '    return a;', //        7
        '  }', //                  8
        '}', //                    9
        '',
      ].join('\n'),
      language: 'javascript',
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(2, 4, 2, 4); // inside method()

    const lineVisible = (line: number): boolean =>
      editor.visibleRanges.some((r) => r.start.line <= line && line <= r.end.line);
    const waitFor = async (cond: () => boolean): Promise<boolean> => {
      for (let i = 0; i < 100; i++) {
        if (cond()) {
          return true;
        }
        await sleep(100);
      }
      return cond();
    };

    // fold: retry until the language service is warm and the if-body folds
    const folded = await waitFor(() => {
      void vscode.commands.executeCommand('sightread.foldSkeleton');
      return !lineVisible(4);
    });
    assert.ok(folded, 'if-body should fold');
    assert.ok(lineVisible(0), 'class line must stay visible');
    assert.ok(lineVisible(1), 'method line must stay visible');
    assert.ok(lineVisible(3), 'if header must stay visible');

    // unfold restores the body
    await vscode.commands.executeCommand('sightread.unfoldSkeleton');
    assert.ok(await waitFor(() => lineVisible(4)), 'unfold should reveal the if-body');

    // simulate a collapsed ancestor (the old bug's aftermath): fold the class
    // by hand, then unfoldSkeleton must reveal method and body again
    await vscode.commands.executeCommand('editor.fold', { levels: 1, selectionLines: [0] });
    assert.ok(await waitFor(() => !lineVisible(1)), 'class should be folded by hand');
    await vscode.commands.executeCommand('sightread.unfoldSkeleton');
    assert.ok(
      await waitFor(() => lineVisible(1) && lineVisible(4)),
      'unfoldSkeleton should reveal the folded ancestor chain',
    );
  });

  test('fold/unfold skeleton on a nested function folds only the nested one', async function () {
    this.timeout(30000);
    await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: [
        'function outer() {', //      0
        '  const a = 1;', //          1
        '',
        '  function inner(x) {', //   3
        '    if (x) {', //            4
        '      use(x);', //           5
        '      more(x);', //          6
        '    }', //                   7
        '    return x;', //           8
        '  }', //                     9
        '',
        '  return inner(a);', //      11
        '}', //                       12
        '',
      ].join('\n'),
      language: 'javascript',
    });
    const editor = await vscode.window.showTextDocument(doc);
    // cursor ON the nested function's header line — "current function" is inner,
    // not outer (the spotlight-only header yield must not leak into commands)
    const headerCol = doc.lineAt(3).text.indexOf('inner') + 1;
    editor.selection = new vscode.Selection(3, headerCol, 3, headerCol);

    const lineVisible = (line: number): boolean =>
      editor.visibleRanges.some((r) => r.start.line <= line && line <= r.end.line);
    const waitFor = async (cond: () => boolean): Promise<boolean> => {
      for (let i = 0; i < 100; i++) {
        if (cond()) {
          return true;
        }
        await sleep(100);
      }
      return cond();
    };

    // fold: retry until the language service is warm and the if-body folds
    const folded = await waitFor(() => {
      void vscode.commands.executeCommand('sightread.foldSkeleton');
      return !lineVisible(5);
    });
    assert.ok(folded, "inner's if-body should fold");
    assert.ok(lineVisible(3), 'inner header must stay visible');
    assert.ok(lineVisible(4), "inner's if header must stay visible — inner itself must not collapse");
    assert.ok(lineVisible(8), "inner's return must stay visible");
    assert.ok(lineVisible(1) && lineVisible(11), "outer's own statements must stay visible");

    // unfold from the header line restores inner's body
    await vscode.commands.executeCommand('sightread.unfoldSkeleton');
    assert.ok(await waitFor(() => lineVisible(5)), 'unfold should reveal the if-body');

    // cursor inside the nested body behaves the same
    editor.selection = new vscode.Selection(8, 4, 8, 4);
    const foldedFromBody = await waitFor(() => {
      void vscode.commands.executeCommand('sightread.foldSkeleton');
      return !lineVisible(5);
    });
    assert.ok(foldedFromBody, 'if-body should fold from inside the nested body');
    assert.ok(lineVisible(4) && lineVisible(11), 'only the if-body folds');
    await vscode.commands.executeCommand('sightread.unfoldSkeleton');
    assert.ok(await waitFor(() => lineVisible(5)), 'unfold should reveal the if-body again');
  });

  test('foldSkeleton outside a function does not crash', async () => {
    await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: 'just\nplain\ntext\n',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('sightread.foldSkeleton');
    assert.ok(true);
  });

  test('spotlight actually computes dim state on a JS document', async function () {
    this.timeout(30000);
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: [
        'function alpha() {',
        '  const x = 1;',
        '  const y = 2;',
        '',
        '  if (x) {',
        '    use(x);',
        '    use(y);',
        '  }',
        '',
        '  return y;',
        '}',
        '',
        'function beta() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
      language: 'javascript',
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(1, 8, 1, 8); // inside alpha()

    await vscode.commands.executeCommand('sightread.spotlightOff');
    // cycle order is Off → Seg+Var → Seg → Fn
    await vscode.commands.executeCommand('sightread.spotlightCycle'); // level 3: Seg+Var
    await vscode.commands.executeCommand('sightread.spotlightCycle'); // level 2: Seg

    // the JS language service may need a while to warm up — poll
    let spot2;
    for (let i = 0; i < 100; i++) {
      await sleep(200);
      // nudge the pipeline in case the first runs raced the language service
      editor.selection = new vscode.Selection(1, 8, 1, 8);
      await vscode.commands.executeCommand('cursorMove', { to: 'right' });
      spot2 = api._test.compositor.getTransient(doc.uri)?.spotlight;
      if (spot2) {
        break;
      }
    }
    assert.ok(spot2, 'spotlight state was never computed (enclosing function not found?)');
    assert.strictEqual(spot2.fn.start, 0, 'function range should start at line 0');
    assert.strictEqual(spot2.fn.end, 10, 'function range should end at the closing brace');
    assert.ok(spot2.lit.length >= 1, 'level 2 should light at least the cursor segment');
    const litText = JSON.stringify(spot2.lit);
    assert.ok(
      spot2.lit.some((r) => r.start <= 1 && 1 <= r.end),
      `cursor line 1 should be lit at level 2, got ${litText}`,
    );

    await vscode.commands.executeCommand('sightread.spotlightCycle'); // level 1: Fn
    await sleep(500);
    const spot1 = api._test.compositor.getTransient(doc.uri)?.spotlight;
    assert.ok(spot1, 'level-1 spotlight state missing');
    assert.deepStrictEqual(spot1.lit, [{ start: 0, end: 10 }], 'level 1 lights the whole function');
    await vscode.commands.executeCommand('sightread.spotlightOff');
  });

  // A local function defined inside another function: the definition header and
  // the call sites must spotlight each other (both directions).
  suite('spotlight over a nested local function', () => {
    const NESTED_FN_SOURCE = [
      'function outer() {', //      0
      '  const a = 1;', //          1
      '',
      '  function inner(x) {', //   3
      '    return x + 1;', //       4
      '  }', //                     5
      '',
      '  const b = inner(a);', //   7
      '  return b;', //             8
      '}', //                       9
      '',
    ].join('\n');

    const covers = (ranges: { start: number; end: number }[], line: number): boolean =>
      ranges.some((r) => r.start <= line && line <= r.end);

    /** Puts the cursor inside `word` on `line`, at level Seg+Var, and polls the
     *  spotlight state until `done` holds (the JS language service needs to warm up). */
    async function spotlightAt(
      api: TestApi,
      doc: vscode.TextDocument,
      editor: vscode.TextEditor,
      line: number,
      word: string,
      done: (spot: SpotlightRender) => boolean,
    ): Promise<SpotlightRender | undefined> {
      const col = doc.lineAt(line).text.indexOf(word) + 1;
      await vscode.commands.executeCommand('sightread.spotlightOff');
      await vscode.commands.executeCommand('sightread.spotlightCycle'); // Off → Seg+Var
      let spot;
      for (let i = 0; i < 100; i++) {
        editor.selection = new vscode.Selection(line, col, line, col);
        await vscode.commands.executeCommand('cursorMove', { to: 'right' });
        await sleep(200);
        spot = api._test.compositor.getTransient(doc.uri)?.spotlight;
        if (spot && done(spot)) {
          break;
        }
      }
      await vscode.commands.executeCommand('sightread.spotlightOff');
      return spot;
    }

    test('cursor on the definition header keeps the outer function scope and lights the call site', async function () {
      this.timeout(30000);
      const api = await getApi();
      const doc = await vscode.workspace.openTextDocument({
        content: NESTED_FN_SOURCE,
        language: 'javascript',
      });
      const editor = await vscode.window.showTextDocument(doc);

      const spot = await spotlightAt(
        api,
        doc,
        editor,
        3,
        'inner',
        (s) => s.fn.start === 0 && covers(s.lit, 7),
      );
      assert.ok(spot, 'spotlight state was never computed');
      assert.deepStrictEqual(
        spot.fn,
        { start: 0, end: 9 },
        `definition header must scope to the outer function, got ${JSON.stringify(spot.fn)}`,
      );
      assert.ok(
        covers(spot.lit, 7),
        `call-site line 7 should be lit at Seg+Var, got ${JSON.stringify(spot.lit)}`,
      );
      assert.ok(covers(spot.lit, 3), 'the definition segment itself should be lit');
    });

    test('calling a sibling local function lights its definition as an island', async function () {
      this.timeout(30000);
      const api = await getApi();
      const doc = await vscode.workspace.openTextDocument({
        content: [
          'function outer() {', //       0
          '  function inner2(y) {', //   1
          '    return y * 2;', //        2
          '  }', //                      3
          '',
          '  function inner1(x) {', //   5
          '    const a = x + 1;', //     6
          '    return inner2(a);', //    7
          '  }', //                      8
          '',
          '  return inner1(1);', //      10
          '}', //                        11
          '',
        ].join('\n'),
        language: 'javascript',
      });
      const editor = await vscode.window.showTextDocument(doc);

      const spot = await spotlightAt(
        api,
        doc,
        editor,
        7,
        'inner2',
        (s) => s.fn.start === 5 && covers(s.lit, 1),
      );
      assert.ok(spot, 'spotlight state was never computed');
      assert.deepStrictEqual(
        spot.fn,
        { start: 5, end: 8 },
        'the anchor stays on inner1 — the island must not widen the function scope',
      );
      assert.ok(
        covers(spot.lit, 1) && covers(spot.lit, 2),
        `inner2's definition should be lit as an island, got ${JSON.stringify(spot.lit)}`,
      );
      assert.ok(covers(spot.lit, 7), 'the cursor segment itself should be lit');
      assert.ok(
        !covers(spot.lit, 10) && !covers(spot.light, 10),
        'unrelated outer-function lines stay heavily dimmed',
      );
    });

    test('cursor on the call site lights the nested function definition', async function () {
      this.timeout(30000);
      const api = await getApi();
      const doc = await vscode.workspace.openTextDocument({
        content: NESTED_FN_SOURCE,
        language: 'javascript',
      });
      const editor = await vscode.window.showTextDocument(doc);

      const spot = await spotlightAt(
        api,
        doc,
        editor,
        7,
        'inner',
        (s) => s.fn.start === 0 && covers(s.lit, 3),
      );
      assert.ok(spot, 'spotlight state was never computed');
      assert.deepStrictEqual(spot.fn, { start: 0, end: 9 }, 'call site scopes to the outer function');
      assert.ok(
        covers(spot.lit, 3) && covers(spot.lit, 4),
        `definition lines should be lit at Seg+Var, got ${JSON.stringify(spot.lit)}`,
      );
      assert.ok(covers(spot.lit, 7), 'the cursor segment itself should be lit');
    });
  });

  test('segments view follows the cursor and dims unrelated segments under spotlight', async function () {
    this.timeout(30000);
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: [
        'function demo(a) {', //     0
        '  if (a) {', //             1
        '    use(a);', //            2
        '    more(a);', //           3
        '  }', //                    4
        '',
        '  for (const x of a) {', // 6
        '    use(x);', //            7
        '    more(x);', //           8
        '  }', //                    9
        '',
        '  return a;', //            11
        '}', //                      12
        '',
      ].join('\n'),
      language: 'javascript',
    });
    const editor = await vscode.window.showTextDocument(doc);
    const view = api._test.segmentsView;

    // reveal only runs while the view is visible
    await vscode.commands.executeCommand('sightread.segmentsView.focus');

    await vscode.commands.executeCommand('sightread.spotlightOff');
    await vscode.commands.executeCommand('sightread.spotlightCycle'); // Seg+Var
    await vscode.commands.executeCommand('sightread.spotlightCycle'); // Seg

    // cursor inside the if-body — poll until the pipeline selects its segment
    // (the JS language service needs to warm up; alternate lines to refire events)
    let selected: { node: { startLine: number; endLine: number } } | undefined;
    for (let i = 0; i < 100; i++) {
      const line = 2 + (i % 2);
      editor.selection = new vscode.Selection(line, 5, line, 5);
      await sleep(200);
      selected = view.treeSelection[0];
      if (selected && selected.node.startLine <= 2 && 2 <= selected.node.endLine) {
        break;
      }
    }
    assert.ok(selected, 'segments view never selected a segment');
    assert.ok(
      selected.node.startLine <= 2 && 2 <= selected.node.endLine,
      `selection should contain the cursor line, got ${selected.node.startLine}-${selected.node.endLine}`,
    );

    // the selected (cursor) segment label carries the anchor highlight
    const selectedItem = view.getTreeItem(view.treeSelection[0]);
    const label = selectedItem.label as vscode.TreeItemLabel;
    assert.ok(
      typeof label === 'object' && (label.highlights?.length ?? 0) > 0,
      'cursor segment label should be highlighted while the spotlight is on',
    );

    // the unrelated loop segment dims, the cursor's own top-level segment stays lit
    const roots = view.getChildren();
    const at = (line: number) =>
      roots.find((el) => el.node.startLine <= line && line <= el.node.endLine);
    const ifSeg = at(2);
    const loopSeg = at(7);
    assert.ok(ifSeg && loopSeg, 'expected top-level if and loop segments');
    const ifUri = view.getTreeItem(ifSeg).resourceUri;
    const loopUri = view.getTreeItem(loopSeg).resourceUri;
    assert.ok(ifUri && loopUri, 'segment items should carry decoration URIs');
    assert.strictEqual(
      view.provideFileDecoration(ifUri),
      undefined,
      'the cursor segment must keep its normal color',
    );
    assert.ok(
      view.provideFileDecoration(loopUri),
      'the unrelated loop segment should be dimmed',
    );

    // spotlight off → no dimming, no anchor highlight
    await vscode.commands.executeCommand('sightread.spotlightOff');
    let undimmed = false;
    for (let i = 0; i < 100; i++) {
      editor.selection = new vscode.Selection(2 + (i % 2), 5, 2 + (i % 2), 5);
      await sleep(200);
      if (view.provideFileDecoration(loopUri) === undefined) {
        undimmed = true;
        break;
      }
    }
    assert.ok(undimmed, 'spotlight off should clear the dimming');
    const deepestAt = (line: number) => {
      let pool = view.getChildren();
      let found;
      for (;;) {
        const el = pool.find((e) => e.node.startLine <= line && line <= e.node.endLine);
        if (!el) {
          break;
        }
        found = el;
        pool = view.getChildren(el);
      }
      return found;
    };
    const cursorEl = deepestAt(2);
    assert.ok(cursorEl, 'cursor segment should still exist');
    assert.strictEqual(
      typeof view.getTreeItem(cursorEl).label,
      'string',
      'no anchor highlight while the spotlight is off',
    );
  });

  test('a marker tints the intersecting segment item; removeSegmentMarkers clears it', async function () {
    this.timeout(30000);
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: [
        'function tinted(a) {', // 0
        '  if (a) {', //           1
        '    use(a);', //          2
        '  }', //                  3
        '',
        '  return a;', //          5
        '}', //                    6
        '',
      ].join('\n'),
      language: 'javascript',
    });
    const editor = await vscode.window.showTextDocument(doc);
    const view = api._test.segmentsView;

    // poll until the segment tree exists (language service warm-up)
    let ifSeg;
    for (let i = 0; i < 100; i++) {
      const line = 2 + (i % 2) * 3; // alternate 2/5 to refire selection events
      editor.selection = new vscode.Selection(line, 4, line, 4);
      await sleep(200);
      ifSeg = view
        .getChildren()
        .find((el) => el.node.startLine <= 2 && 2 <= el.node.endLine);
      if (ifSeg) {
        break;
      }
    }
    assert.ok(ifSeg, 'segments view never produced the if segment');
    const segUri = view.getTreeItem(ifSeg).resourceUri;
    assert.ok(segUri, 'segment item should carry a decoration URI');
    assert.strictEqual(view.provideFileDecoration(segUri), undefined, 'untinted before marking');

    // a marker on one line inside the segment tints the whole item (partial overlap counts)
    editor.selection = new vscode.Selection(2, 0, 2, 6);
    await vscode.commands.executeCommand('sightread.markFavorite');
    const deco = view.provideFileDecoration(segUri);
    assert.ok(deco?.color, 'marked segment label should carry the marker color');

    await vscode.commands.executeCommand('sightread.removeSegmentMarkers', ifSeg);
    assert.strictEqual(api._test.repo.get(doc.uri).length, 0);
    assert.strictEqual(
      view.provideFileDecoration(segUri),
      undefined,
      'tint should disappear with the marker',
    );
  });

  test('entry points: exported → entry, wrapped → hidden, orphan/top-level-called → suspected', async function () {
    this.timeout(30000);
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: [
        "import { readFileSync } from 'fs';", // imported name → never an entry
        '',
        'export function publicApi() {', // export keyword → entry even with no refs
        '  return helper() + 1;',
        '}',
        '',
        'function helper() {', //           wrapped by publicApi above → hidden
        '  return 2;',
        '}',
        '',
        'function orphan() {', //           no refs anywhere → suspected
        '  return 3;',
        '}',
        '',
        'function bootstrap() {', //        called only from top-level code → suspected, not hidden
        '  return 4;',
        '}',
        '',
        'bootstrap();',
        '',
      ].join('\n'),
      language: 'javascript',
    });
    await vscode.window.showTextDocument(doc);
    const view = api._test.entriesView;

    // the JS language service needs to warm up before references resolve — poll
    let names: string[] = [];
    for (let i = 0; i < 100; i++) {
      const scan = view.ensureScan(doc, true);
      await scan.done;
      names = (await view.getChildren()).map((s) => s.name);
      if (names.join(',') === 'publicApi,orphan,bootstrap') {
        break;
      }
      await sleep(200);
    }
    assert.deepStrictEqual(
      names,
      ['publicApi', 'orphan', 'bootstrap'],
      'entries sorted first, wrapped symbols hidden, top-level-called symbols kept',
    );

    const visible = await view.getChildren();
    assert.strictEqual(view.getTreeItem(visible[0]).description, 'exported');
    assert.strictEqual(view.getTreeItem(visible[1]).description, 'no refs found');
    assert.strictEqual(view.getTreeItem(visible[2]).description, 'called at top level');
    assert.strictEqual(
      view.getTreeItem(visible[0]).command?.command,
      'sightread.revealLocation',
    );
  });

  test('spotlight cycles through levels without error', async () => {
    await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: 'function f() {\n  const a = 1;\n\n  return a;\n}\n',
      language: 'javascript',
    });
    await vscode.window.showTextDocument(doc);
    for (let i = 0; i < 4; i++) {
      await vscode.commands.executeCommand('sightread.spotlightCycle');
      await sleep(200);
    }
    await vscode.commands.executeCommand('sightread.spotlightOff');
    assert.ok(true);
  });
});
