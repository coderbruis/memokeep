// Widths live on cell newline formats so a resize is a single undoable edit.
function noteTableCellWidth(value) {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(String(value || ''));
  return match && Number(match[1]) >= 72 && Number(match[1]) <= 10000 ? Number(match[1]) : 0;
}

function registerNoteTableWidths(Quill, registry) {
  const { StyleAttributor, Scope } = Quill.import('parchment');
  const TableCell = Quill.import('formats/table');
  class NoteTableCell extends TableCell {
    formats() {
      const formats = super.formats();
      // Undo must recreate the TD before applying attributes restricted to table cells.
      return { table: formats.table, ...formats };
    }
  }
  class CellWidth extends StyleAttributor {
    canAdd(node, value) {
      return node.tagName === 'TD' && Boolean(noteTableCellWidth(value)) && super.canAdd(node, value);
    }
  }
  registry.register(NoteTableCell, new CellWidth('tableCellWidth', 'width', { scope: Scope.BLOCK_ATTRIBUTE }));
}

function noteTableWidths(table) {
  const rows = [...table.rows];
  const count = Math.max(0, ...rows.map(row => row.cells.length));
  const widths = Array.from({ length: count }, (_, index) => {
    return rows.map(row => noteTableCellWidth(row.cells[index]?.style.width)).find(Boolean) || 0;
  });
  if (!widths.some(Boolean)) return null;
  const average = widths.reduce((sum, width) => sum + width, 0) / widths.filter(Boolean).length;
  return widths.map(width => width || average);
}

// Also normalize newly inserted cells in the serialized HTML and read-only preview.
function serializeNoteTableWidths(root) {
  root.querySelectorAll('table').forEach(table => {
    const widths = noteTableWidths(table);
    if (!widths) return;
    table.style.width = `${widths.reduce((sum, width) => sum + width, 0) + 2}px`;
    table.style.maxWidth = '100%';
    table.style.tableLayout = 'fixed';
    [...table.rows].forEach(row => [...row.cells].forEach((cell, index) => {
      cell.style.width = `${widths[index]}px`;
    }));
  });
}


function registerNoteTableClipboard(quill) {
  // Quill must create the TD before applying a TD-only width to the first cell.
  quill.clipboard.addMatcher('TD', (node, delta) => {
    const width = noteTableCellWidth(node.style.width);
    if (!width) return delta;
    delta.ops.forEach(op => {
      if (!op.attributes?.table) return;
      delete op.attributes.tableCellWidth;
      op.attributes.tableCellWidth = `${width}px`;
    });
    return delta;
  });
}
