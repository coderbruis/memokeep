(function expose(root) {
  function createCardEditor({ $, state, runtime, document, Event, setTimer, editorComponent, directory, imageIds, transact, helpers }) {
    const { selectedLibraryId: readLibraryId, documentById, escapeHtml, cardNotebookOptions, sanitizeRichNoteContent, renderMarkdown, cardDestination, cardFolderId, uid, createCard, deleteUnreferencedNoteImageFiles, renderAll, showToast } = helpers;
    let sourceQuote = '', sourceQuotePlainText = false;
    let sourceAnchor = null;
    const samePrompt = (first, second) => helpers.cardFormats?.sameCardPrompt ? helpers.cardFormats.sameCardPrompt(first, second) : first.question.trim() === second.question.trim();
    function fillLibrarySelects() {
      const directoryIndex = directory.index(state.read().knowledgeBases);
      const options = directory.entries(state.read().knowledgeBases).map(({ item: library }) => `<option value="${library.id}">${escapeHtml(directoryIndex.label(library.id))}</option>`).join('');
      const previous = $('#cardLibrary').value;
      $('#cardLibrary').innerHTML = `<option value="">不关联</option>${options}`;
      $('#cardLibrary').value = state.read().knowledgeBases.some(library => library.id === previous) ? previous : '';
      $('#cardLibrary').dispatchEvent(new Event('change', { bubbles: true }));
    }

    function openCardDialog(card = null, preset = {}) {
      const sourceItemId = preset.sourceItemId || card?.knowledgeItemId || '';
      const sourceItem = state.knowledge.itemById(sourceItemId);
      const sourceDocumentId = preset.sourceDocumentId || sourceItem?.documentId || '';
      sourceQuote = preset.sourceQuote || preset.answer || sourceItem?.source?.quote || sourceItem?.backText || '';
      sourceQuotePlainText = Boolean(preset.sourceQuotePlainText);
      // 制卡标记：新卡片记下来自笔记的哪一段。
      sourceAnchor = card ? null : preset.sourceAnchor || null;
      const sourceTitle = preset.sourceTitle || documentById(sourceDocumentId)?.title || '';
      $('#cardForm').reset(); $('#editingCardId').value = card?.id || ''; $('#sourceItemId').value = sourceItemId; $('#sourceDocumentId').value = sourceDocumentId;
      $('#question').value = card?.question || preset.question || ''; $('#answer').value = card?.answer || preset.answer || '';
      $('#cardTags').value = (card?.tags || preset.tags || []).join(', '); fillLibrarySelects(); $('#cardLibrary').value = card ? card.knowledgeBaseId || '' : preset.knowledgeBaseId || readLibraryId() || '';
      $('#cardNotebookSelect').innerHTML = cardNotebookOptions();
      $('#cardNotebookSelect').value = card && Object.prototype.hasOwnProperty.call(card,'cardFolderId') ? (card.cardFolderId ? `folder:${card.cardFolderId}` : '') : card ? card.cardNotebookId || '' : runtime.cardScope.type === 'notebook' ? runtime.cardScope.id : state.read().cardNotebooks.find(note => note.sourceDocumentId === sourceDocumentId)?.id || '';
      $('#cardDialogTitle').textContent = card ? '编辑卡片' : '新建卡片';
      const sourceDocument = documentById(sourceDocumentId);
      const sourcePreview = document.createElement('div');
      sourcePreview.innerHTML = sourceDocument?.metadata?.editorMode === 'note' && sourceDocument.metadata.noteContentInitialized
        ? sanitizeRichNoteContent(sourceDocument.metadata.noteContent || '') : renderMarkdown(sourceDocument?.content || '');
      editorComponent.mount().reset({ editing: Boolean(card), card: card || { cardType: preset.cardType, imageOcclusion: preset.imageOcclusion }, sourceTitle, sourceText: sourcePreview.textContent.trim(), hasSource: Boolean(sourceItemId || sourceDocumentId) });
      $('#cardDialog').showModal();
      setTimer(() => ($('#questionEditor') || $('#question')).focus(), 0);
    }

    async function handleSaveCard(event) {
      event.preventDefault();
      const editor = editorComponent.mount();
      if (editor.saving || !editor.validate()) return;
      let previousCard;
      editor.setSaving(true);
      try {
        const cardId = $('#editingCardId').value;
        const tags = $('#cardTags').value
          .split(/[,，]/)
          .map(value => value.trim())
          .filter(Boolean);
        const format = editor.format?.() || { cardType: 'qa' };
        const createReverse = Boolean(format.createReverse); delete format.createReverse;
        const fields = {
          ...format,
          question: $('#question').value.trim(),
          answer: $('#answer').value.trim(),
          tags,
          knowledgeBaseId: $('#cardLibrary').value || null,
          ...cardDestination($('#cardNotebookSelect').value)
        };
        const sourceId = $('#sourceItemId').value || null, documentId = $('#sourceDocumentId').value;
        await transact(candidate => {
          const existingCard = candidate.cards.find(card => card.id === cardId);
          if (cardId && !existingCard) throw new Error('卡片已不存在');
          previousCard = existingCard && structuredClone(existingCard);
          if (fields.cardFolderId && !candidate.cardFolders.some(folder=>folder.id===fields.cardFolderId)) throw new Error('目录已不存在，请重新选择');
          if (fields.cardFolderId && candidate.cards.some(card=>card.id!==cardId && cardFolderId(card)===fields.cardFolderId && samePrompt(card,fields))) throw new Error('这个目录中已存在相同题目');
          if (fields.cardNotebookId && candidate.cards.some(card => card.id !== cardId && card.cardNotebookId === fields.cardNotebookId && samePrompt(card, fields))) {
            editor.error('题目已存在，请修改后保存。');
            $('#cardEditTab').click();
            $('#question').setAttribute('aria-invalid', 'true');
            throw new Error('这本卡片笔记中已存在相同题目');
          }
          let sourceItemId = sourceId;

          if (!existingCard && !sourceItemId && documentId) {
            const sourceDocument = [...candidate.documents, ...candidate.cardDocuments].find(doc => doc.id === documentId);
            const timestamp = new Date().toISOString();
            const sourceItem = {
              id: uid(), knowledgeBaseId: fields.knowledgeBaseId || sourceDocument?.knowledgeBaseId || null,
              documentId: sourceDocument?.id || null, itemType: 'selection-card', frontText: fields.question, backText: fields.answer,
              example: '', note: '', tags, sourceLocation: { type: 'text-selection' }, createdAt: timestamp, updatedAt: timestamp
            };
            helpers.captureCardSource?.(candidate, sourceItem, { quote: sourceQuote || fields.answer, plainText: sourceQuotePlainText });
            candidate.items.push(sourceItem);
            sourceItemId = sourceItem.id;
          }

          if (existingCard) {
            if (!Object.prototype.hasOwnProperty.call(fields,'cardFolderId')) delete existingCard.cardFolderId;
            if (fields.cardType !== 'image-occlusion') delete existingCard.imageOcclusion;
            Object.assign(existingCard, fields, { updatedAt: new Date().toISOString() });
          } else {
            const created = createCard({ ...fields, knowledgeItemId: sourceItemId });
            Object.assign(created, format);
            const linkedSource = candidate.items.find(item => item.id === sourceItemId)?.source; if (linkedSource) created.source = structuredClone(linkedSource);
            if (sourceAnchor) created.sourceAnchor = structuredClone(sourceAnchor);
            candidate.cards.unshift(created);
          }
          if (createReverse) {
            const original = existingCard || candidate.cards[0];
            if (candidate.cards.some(card => card.id !== original.id && card.reverseOf === original.id)) throw new Error('这张卡片已有反向卡，请编辑已有反向卡');
            if (candidate.cards.some(card => card.id !== original.id && card.question.trim() === fields.answer && ((fields.cardFolderId && cardFolderId(card) === fields.cardFolderId) || fields.cardNotebookId && card.cardNotebookId === fields.cardNotebookId))) throw new Error('目标位置已存在与反向题目相同的卡片');
            candidate.cards.unshift(Object.assign(createCard({ ...fields, question: fields.answer, answer: fields.question, knowledgeItemId: sourceItemId }), original.sourceAnchor ? { sourceAnchor: structuredClone(original.sourceAnchor) } : {}, { cardType: 'qa', reverseOf: original.id, ...(original.source ? { source: structuredClone(original.source) } : {}) }));
          }

        });
        editor.markSaved();
        if (previousCard) {
          const previous = previousCard;
          const images = [...imageIds(previous?.question), ...imageIds(previous?.answer)];
          // Cleanup only after persistence; shared notes, cards and trash protect their references.
          deleteUnreferencedNoteImageFiles(images).catch(() => {});
        }
      } catch (error) {
        editor.error(`保存失败：${error.message || '请稍后重试'}。内容已保留。`);
        return;
      } finally { editor.setSaving(false); }
      $('#cardDialog').close();
      renderAll();
      showToast('记忆卡片已保存');
    }
    return { fillLibrarySelects, openCardDialog, handleSaveCard };
  }
  const api = { createCardEditor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepViews ||= {}, api);
})(globalThis);
