import * as assert from 'assert';
import * as vscode from 'vscode';
import { type Guide, type Mark, addGuide } from '../../core/marks';
import type { Compositor, SpotlightRender } from '../../vs/compositor';
import type { EntriesFeature } from '../../vs/entries';
import { type MarkRepository, migrateLegacyStorage } from '../../vs/markRepository';
import type { MarkersViewFeature } from '../../vs/markersView';
import type { SegmentsViewFeature } from '../../vs/segmentsView';
import type { TrailViewFeature } from '../../vs/trailView';

interface TestApi {
  _test: {
    repo: MarkRepository;
    compositor: Compositor;
    markersView: MarkersViewFeature;
    entries: EntriesFeature;
    segmentsView: SegmentsViewFeature;
    trailView: TrailViewFeature;
  };
}

/** Seeds one AI guide (shell + role steps) into the repo, as interpret would. */
function seedGuide(
  repo: MarkRepository,
  uri: vscode.Uri,
  guide: Guide,
  steps: Omit<Mark, 'accent' | 'guideId' | 'order'>[],
  roles: (string | undefined)[],
): void {
  repo.set(
    uri,
    addGuide(
      repo.get(uri),
      guide,
      steps.map((s, i) => ({
        ...s,
        accent: { kind: 'role' as const, role: roles[i] },
        guideId: guide.id,
        order: i,
      })),
    ),
  );
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
      'sightread.markPickColor',
      'sightread.markYellow',
      'sightread.markRed',
      'sightread.markGreen',
      'sightread.markBlue',
      'sightread.markPurple',
      'sightread.markSegment',
      'sightread.markSegmentWithNote',
      'sightread.removeSegmentMarkers',
      'sightread.editMarkerNote',
      'sightread.editMarkerNoteItem',
      'sightread.removeMarkersInSelection',
      'sightread.removeMarkersInFunction',
      'sightread.removeMarkersInFile',
      'sightread.removeAllMarkers',
      'sightread.markersCollapseAll',
      'sightread.markersExpandAll',
      'sightread.trailCollapseAll',
      'sightread.trailExpandAll',
      'sightread.trailClear',
      'sightread.spotlightSelect',
      'sightread.spotlightOff',
      'sightread.spotlightFunction',
      'sightread.spotlightSegment',
      'sightread.spotlightSegmentVar',
      'sightread.toggleVariableTint',
      'sightread.goToSegment',
      'sightread.goToEntry',
      'sightread.peekEntryReferences',
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
    await vscode.commands.executeCommand('sightread.markYellow');
    let marks = api._test.repo.get(doc.uri).marks;
    assert.strictEqual(marks.length, 1);
    assert.deepStrictEqual([marks[0].startLine, marks[0].endLine], [1, 2]);

    // edit above → mark shifts down
    await editor.edit((eb) => eb.insert(new vscode.Position(0, 0), 'inserted\n'));
    await sleep(100);
    marks = api._test.repo.get(doc.uri).marks;
    assert.strictEqual(marks.length, 1);
    assert.deepStrictEqual([marks[0].startLine, marks[0].endLine], [2, 3]);

    // edit inside → mark auto-deletes
    await editor.edit((eb) => eb.insert(new vscode.Position(2, 1), 'zz'));
    await sleep(100);
    assert.strictEqual(api._test.repo.get(doc.uri).marks.length, 0);
  });

  test('markers view lists marked locations with preview snapshots', async () => {
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: 'const answer = 42;\nsecond line\nthird line\n',
      language: 'plaintext',
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 5);
    await vscode.commands.executeCommand('sightread.markYellow');

    const mark = api._test.repo.get(doc.uri).marks[0];
    assert.ok(mark, 'mark should exist');
    assert.strictEqual(mark.preview, 'const answer = 42;');

    const roots = api._test.markersView.getChildren();
    const fileNode = roots.find(
      (n) => n.kind === 'file' && n.uri.toString() === doc.uri.toString(),
    );
    assert.ok(fileNode, 'markers view should list the marked file');
    const children = api._test.markersView.getChildren(fileNode);
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].kind, 'mark');

    const item = api._test.markersView.getTreeItem(children[0]);
    assert.strictEqual(item.label, 'const answer = 42;');
    assert.strictEqual(item.command?.command, 'sightread.revealLocation');

    await vscode.commands.executeCommand('sightread.removeMarker', children[0]);
    assert.strictEqual(api._test.repo.get(doc.uri).marks.length, 0);
  });

  test('markers view lists markers in line order, not creation order', async () => {
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: 'a\nb\nc\nd\n',
      language: 'plaintext',
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(2, 0, 2, 1);
    await vscode.commands.executeCommand('sightread.markYellow');
    editor.selection = new vscode.Selection(0, 0, 0, 1);
    await vscode.commands.executeCommand('sightread.markYellow');

    const view = api._test.markersView;
    const fileNode = view
      .getChildren()
      .find((n) => n.kind === 'file' && n.uri.toString() === doc.uri.toString());
    assert.ok(fileNode, 'markers view should list the marked file');
    const lines = view
      .getChildren(fileNode)
      .map((n) => (n.kind === 'mark' ? n.mark.startLine : -1));
    assert.deepStrictEqual(lines, [0, 2], 'marks should mirror the file top-down');
    await vscode.commands.executeCommand('sightread.removeMarkersInFile');
  });

  test('removeMarkersInFile clears markers', async () => {
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: 'a\nb\nc\n',
      language: 'plaintext',
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 1, 1);
    await vscode.commands.executeCommand('sightread.markYellow');
    assert.strictEqual(api._test.repo.get(doc.uri).marks.length, 1);
    await vscode.commands.executeCommand('sightread.removeMarkersInFile');
    assert.strictEqual(api._test.repo.get(doc.uri).marks.length, 0);
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

    await vscode.commands.executeCommand('sightread.spotlightSegment'); // level 2

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

    await vscode.commands.executeCommand('sightread.spotlightFunction'); // level 1
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
      await vscode.commands.executeCommand('sightread.spotlightSegmentVar'); // level 3
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

    await vscode.commands.executeCommand('sightread.spotlightSegment'); // level 2

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

    // a mark on one line inside the segment tints the whole item (partial overlap counts)
    editor.selection = new vscode.Selection(2, 0, 2, 6);
    await vscode.commands.executeCommand('sightread.markYellow');
    const deco = view.provideFileDecoration(segUri);
    assert.ok(deco?.color, 'marked segment label should carry the marker color');

    await vscode.commands.executeCommand('sightread.removeSegmentMarkers', ifSeg);
    assert.strictEqual(api._test.repo.get(doc.uri).marks.length, 0);
    assert.strictEqual(
      view.provideFileDecoration(segUri),
      undefined,
      'tint should disappear with the marker',
    );
  });

  test('a guide step tints the intersecting segment item; hiding its role clears it', async function () {
    this.timeout(30000);
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: [
        'function guided(a) {', // 0
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
    assert.strictEqual(view.provideFileDecoration(segUri), undefined, 'untinted before the guide');

    // an AI guide step on one line inside the segment tints it, like a manual mark
    seedGuide(
      api._test.repo,
      doc.uri,
      { id: 'guide-tint', subject: 'guided', unit: 'function' },
      [{ id: 'step-tint', note: 'the branch', startLine: 2, endLine: 2 }],
      ['main'],
    );
    const deco = view.provideFileDecoration(segUri);
    assert.ok(deco?.color, 'guide-covered segment label should carry the role color');

    // hiding the step's role removes the tint (the filter applies everywhere)
    api._test.compositor.setHiddenAccents(new Set(['role:main']));
    assert.strictEqual(
      view.provideFileDecoration(segUri),
      undefined,
      'tint should disappear with the hidden role',
    );
    api._test.compositor.setHiddenAccents(new Set());
    await vscode.commands.executeCommand('sightread.removeMarkersInFile');
  });

  test('accent filter hides filtered steps in the markers view, keeping original numbering', async () => {
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: 'alpha\nbeta\ngamma\n',
      language: 'plaintext',
    });
    seedGuide(
      api._test.repo,
      doc.uri,
      { id: 'guide-filter', subject: 'demo', unit: 'file' },
      [
        { id: 'step-1', note: 'first', startLine: 0, endLine: 0 },
        { id: 'step-2', note: 'second', startLine: 1, endLine: 1 },
      ],
      ['main', 'util'],
    );
    const view = api._test.markersView;
    const fileNode = view
      .getChildren()
      .find((n) => n.kind === 'file' && n.uri.toString() === doc.uri.toString());
    assert.ok(fileNode, 'markers view should list the guided file');
    const guideNode = view.getChildren(fileNode).find((n) => n.kind === 'guide');
    assert.ok(guideNode, 'the guide should sit under its file');
    assert.strictEqual(view.getChildren(guideNode).length, 2);

    api._test.compositor.setHiddenAccents(new Set(['role:main']));
    const steps = view.getChildren(guideNode);
    assert.strictEqual(steps.length, 1, 'the hidden role step should disappear from the view');
    const only = steps[0];
    assert.ok(only.kind === 'mark', 'remaining node is a mark');
    assert.strictEqual(only.mark.id, 'step-2');
    assert.strictEqual(only.mark.order, 1, 'keeps the original reading-order position');
    assert.ok(
      String(view.getTreeItem(only).label).startsWith('2.'),
      'numbering matches the editor step badges',
    );

    api._test.compositor.setHiddenAccents(new Set());
    assert.strictEqual(view.getChildren(guideNode).length, 2, 'clearing the filter restores steps');
    api._test.repo.set(doc.uri, { marks: [], guides: [] });
  });

  test('markers: message counts hidden marks; clearing marks restores the welcome', async () => {
    const api = await getApi();
    const view = api._test.markersView;
    api._test.repo.clearAll();
    const doc = await vscode.workspace.openTextDocument({
      content: 'one\ntwo\n',
      language: 'plaintext',
    });
    api._test.repo.set(doc.uri, {
      marks: [
        { id: 'm-y', accent: { kind: 'color', color: 'yellow' }, startLine: 0, endLine: 0 },
        { id: 'm-b', accent: { kind: 'color', color: 'blue' }, startLine: 1, endLine: 1 },
      ],
      guides: [],
    });
    api._test.compositor.setHiddenAccents(new Set(['color:yellow']));
    assert.strictEqual(view.viewMessage, '⊘ 1 hidden', 'counts marks, not hidden accent keys');
    api._test.compositor.setHiddenAccents(new Set(['color:yellow', 'color:blue']));
    assert.strictEqual(view.viewMessage, '⊘ 2 hidden');
    assert.strictEqual(
      view
        .getChildren()
        .filter((n) => n.kind === 'file' && n.uri.toString() === doc.uri.toString()).length,
      0,
      'a file whose every mark is hidden drops from the list',
    );
    // clearing the marks must clear the message too — a lingering message
    // suppresses the viewsWelcome empty state (the welcome-never-returns bug)
    api._test.repo.set(doc.uri, { marks: [], guides: [] });
    assert.strictEqual(view.viewMessage, undefined, 'no marks hidden — no message');
    api._test.compositor.setHiddenAccents(new Set());
  });

  test('legacy markers+guides storage migrates into the unified key', () => {
    const store = new Map<string, unknown>();
    const memento = {
      get: <T>(key: string, dflt?: T): T | undefined => (store.get(key) as T) ?? dflt,
      update: (key: string, value: unknown): Thenable<void> => {
        if (value === undefined) {
          store.delete(key);
        } else {
          store.set(key, value);
        }
        return Promise.resolve();
      },
    } as vscode.Memento;
    store.set('sightread.markers', {
      'file:///a.ts': [
        { id: 'm1', color: 'red', note: 'why', startLine: 3, endLine: 4 },
      ],
    });
    store.set('sightread.guides', {
      'file:///a.ts': [
        {
          id: 'g1',
          subject: 'fn',
          unit: 'function',
          summary: 'sum',
          startLine: 0,
          endLine: 9,
          steps: [{ id: 's1', note: 'n', role: 'main', startLine: 1, endLine: 2 }],
        },
      ],
    });
    migrateLegacyStorage(memento);
    assert.strictEqual(store.has('sightread.markers'), false);
    assert.strictEqual(store.has('sightread.guides'), false);
    const merged = store.get('sightread.marks') as Record<
      string,
      { marks: Mark[]; guides: Guide[] }
    >;
    const state = merged['file:///a.ts'];
    assert.strictEqual(state.guides.length, 1);
    assert.strictEqual(state.guides[0].summary, 'sum');
    assert.deepStrictEqual(
      state.marks.map((m) => [m.id, m.accent.kind, m.guideId ?? null]),
      [
        ['s1', 'role', 'g1'],
        ['m1', 'color', null],
      ],
      'marks sort by line: the step at L1 precedes the manual mark at L3',
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
    const feature = api._test.entries;

    // the JS language service needs to warm up before references resolve — poll
    let names: string[] = [];
    for (let i = 0; i < 100; i++) {
      const scan = feature.ensureScan(doc, true);
      await scan.done;
      names = feature.visibleSymbols(scan.symbols).map((s) => s.name);
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

    const lenses = feature.provideCodeLenses(doc);
    assert.deepStrictEqual(
      lenses.map((l) => l.command?.title),
      [
        '» entry — exported',
        '» suspected entry — no refs found',
        '» suspected entry — called at top level',
      ],
    );
    assert.strictEqual(lenses[0].command?.command, 'sightread.peekEntryReferences');
  });

  test('trail: a real go-to-definition jump records caller → callee', async function () {
    this.timeout(30000);
    const api = await getApi();
    const trail = api._test.trailView;
    // recording is gated on the view being visible
    await vscode.commands.executeCommand('sightread.trailView.focus');
    const doc = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: [
        'function callee() {',
        '  return 1;',
        '}',
        '',
        'function caller() {',
        '  const x = callee();',
        '  return x + 1;',
        '}',
        '',
      ].join('\n'),
    });
    const editor = await vscode.window.showTextDocument(doc);
    trail.clear();
    const callSite = new vscode.Position(5, 14); // on `callee` in `const x = callee();`
    const edge = (): { callsiteLine: number } | undefined => {
      const root = trail.graph.roots().find((r) => r.name === 'caller');
      return root
        ? trail.graph.children(root.key).find((c) => c.node.name === 'callee')
        : undefined;
    };
    // retry until the JS language service is warm enough to jump and verify
    for (let i = 0; i < 20 && !edge(); i++) {
      editor.selection = new vscode.Selection(callSite, callSite);
      await sleep(400); // departure state settles through the cursor pipeline
      await vscode.commands.executeCommand('editor.action.revealDefinition');
      await sleep(600); // landing settles + definition-provider verification
    }
    assert.ok(edge(), 'expected a caller → callee edge after go-to-definition');
    assert.strictEqual(edge()!.callsiteLine, 5);
    trail.clear();
  });

  test('trail: cursor arriving inside a walked node selects it in the view', async function () {
    this.timeout(30000);
    const api = await getApi();
    const trail = api._test.trailView;
    await vscode.commands.executeCommand('sightread.trailView.focus');
    const doc = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: [
        'function callee() {',
        '  return 1;',
        '}',
        '',
        'function caller() {',
        '  const x = callee();',
        '  return x + 1;',
        '}',
        '',
      ].join('\n'),
    });
    const editor = await vscode.window.showTextDocument(doc);
    trail.clear();
    const uri = doc.uri.toString();
    // seed a walked edge directly — under test is the reveal, not the recording
    trail.graph.recordEdge(
      { key: `${uri}##caller`, name: 'caller', kind: 'function', uriString: uri, line: 4, endLine: 7 },
      { key: `${uri}##callee`, name: 'callee', kind: 'function', uriString: uri, line: 0, endLine: 2 },
      5,
    );
    // render the seeded nodes (recordEdge alone does not fire the tree)
    trail.setFolded(true);
    trail.setFolded(false);
    await sleep(300);
    let selectedKey: string | undefined;
    for (let i = 0; i < 15 && selectedKey !== `${uri}##callee`; i++) {
      editor.selection = new vscode.Selection(3, 0, 3, 0); // between the functions
      await sleep(250);
      editor.selection = new vscode.Selection(1, 4, 1, 4); // inside callee's body
      await sleep(450);
      selectedKey = trail.treeSelection[0]?.key;
    }
    assert.strictEqual(
      selectedKey,
      `${uri}##callee`,
      'the view should follow the cursor into a trail node',
    );
    trail.clear();
  });

  test('trail: cursor arriving inside a planned node converts and selects it', async function () {
    this.timeout(30000);
    const api = await getApi();
    const trail = api._test.trailView;
    await vscode.commands.executeCommand('sightread.trailView.focus');
    const doc = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: [
        'function planned() {',
        '  return 1;',
        '}',
        '',
        'function entry() {',
        '  return planned();',
        '}',
        '',
      ].join('\n'),
    });
    const editor = await vscode.window.showTextDocument(doc);
    trail.clear();
    const uri = doc.uri.toString();
    await trail.applyRoute(
      [
        {
          node: {
            key: `${uri}##entry`,
            name: 'entry',
            kind: 'function',
            uriString: uri,
            line: 4,
            endLine: 6,
          },
        },
        {
          node: {
            key: `${uri}##planned`,
            name: 'planned',
            kind: 'function',
            uriString: uri,
            line: 0,
            endLine: 2,
          },
          calledFrom: 0,
          callsiteLine: 5,
        },
      ],
      'test route',
    );
    let selectedKey: string | undefined;
    for (let i = 0; i < 15 && selectedKey !== `${uri}##planned`; i++) {
      editor.selection = new vscode.Selection(3, 0, 3, 0);
      await sleep(250);
      editor.selection = new vscode.Selection(1, 4, 1, 4); // inside planned()
      await sleep(450);
      selectedKey = trail.treeSelection[0]?.key;
    }
    assert.strictEqual(selectedKey, `${uri}##planned`, 'arrival should select the converted node');
    assert.strictEqual(
      trail.graph.node(`${uri}##planned`)?.planned,
      false,
      'arrival converts the planned node',
    );
    trail.clear();
  });

  test('trail: a FAST jump (no pause on the call site) is still recorded', async function () {
    this.timeout(30000);
    const api = await getApi();
    const trail = api._test.trailView;
    await vscode.commands.executeCommand('sightread.trailView.focus');
    const doc = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: [
        'function fast() {',
        '  return 2;',
        '}',
        '',
        'function rush() {',
        '  return fast();',
        '}',
        '',
      ].join('\n'),
    });
    const editor = await vscode.window.showTextDocument(doc);
    trail.clear();
    const callSite = new vscode.Position(5, 12); // on `fast` in `return fast();`
    const parked = new vscode.Position(7, 0); // away from the call, so each retry re-jumps
    const edge = (): { callsiteLine: number } | undefined => {
      const root = trail.graph.roots().find((r) => r.name === 'rush');
      return root
        ? trail.graph.children(root.key).find((c) => c.node.name === 'fast')
        : undefined;
    };
    for (let i = 0; i < 20 && !edge(); i++) {
      editor.selection = new vscode.Selection(parked, parked);
      await sleep(300);
      // click on the call and jump immediately — inside the pipeline debounce
      // window, so the departure never settles and only the raw trace has it
      editor.selection = new vscode.Selection(callSite, callSite);
      await vscode.commands.executeCommand('editor.action.revealDefinition');
      await sleep(600);
    }
    assert.ok(edge(), 'expected a rush → fast edge from the raw-trace fallback');
    assert.strictEqual(edge()!.callsiteLine, 5);
    trail.clear();
  });

  test('trail: convergence mirrors the callee under both callers, ↻ on a recursion leaf', async function () {
    this.timeout(60000);
    const api = await getApi();
    const trail = api._test.trailView;
    await vscode.commands.executeCommand('sightread.trailView.focus');

    // --- convergence: read `shared`, then visit call sites in two callers ---
    const doc = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: [
        'function shared() {', //           0, name at 9-14
        '  return 1;',
        '}',
        '',
        'function alpha() {', //            4
        '  return shared();', //            5, `shared` at 9-14
        '}',
        '',
        'function beta() {', //             8
        '  return shared() + 2;', //        9
        '}',
        '',
      ].join('\n'),
    });
    const editor = await vscode.window.showTextDocument(doc);
    trail.clear();
    const goTo = (line: number, ch: number): void => {
      const p = new vscode.Position(line, ch);
      editor.selection = new vscode.Selection(p, p);
    };
    const sharedNode = (): { key: string } | undefined =>
      trail.graph
        .roots()
        .flatMap((r) => trail.graph.children(r.key))
        .find((c) => c.node.name === 'shared')?.node;
    const callers = (): number => {
      const node = sharedNode();
      return node ? trail.graph.inDegree(node.key) : 0;
    };
    for (let i = 0; i < 15 && callers() < 2; i++) {
      goTo(0, 12); // on shared's own name — "the symbol being read"
      await sleep(300);
      goTo(5, 12); // its call site inside alpha → ref-jump: alpha → shared
      await sleep(500);
      goTo(0, 12);
      await sleep(300);
      goTo(9, 12); // its call site inside beta → ref-jump: beta → shared
      await sleep(500);
    }
    assert.strictEqual(callers(), 2, 'expected shared to have 2 discovered callers');
    // the convergence shows as topology: shared mirrors under each caller
    for (const rootName of ['alpha', 'beta']) {
      const root = trail.graph.roots().find((r) => r.name === rootName);
      assert.ok(root, `${rootName} should be a root`);
      const mirror = trail
        .getChildren({ key: root!.key, path: [], recursive: false })
        .find((c) => c.key === sharedNode()!.key);
      assert.ok(mirror, `shared should appear under ${rootName}`);
    }

    // --- recursion: from the self-call site onto the function's own name ---
    const rdoc = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: [
        'function recur(n) {', //                        0, name at 9-13
        '  return n <= 0 ? 0 : recur(n - 1);', //        1, `recur` at 22-26
        '}',
        '',
      ].join('\n'),
    });
    const reditor = await vscode.window.showTextDocument(rdoc);
    trail.clear();
    const selfEdge = (): boolean => {
      const root = trail.graph.roots().find((r) => r.name === 'recur');
      return !!root && trail.graph.children(root.key).some((c) => c.node.key === root.key);
    };
    for (let i = 0; i < 15 && !selfEdge(); i++) {
      const p1 = new vscode.Position(1, 24);
      reditor.selection = new vscode.Selection(p1, p1); // on the recursive call
      await sleep(300);
      const p2 = new vscode.Position(0, 11);
      reditor.selection = new vscode.Selection(p2, p2); // onto recur's own name
      await sleep(500);
    }
    assert.ok(selfEdge(), 'expected a recur → recur self edge');
    const rootKey = trail.graph.roots().find((r) => r.name === 'recur')!.key;
    const leaf = trail
      .getChildren({ key: rootKey, path: [], recursive: false })
      .find((c) => c.recursive);
    assert.ok(leaf, 'the self-occurrence should be projected as a recursion leaf');
    assert.ok(String(trail.getTreeItem(leaf!).description).includes('↻'));
    trail.clear();
  });

  test('spotlight switches through every level without error', async () => {
    await getApi();
    const doc = await vscode.workspace.openTextDocument({
      content: 'function f() {\n  const a = 1;\n\n  return a;\n}\n',
      language: 'javascript',
    });
    await vscode.window.showTextDocument(doc);
    for (const command of [
      'sightread.spotlightSegmentVar',
      'sightread.spotlightSegment',
      'sightread.spotlightFunction',
    ]) {
      await vscode.commands.executeCommand(command);
      await sleep(200);
    }
    await vscode.commands.executeCommand('sightread.spotlightOff');
    assert.ok(true);
  });
});
