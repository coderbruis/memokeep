(function expose(root) {
  function createCardDialogBindings({ $, state, editor, detail, deleteCardById }) {
    let bound = false;
    function bind() {
      if (bound) return;
      bound = true;
      $('#cardForm').onsubmit = editor.handleSaveCard;
      $('#cardDetailEdit').onclick = () => {
        const card = state.cards.all.find(candidate => candidate.id === $('#cardDetailId').value);
        if (!card) return;
        $('#cardDetailDialog').close();
        editor.openCardDialog(card);
      };
      $('#cardDetailDelete').onclick = () => deleteCardById($('#cardDetailId').value, true);
      $('#cardDetailOpenSource').onclick = detail.openCardDetailSourceDrawer;
      $('#cardDetailCloseSource').onclick = detail.closeCardDetailSourceDrawer;
      $('#cardDetailDialog').addEventListener('cancel', event => {
        if ($('#cardDetailSourceDrawer').classList.contains('hidden')) return;
        event.preventDefault();
        detail.closeCardDetailSourceDrawer();
      });
    }
    return { bind };
  }
  const api = { createCardDialogBindings };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepViews ||= {}, api);
})(globalThis);
