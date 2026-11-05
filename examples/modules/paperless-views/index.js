/** Optional separate navigation page; requires the core extension's API. */
import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { mayWritePath } from '/utils/module-access.js';
import { mountPaperlessFolders } from '/components/paperless-folders.js';

export async function render(container, { signal } = {}) {
  const result = await api.get('/documents/meta/options', { signal });
  if (signal?.aborted) return;
  container.classList.add('documents-page');
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
      <div class="page-toolbar"><h1 class="page-toolbar__title">${esc(t('documents.paperless.title'))}</h1></div>
      <div class="documents-browser-layout">
        <aside class="documents-folder-browser documents-folder-browser--open" id="pl-module-sidebar"></aside>
        <div class="documents-browser-main"><p class="form-hint">${esc(t('documents.paperless.readOnly'))}</p><section class="paperless-folder" id="pl-module-content" hidden></section></div>
      </div>
    `);
  await mountPaperlessFolders({
    sidebar: container.querySelector('#pl-module-sidebar'),
    content: container.querySelector('#pl-module-content'),
    accounts: (result.data?.dms_accounts || []).filter((a) => a.provider === 'paperless'),
    canManage: result.data?.is_admin === true && mayWritePath('/documents'), signal,
  });
}
