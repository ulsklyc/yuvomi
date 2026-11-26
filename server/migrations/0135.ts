export default {
    version: 135,
    description: 'API integration tokens may act as an explicitly selected family member',
    up: `
      -- The creator remains the administrator responsible for the credential;
      -- the subject is the family member whose permissions and ownership apply
      -- to requests made with it. Existing tokens keep their current behaviour.
      ALTER TABLE api_tokens
        ADD COLUMN subject_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
      UPDATE api_tokens SET subject_user_id = created_by WHERE subject_user_id IS NULL;
      CREATE INDEX idx_api_tokens_subject_user_id ON api_tokens(subject_user_id);
    `,
  };
