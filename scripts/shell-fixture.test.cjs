const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const manifest = require('./fixtures/shell-manifest.json');
const { bindShellFixture } = require('./shell-fixture.cjs');

// Migrated application APIs must be exercised through their module owners.
const retiredNames = [
  "libraryById", "itemById", "save", "refreshSharedData", "applySharedData",
  "parseInlineCards", "parseInlineCardLine", "duplicateCardQuestion", "cardQuestionKey", "validateNotebookQuestionEdit",
  "flushActiveNoteEditor", "resetActiveNoteEditor", "leaveActiveNoteEditor", "saveNoteBeforeTabChange", "flushNoteTabsForWindowClose",
  "mountNoteTabControls", "renderNoteTabs", "bindNoteTabs", "renderCards", "openCardDialog",
  "handleSaveCard", "openCardDetail", "fillLibrarySelects", "cardScope", "activeCardFilter",
  "activeCardLibraryFilter", "cardPage", "cardPageFilterKey", "selectedCardIds", "selectedCardTags",
  "cardTagMatchMode", "cardTagScopeKey", "cardTagResultCount", "closedCardFolders", "reviewQueue",
  "reviewIndex", "reviewCardShownAt", "reviewActionPending", "reviewedCardIds", "reviewSessionStartedAt",
  "reviewSessionResults", "reviewSessionKey", "reviewScopeIds", "reviewSessionPaused", "reviewOutcomeController",
  "reviewMemoryPanel", "reviewAwaitingContinue", "deleteCardById", "openMoveCardsDialog", "moveSelectedCards",
  "restartSelectedCardsForReview", "setSelectedCardsStatus", "deleteSelectedCards", "showCardUndo",
];
function renderer() {
  const shell = {};
  for (const route of Object.values({ ...manifest.fields, ...manifest.constants, ...manifest.functions })) {
    const parts = route.split('.'), key = parts.pop(); let owner = shell;
    for (const part of parts) owner = owner[part] ||= {};
    owner[key] = undefined;
  }
  const data = { cards: [] }, runtime = { cardPage: 1 };
  shell.state.persistence.data = data;
  let saves = 0;
  const context = vm.createContext({ applicationShell: shell,
    application: { persistence: { save: () => { saves++; } }, cards: { runtime } } });
  bindShellFixture(context);
  return { shell, data, runtime, context, saves: () => saves };
}
test('renderer fixture leaves migrated APIs unbound and explicit module calls retain canonical state', () => {
  const h = renderer();
  vm.runInContext('application.persistence.save(); application.cards.runtime.cardPage = 3;', h.context);
  for (const name of retiredNames) assert.equal(vm.runInContext(`typeof ${name}`, h.context), 'undefined', name);
  assert.equal(h.saves(), 1); assert.equal(h.runtime.cardPage, 3);
  assert.equal(vm.runInContext('data', h.context), h.data);
  vm.runInContext('data = { cards: [{ id: "replacement" }] };', h.context);
  assert.equal(vm.runInContext('data', h.context), h.shell.state.persistence.data);
  assert.equal(h.shell.state.persistence.data.cards[0].id, 'replacement');
});
