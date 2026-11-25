// A migration may move document content (SCHEMA_HOME): silent.
export const up = 'UPDATE family_documents SET storage_backend = \'local\', storage_key = NULL WHERE storage_key = \'\'';
