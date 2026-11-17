(function expose(root) {
  function createCardBulkView({ $, document, state, runtime, operations, trash, setTimer, clearTimer, helpers }) {
    const { showToast, showConfirmDialog, renderAll, cardNotebookOptions, cardDestination } = helpers;
    function showCardUndo(entryIds, count) {
      const host = $('#cardUndoStack');
      const notice = document.createElement('div');
      notice.className = 'card-undo-notice';
      const label = document.createElement('span');
      label.textContent = `${count} 张卡片已移入回收站`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '撤销删除';
      notice.append(label, button);
      host.append(notice);
      const timer = setTimer(() => notice.remove(), 8000);
      button.onclick = async () => {
        clearTimer(timer);
        button.disabled = true;
        try {
          const restored = await trash.restoreCardTrash(entryIds);
          notice.remove();
          showToast(restored ? `已恢复 ${restored} 张卡片，复习进度保持不变` : '卡片已恢复或已被彻底删除');
        } catch {
          button.disabled = false;
          showToast('撤销失败，请重试或前往回收站恢复', true);
        }
      };
    }

    async function deleteCardById(cardId, closeDetail = false) {
      const card = state.cards.all.find(candidate => candidate.id === cardId);
      if (!card) return;
      const confirmed = await showConfirmDialog({ title: '将这张卡片移入回收站？', message: `卡片正面：${card.question}\n可撤销删除或在回收站恢复，来源和复习进度会保留。`, confirmLabel: '移入回收站' });
      if (!confirmed) return;
      await trash.trashCards([cardId]);
      if (closeDetail) $('#cardDetailDialog').close();
    }

    function openMoveCardsDialog() {
      if (!runtime.selectedCardIds.size) return;
      $('#moveCardsHint').textContent = `已选择 ${runtime.selectedCardIds.size} 张卡片。移动后不会改变复习进度和来源笔记。`;
      $('#moveCardsLibrary').innerHTML = cardNotebookOptions();
      $('#moveCardsLibrary').required = false;
      $('#moveCardsDialog').showModal();
    }

    async function moveSelectedCards(event) {
      event.preventDefault();
      const destination = cardDestination($('#moveCardsLibrary').value);
      if (!runtime.selectedCardIds.size) return;
      let result;
      try { result = await operations.move(runtime.selectedCardIds, destination); }
      catch(error) { renderAll(); showToast(`移动失败：${error.message || '请重试'}`, true); return; }
      if (result.duplicate) { showToast('无法移动：目标目录中存在相同题目，请先修改重复题目。', true); return; }
      runtime.selectedCardIds.clear();
      $('#moveCardsDialog').close();
      renderAll();
      showToast(`${result.count} 张卡片已移动`);
    }

    async function setSelectedCardsStatus(status) {
      if (!runtime.selectedCardIds.size) return;
      const changedCount = await operations.setStatus(runtime.selectedCardIds, status, () => runtime.selectedCardIds.clear());
      renderAll();
      showToast(`${changedCount} 张卡片已${status === 'paused' ? '暂停' : '恢复'}`);
    }

    async function restartSelectedCardsForReview() {
      if (!runtime.selectedCardIds.size) return;
      const restartedCount = await operations.restart(runtime.selectedCardIds);
      runtime.selectedCardIds.clear();
      renderAll();
      showToast(`${restartedCount} 张卡片已加入待复习`);
    }

    async function deleteSelectedCards() {
      if (!runtime.selectedCardIds.size) return;
      const deleteCount = runtime.selectedCardIds.size;
      const confirmed = await showConfirmDialog({
        title: `删除选中的 ${deleteCount} 张卡片？`,
        message: '这些卡片将移入回收站并暂停参与复习，可一键撤销或在回收站恢复，复习进度会保留。',
        confirmLabel: '移入回收站'
      });
      if (!confirmed) return;
      await trash.trashCards([...runtime.selectedCardIds]);
    }
    return { showCardUndo, deleteCardById, openMoveCardsDialog, moveSelectedCards, setSelectedCardsStatus, restartSelectedCardsForReview, deleteSelectedCards };
  }
  const api = { createCardBulkView };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepViews ||= {}, api);
})(globalThis);
