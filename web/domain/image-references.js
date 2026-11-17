(function expose(root) {
  function noteImageIdsFromContent(content = '') {
    return [...String(content).matchAll(/memokeep-image:\/\/([0-9a-f-]{36})/gi)]
      .map(match => match[1].toLowerCase());
  }

  function cardImageIds(card) {
    return [card?.question, card?.answer, card?.imageOcclusion?.reference].flatMap(noteImageIdsFromContent);
  }

  function trashEntryImageIds(entry) {
    const document = entry.document;
    return [
      ...noteImageIdsFromContent(document?.content),
      ...noteImageIdsFromContent(document?.metadata?.noteContent),
      ...(document?.metadata?.versions || []).flatMap(version => [
        ...noteImageIdsFromContent(version.content), ...noteImageIdsFromContent(version.noteContent)
      ]),
      ...[...(entry.cards || []), ...(entry.card ? [entry.card] : [])].flatMap(cardImageIds)
    ];
  }

  function dataImageIds(data) {
    return [
      ...[...(data.documents || []), ...(data.cardDocuments || [])].flatMap(document => [
        ...noteImageIdsFromContent(document.content), ...noteImageIdsFromContent(document.metadata?.noteContent),
        ...(document.metadata?.versions || []).flatMap(version => [
          ...noteImageIdsFromContent(version.content), ...noteImageIdsFromContent(version.noteContent)
        ])
      ]),
      ...(data.memos || []).flatMap(memo => noteImageIdsFromContent(memo.notes)),
      ...(data.cards || []).flatMap(cardImageIds),
      ...(data.cardCandidates || []).flatMap(cardImageIds),
      ...(data.sourceChanges || []).flatMap(change => [...noteImageIdsFromContent(change.oldAnswer), ...noteImageIdsFromContent(change.newAnswer)]),
      ...(data.trash || []).flatMap(trashEntryImageIds)
    ];
  }

  const api = { noteImageIdsFromContent, trashEntryImageIds, dataImageIds };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root.MemoKeepDomain ||= {}, api);
})(globalThis);
