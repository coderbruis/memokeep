(function expose(root) {
  function createEditorTables({ state, config, actions, env, session, features }) {
    const closeTablePicker = () => {
      session.tablePicker.classList.add('hidden');
      session.tableButton.setAttribute('aria-expanded', 'false');
    };

    const positionTablePicker = () => {
      const buttonRect = session.tableButton.getBoundingClientRect();
      const pickerWidth = session.tablePicker.offsetWidth || 232;
      session.tablePicker.style.top = `${Math.round(buttonRect.bottom + 6)}px`;
      session.tablePicker.style.left = `${Math.round(Math.max(12, Math.min(env.window.innerWidth - pickerWidth - 12, buttonRect.right - pickerWidth)))}px`;
    };

    const getTableSelection = range => {
      if (!range || !session.tableModule?.getTable) return null;
      try {
        const [, , cell] = session.tableModule.getTable(range);
        return cell ? { index: range.index, length: 0 } : null;
      } catch {
        return null;
      }
    };

    const getTableSelectionFromCell = cell => {
      if (!cell || !session.richEditor) return null;
      const blot = env.window.Quill.find(cell);
      if (!blot) return null;
      const cellIndex = session.richEditor.getIndex(blot);
      return features.getTableSelection({ index: cellIndex, length: 0 })
      || features.getTableSelection({ index: Math.min(cellIndex + 1, session.richEditor.getLength() - 1), length: 0 });
    };

    const getTableCellRange = cell => {
      if (!cell || !session.richEditor) return null;
      const blot = env.window.Quill.find(cell);
      if (!blot) return null;
      return {
        index: session.richEditor.getIndex(blot),
        length: Math.max(0, blot.length() - 1)
      };
    };

    const clearTableAxisSelection = () => {
      session.selectedTableAxis?.table?.classList.remove('has-table-axis-selection');
      session.selectedTableCells.forEach(cell => cell.classList.remove('is-table-axis-selected'));
      session.tableFloatingTools.querySelectorAll('.note-table-axis-rail, .note-table-select-all-button').forEach(button => button.classList.remove('is-axis-active'));
      session.tableFloatingTools.querySelectorAll('.note-table-selection-action').forEach(button => button.classList.remove('is-visible'));
      session.selectedTableCells = [];
      session.selectedTableAxis = null;
    };

    const selectEntireTable = table => {
      features.clearTableAxisSelection();
      if (!table) return;
      session.selectedTableCells = [...table.querySelectorAll('td')];
      if (!session.selectedTableCells.length) return;
      session.selectedTableAxis = { table, axis: 'table', index: 0 };
      session.selectedTableCells.forEach(cell => cell.classList.add('is-table-axis-selected'));
      table.classList.add('has-table-axis-selection');
      session.tableFloatingTools.querySelector('[data-table-floating-action="selectTable"]')?.classList.add('is-visible', 'is-axis-active');
      session.tableFloatingTools.querySelectorAll('[data-table-floating-action="copySelectedTable"], [data-table-floating-action="deleteSelectedTable"], [data-table-floating-action="fitTableWidth"]')
      .forEach(button => button.classList.add('is-visible'));
      const firstRange = features.getTableCellRange(session.selectedTableCells[0]);
      if (firstRange) session.richEditor.setSelection(firstRange.index, 0, 'silent');
    };

    const selectTableAxis = (table, axis) => {
      features.clearTableAxisSelection();
      if (!table) return;
      session.selectedTableCells = axis === 'row'
      ? [...(table.rows[session.activeTableRowIndex]?.cells || [])]
      : [...table.rows].map(row => row.cells[session.activeTableColumnIndex]).filter(Boolean);
      if (!session.selectedTableCells.length) return;
      session.selectedTableAxis = { table, axis, index: axis === 'row' ? session.activeTableRowIndex : session.activeTableColumnIndex };
      session.selectedTableCells.forEach(cell => cell.classList.add('is-table-axis-selected'));
      table.classList.add('has-table-axis-selection');
      const selectedHandle = session.tableFloatingTools.querySelector(`[data-table-floating-action="select${axis === 'row' ? 'Row' : 'Column'}"]`);
      selectedHandle?.classList.add('is-visible', 'is-axis-active');
      const firstRange = features.getTableCellRange(session.selectedTableCells[0]);
      if (firstRange) session.richEditor.setSelection(firstRange.index, 0, 'silent');
    };

    const selectedTableAxisClipboard = () => {
      if (!session.selectedTableAxis?.table || !session.selectedTableCells.length) return null;
      const { table, axis, index } = session.selectedTableAxis;
      const plainText = axis === 'table'
      ? [...table.rows].map(row => [...row.cells].map(cell => cell.innerText.replace(/\s+/g, ' ').trim()).join('\t')).join('\n')
      : axis === 'row'
      ? session.selectedTableCells.map(cell => cell.innerText.replace(/\s+/g, ' ').trim()).join('\t')
      : session.selectedTableCells.map(cell => cell.innerText.replace(/\s+/g, ' ').trim()).join('\n');
      const copiedTable = table.cloneNode(true);
      copiedTable.classList.remove('has-table-axis-selection', 'is-copy-selected');
      copiedTable.querySelectorAll('.is-table-axis-selected').forEach(cell => cell.classList.remove('is-table-axis-selected'));
      if (axis === 'row') {
        [...copiedTable.rows].forEach((row, rowIndex) => {
          if (rowIndex !== index) row.remove();
        });
      } else if (axis === 'column') {
        [...copiedTable.rows].forEach(row => {
          [...row.cells].forEach((cell, columnIndex) => {
            if (columnIndex !== index) cell.remove();
          });
        });
      }
      return { plainText, html: copiedTable.outerHTML, axis };
    };

    const copySelectedTableAxis = event => {
      const copied = features.selectedTableAxisClipboard();
      if (!copied || !event.clipboardData) return false;
      event.preventDefault();
      event.clipboardData.setData('text/plain', copied.plainText);
      event.clipboardData.setData('text/html', copied.html);
      actions.showToast(copied.axis === 'table' ? '表格已复制' : `已复制选中的${copied.axis === 'row' ? '行' : '列'}`);
      return true;
    };

    const applySelectedTableFormat = (format, requestedValue) => {
      const ranges = session.selectedTableCells.map(features.getTableCellRange).filter(Boolean);
      if (!ranges.length) return;
      const lineFormats = new Set(['header', 'list', 'blockquote', 'code-block', 'align', 'direction', 'indent']);
      const clearFormats = ['bold', 'italic', 'underline', 'strike', 'color', 'background', 'link', 'code'];
      const clearLineFormats = ['header', 'list', 'blockquote', 'code-block', 'align', 'direction', 'indent'];

      if (format === 'clean') {
        ranges.forEach(range => {
          clearFormats.forEach(name => session.richEditor.formatText(range.index, range.length, name, false, 'user'));
          clearLineFormats.forEach(name => session.richEditor.formatLine(range.index, 1, name, false, 'user'));
        });
      } else {
        let value = requestedValue;
        if (value === undefined) {
          const allEnabled = ranges.every(range => Boolean(session.richEditor.getFormat(range.index, Math.max(1, range.length))[format]));
          value = !allEnabled;
        } else {
          const allMatched = ranges.every(range => session.richEditor.getFormat(range.index, Math.max(1, range.length))[format] === value);
          if (allMatched) value = false;
        }
        ranges.forEach(range => {
          if (lineFormats.has(format)) session.richEditor.formatLine(range.index, 1, format, value, 'user');
          else session.richEditor.formatText(range.index, range.length, format, value, 'user');
        });
      }
      const firstRange = ranges[0];
      session.richEditor.setSelection(firstRange.index, 0, 'silent');
      features.markNoteChanged();
    };

    const resolveTableSelection = () => {
      if (!session.richEditor || !session.tableModule) return null;
      const currentRange = session.richEditor.getSelection();
      const currentTableSelection = features.getTableSelection(currentRange);
      if (currentTableSelection) {
        session.lastTableSelection = currentTableSelection;
        return currentTableSelection;
      }
      const rememberedTableSelection = features.getTableSelection(session.lastTableSelection);
      if (rememberedTableSelection) return rememberedTableSelection;

      const anchorIndex = currentRange?.index ?? session.richEditor.getLength() - 1;
      const tableSelections = [...session.richEditor.root.querySelectorAll('td')]
      .map(features.getTableSelectionFromCell)
      .filter(Boolean);
      if (!tableSelections.length) {
        session.lastTableSelection = null;
        return null;
      }
      session.lastTableSelection = tableSelections
      .filter(selection => selection.index <= anchorIndex)
      .at(-1) || tableSelections[0];
      return session.lastTableSelection;
    };

    const refreshTableEditActions = () => {
      session.tableEditActions.classList.toggle('hidden', !features.resolveTableSelection());
    };

    const positionTableFloatingTools = () => {
      if (!session.activeTableElement?.isConnected) {
        session.activeTableElement = null;
        session.tableFloatingTools.classList.add('hidden');
        return;
      }
      const columnRect = session.richEditorColumn.getBoundingClientRect();
      const tableRect = session.activeTableElement.getBoundingClientRect();
      session.tableFloatingTools.style.left = `${tableRect.left - columnRect.left}px`;
      session.tableFloatingTools.style.top = `${tableRect.top - columnRect.top}px`;
      session.tableFloatingTools.style.width = `${tableRect.width}px`;
      session.tableFloatingTools.style.height = `${tableRect.height}px`;
      const rows = session.activeTableElement.rows.length;
      const columns = Math.max(0, ...[...session.activeTableElement.rows].map(row => row.cells.length));
      const selectRowButton = session.tableFloatingTools.querySelector('[data-table-floating-action="selectRow"]');
      const selectColumnButton = session.tableFloatingTools.querySelector('[data-table-floating-action="selectColumn"]');
      const deleteRowButton = session.tableFloatingTools.querySelector('[data-table-floating-action="deleteRow"]');
      const deleteColumnButton = session.tableFloatingTools.querySelector('[data-table-floating-action="deleteColumn"]');
      deleteRowButton.disabled = rows <= 1;
      deleteColumnButton.disabled = columns <= 1;

      const activeRow = session.activeTableElement.rows[session.activeTableRowIndex];
      if (activeRow) {
        const rowRect = activeRow.getBoundingClientRect();
        const rowCenter = `${rowRect.top - tableRect.top + rowRect.height / 2}px`;
        selectRowButton.style.top = `${rowRect.top - tableRect.top}px`;
        selectRowButton.style.height = `${rowRect.height}px`;
        deleteRowButton.style.top = rowCenter;
      }
      const activeColumnCell = session.activeTableElement.rows[0]?.cells[session.activeTableColumnIndex];
      if (activeColumnCell) {
        const columnRect = activeColumnCell.getBoundingClientRect();
        const columnCenter = `${columnRect.left - tableRect.left + columnRect.width / 2}px`;
        selectColumnButton.style.left = `${columnRect.left - tableRect.left}px`;
        selectColumnButton.style.width = `${columnRect.width}px`;
        deleteColumnButton.style.left = columnCenter;
      }
    };

    const showTableFloatingTools = table => {
      env.clearTimeout(session.tableToolsHideTimer);
      session.activeTableElement = table;
      session.tableFloatingTools.classList.remove('hidden');
      features.positionTableFloatingTools();
    };

    const scheduleHideTableFloatingTools = () => {
      env.clearTimeout(session.tableToolsHideTimer);
      const delay = Math.max(140, session.tableToolsInteractionUntil - Date.now());
      session.tableToolsHideTimer = env.setTimeout(() => {
        if (Date.now() < session.tableToolsInteractionUntil) {
          features.scheduleHideTableFloatingTools();
          return;
        }
        session.tableFloatingTools.querySelectorAll('button').forEach(button => button.classList.remove('is-visible'));
        if (session.selectedTableAxis?.table?.isConnected) {
          session.activeTableElement = session.selectedTableAxis.table;
          if (session.selectedTableAxis.axis === 'row') session.activeTableRowIndex = session.selectedTableAxis.index;
          else if (session.selectedTableAxis.axis === 'column') session.activeTableColumnIndex = session.selectedTableAxis.index;
          session.tableFloatingTools.classList.remove('hidden');
          const selectedAction = session.selectedTableAxis.axis === 'table'
          ? 'selectTable'
          : `select${session.selectedTableAxis.axis === 'row' ? 'Row' : 'Column'}`;
          const selectedHandle = session.tableFloatingTools.querySelector(`[data-table-floating-action="${selectedAction}"]`);
          selectedHandle?.classList.add('is-visible', 'is-axis-active');
          if (session.selectedTableAxis.axis === 'table') {
            session.tableFloatingTools.querySelectorAll('[data-table-floating-action="copySelectedTable"], [data-table-floating-action="deleteSelectedTable"], [data-table-floating-action="fitTableWidth"]')
            .forEach(button => button.classList.add('is-visible'));
          }
          features.positionTableFloatingTools();
        } else {
          session.tableFloatingTools.classList.add('hidden');
        }
      }, delay);
    };

    const updateTableFloatingTools = event => {
      const table = event.target.closest('table');
      const cell = event.target.closest('td');
      if (!table || !cell) return;
      const tableRect = table.getBoundingClientRect();
      const edgeDistance = 20;
      const nearTop = event.clientY - tableRect.top <= edgeDistance;
      const nearRight = tableRect.right - event.clientX <= edgeDistance;
      const nearBottom = tableRect.bottom - event.clientY <= edgeDistance;
      const nearLeft = event.clientX - tableRect.left <= edgeDistance;
      session.activeTableRowIndex = [...table.rows].indexOf(cell.parentElement);
      session.activeTableColumnIndex = [...cell.parentElement.cells].indexOf(cell);
      const previewRowHandle = nearLeft && !nearTop;
      const previewColumnHandle = nearTop && !nearLeft;
      if (session.selectedTableAxis?.table === table) {
        if (session.selectedTableAxis.axis === 'row' && !previewRowHandle) session.activeTableRowIndex = session.selectedTableAxis.index;
        if (session.selectedTableAxis.axis === 'column' && !previewColumnHandle) session.activeTableColumnIndex = session.selectedTableAxis.index;
      }
      features.showTableFloatingTools(table);

      const deleteRowButton = session.tableFloatingTools.querySelector('[data-table-floating-action="deleteRow"]');
      const deleteColumnButton = session.tableFloatingTools.querySelector('[data-table-floating-action="deleteColumn"]');
      const selectRowButton = session.tableFloatingTools.querySelector('[data-table-floating-action="selectRow"]');
      const selectColumnButton = session.tableFloatingTools.querySelector('[data-table-floating-action="selectColumn"]');
      deleteRowButton.setAttribute('aria-label', `删除第 ${session.activeTableRowIndex + 1} 行`);
      deleteRowButton.title = `删除第 ${session.activeTableRowIndex + 1} 行`;
      deleteColumnButton.setAttribute('aria-label', `删除第 ${session.activeTableColumnIndex + 1} 列`);
      deleteColumnButton.title = `删除第 ${session.activeTableColumnIndex + 1} 列`;
      selectRowButton.setAttribute('aria-label', `选中第 ${session.activeTableRowIndex + 1} 行`);
      selectRowButton.title = `选中第 ${session.activeTableRowIndex + 1} 行`;
      selectColumnButton.setAttribute('aria-label', `选中第 ${session.activeTableColumnIndex + 1} 列`);
      selectColumnButton.title = `选中第 ${session.activeTableColumnIndex + 1} 列`;

      const atTopLeftCorner = nearTop && nearLeft;
      const wholeTableSelected = session.selectedTableAxis?.table === table && session.selectedTableAxis.axis === 'table';
      const visibility = {
        selectTable: atTopLeftCorner || wholeTableSelected,
        copySelectedTable: wholeTableSelected,
        fitTableWidth: wholeTableSelected && env.MemoKeepFeatures.some(feature => feature.id === 'editor.enhance'),
        deleteSelectedTable: wholeTableSelected,
        insertColumnRight: !wholeTableSelected && nearRight,
        insertRowBelow: !wholeTableSelected && nearBottom,
        selectColumn: !wholeTableSelected && (previewColumnHandle || (session.selectedTableAxis?.table === table && session.selectedTableAxis.axis === 'column')),
        selectRow: !wholeTableSelected && (previewRowHandle || (session.selectedTableAxis?.table === table && session.selectedTableAxis.axis === 'row')),
        deleteColumn: !wholeTableSelected && nearTop && !nearLeft && table.rows[0].cells.length > 1,
        deleteRow: !wholeTableSelected && nearLeft && !nearTop && table.rows.length > 1
      };
      session.tableFloatingTools.querySelectorAll('[data-table-floating-action]').forEach(button => {
        button.classList.toggle('is-visible', Boolean(visibility[button.dataset.tableFloatingAction]));
        if (button.classList.contains('note-table-axis-rail')) {
          const axis = button.dataset.tableFloatingAction === 'selectRow' ? 'row' : 'column';
          button.classList.toggle('is-axis-active', session.selectedTableAxis?.table === table && session.selectedTableAxis.axis === axis && session.selectedTableAxis.index === (axis === 'row' ? session.activeTableRowIndex : session.activeTableColumnIndex));
        }
        if (button.classList.contains('note-table-select-all-button')) {
          button.classList.toggle('is-axis-active', wholeTableSelected);
        }
      });
      session.tableFloatingTools.classList.toggle('hidden', !Object.values(visibility).some(Boolean) && !session.selectedTableCells.length);
      features.positionTableFloatingTools();
    };

    const copyRichTable = async table => {
      if (!table) return;
      const plainText = [...table.rows]
      .map(row => [...row.cells].map(cell => cell.innerText.replace(/\s+/g, ' ').trim()).join('\t'))
      .join('\n');
      const tableHtml = table.outerHTML;
      table.classList.add('is-copy-selected');
      env.setTimeout(() => table.classList.remove('is-copy-selected'), 700);
      try {
        if (!env.navigator.clipboard?.write || typeof env.window.ClipboardItem !== 'function') throw new Error('rich clipboard unavailable');
        await env.navigator.clipboard.write([new env.window.ClipboardItem({
            'text/html': new env.Blob([tableHtml], { type: 'text/html' }),
            'text/plain': new env.Blob([plainText], { type: 'text/plain' })
          })]);
        actions.showToast('表格已复制');
      } catch {
        await actions.copyTextToClipboard(plainText || ' ', '表格已复制');
      }
    };

    const runFloatingTableAction = action => {
      const table = session.activeTableElement;
      const tableSelection = features.tableEdgeSelection(table, action);
      if (!tableSelection || typeof session.tableModule?.[action] !== 'function') return;
      session.tableToolsInteractionUntil = Date.now() + 650;
      session.richEditor.setSelection(tableSelection.index, 0, 'silent');
      session.tableModule[action]();
      if (action === 'deleteRow' || action === 'deleteColumn' || action === 'deleteTable') features.clearTableAxisSelection();
      session.lastTableSelection = session.richEditor.getSelection() || tableSelection;
      env.window.requestAnimationFrame(() => {
        if (table?.isConnected) features.showTableFloatingTools(table);
        else session.tableFloatingTools.classList.add('hidden');
      });
      features.markNoteChanged();
    };

    const selectedTableButtonFormat = button => {
      if (button.classList.contains('ql-clean')) return { format: 'clean' };
      const formats = ['bold', 'italic', 'underline', 'strike', 'blockquote', 'code-block', 'list'];
      const format = formats.find(name => button.classList.contains(`ql-${name}`));
      if (!format) return null;
      return { format, value: format === 'list' ? button.value : undefined };
    };

    const handleSelectedTableToolbarClick = event => {
      if (!session.selectedTableCells.length) return;
      const button = event.target.closest('button');
      if (!button) return;
      const requestedFormat = features.selectedTableButtonFormat(button);
      if (!requestedFormat) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      features.applySelectedTableFormat(requestedFormat.format, requestedFormat.value);
    };

    const handleSelectedTableToolbarChange = event => {
      if (!session.selectedTableCells.length) return;
      const select = event.target.closest('select');
      if (!select) return;
      const format = ['header', 'color', 'background', 'align'].find(name => select.classList.contains(`ql-${name}`));
      if (!format) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      features.applySelectedTableFormat(format, select.value || false);
      env.window.requestAnimationFrame(features.refreshAlignmentTooltips);
    };

    const refreshAlignmentTooltips = () => {
      const picker = session.richToolbar.querySelector('.ql-picker.ql-align');
      if (!picker) return;
      const label = picker.querySelector('.ql-picker-label');
      const currentLabel = session.alignmentLabels[label?.dataset.value || ''] || '段落对齐';
      if (label) {
        label.title = currentLabel;
        label.setAttribute('aria-label', currentLabel);
      }
      picker.querySelectorAll('.ql-picker-item').forEach(item => {
        const itemLabel = session.alignmentLabels[item.dataset.value || ''] || '左对齐';
        item.title = itemLabel;
        item.setAttribute('aria-label', itemLabel);
      });
    };

    const handleAlignmentTooltipRefresh = () => {
      env.window.requestAnimationFrame(features.refreshAlignmentTooltips);
    };

    const handleTablePickerOutsideClick = event => {
      if (!event.target.closest('#noteTablePicker') && !event.target.closest('#insertNoteTableButton')) features.closeTablePicker();
    };
    return { closeTablePicker, positionTablePicker, getTableSelection, getTableSelectionFromCell, getTableCellRange, clearTableAxisSelection, selectEntireTable, selectTableAxis, selectedTableAxisClipboard, copySelectedTableAxis, applySelectedTableFormat, resolveTableSelection, refreshTableEditActions, positionTableFloatingTools, showTableFloatingTools, scheduleHideTableFloatingTools, updateTableFloatingTools, copyRichTable, runFloatingTableAction, selectedTableButtonFormat, handleSelectedTableToolbarClick, handleSelectedTableToolbarChange, refreshAlignmentTooltips, handleAlignmentTooltipRefresh, handleTablePickerOutsideClick };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createEditorTables });
})(globalThis);
