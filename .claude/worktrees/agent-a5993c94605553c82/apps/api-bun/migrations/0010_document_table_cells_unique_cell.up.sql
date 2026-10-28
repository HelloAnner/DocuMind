SET search_path TO documind, public;

DELETE FROM document_table_cells a
USING document_table_cells b
WHERE a.table_id = b.table_id
  AND a.row_index = b.row_index
  AND a.col_index = b.col_index
  AND a.ctid < b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_table_cells_unique_cell
    ON document_table_cells(table_id, row_index, col_index);
