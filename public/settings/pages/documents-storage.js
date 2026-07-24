import { api } from "/api.js";
import { formatDate, formatTime, t } from "/i18n.js";
import { confirmModal } from "/components/modal.js";
import {
  createDisclosure,
  createInfoList,
  createRetryState,
  createSettingRow,
  createStatusSummary
} from "/settings/components.js";

function formatSyncTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${formatDate(date)} ${formatTime(date)}`.trim();
}

function showToast(message, tone = "default") {
  window.yuvomi?.showToast(message, tone);
}

function documentStorageTarget(data) {
  if (data.effective_target) return data.effective_target;
  if (!data.url) return t("settings.documentStorageNotConfigured");
  const basePath = data.base_path ?? data.basePath ?? "";
  return basePath ? `${data.url.replace(/\/+$/, "")}/${String(basePath).replace(/^\/+/, "")}` : data.url;
}

function backendLabel(activeBackend) {
  if (activeBackend === "webdav") return t("documents.storageWebdav");
  if (activeBackend === "google_drive") return t("documents.storageGoogleDrive");
  if (activeBackend === "local_folder") return t("documents.storageLocalFolder");
  return t("documents.storageLocal");
}

function buildStatusSummary(data) {
  const selectedBackend = data.selected_upload_backend ?? (data.enabled ? "webdav" : "local");
  const activeBackend = data.active_upload_backend ?? selectedBackend;
  const activeLabel = backendLabel(activeBackend);
  const lastTest = data.last_test ?? data.lastTest;
  const lastTestLabel = formatSyncTime(lastTest) ?? t("settings.documentStorageNeverTested");
  const lastError = data.last_error ?? data.lastError;

  // The status line is the concrete destination: a folder path, a WebDAV URL,
  // or the database for the in-DB default.
  const statusLine =
    activeBackend === "local_folder"
      ? data.local_path || data.effective_target || "/documents"
      : activeBackend === "webdav"
        ? documentStorageTarget(data)
        : activeBackend === "google_drive"
          ? data.google_drive?.folder_name || data.effective_target || t("settings.documentStorageNotConfigured")
          : t("settings.documentStorageDatabase");

  const details = [
    `${t("settings.documentStorageSelected")}: ${backendLabel(selectedBackend)}`,
    `${t("settings.documentStorageEffective")}: ${activeLabel}`
  ];
  if (activeBackend === "local_folder") {
    // Env-only backend: no in-app connection fields, so state that plainly.
    details.push(t("settings.documentStorageLocalEnvManaged"));
    if (selectedBackend !== activeBackend) details.push(t("settings.documentStorageOverride"));
  } else if (activeBackend === "webdav") {
    details.push(`${t("settings.documentStorageCount")}: ${Number(data.webdav_document_count ?? 0)}`);
    details.push(`${t("settings.documentStorageLastTest")}: ${lastTestLabel}`);
  } else if (activeBackend === "google_drive") {
    details.push(`${t("settings.documentStorageGoogleDriveCount")}: ${Number(data.google_drive?.document_count ?? 0)}`);
  }
  if (lastError) {
    details.push(`${t("settings.documentStorageLastError")}: ${lastError}`);
  }

  return createStatusSummary({
    title: activeLabel,
    status: statusLine,
    details,
    tone: lastError ? "warning" : "neutral"
  });
}

function buildConnectionForm() {
  const form = document.createElement("form");
  form.className = "settings-form settings-form--compact";
  form.id = "document-storage-form";
  form.noValidate = true;
  form.autocomplete = "off";
  form.insertAdjacentHTML(
    "beforeend",
    `
    <div class="settings-webdav-toggle-row">
      <label class="toggle-row">
        <input type="checkbox" id="document-storage-enabled" name="enabled" />
        <span>${t("settings.documentStorageEnabled")}</span>
      </label>
    </div>
    <div class="form-group">
      <label class="form-label" for="document-storage-url">${t("settings.documentStorageUrl")}</label>
      <input class="form-input" type="url" id="document-storage-url" name="url" placeholder="https://..." />
      <span class="form-hint" data-env-hint="url" hidden>${t("settings.documentStorageEnvHint")}</span>
    </div>
    <div class="form-group">
      <label class="form-label" for="document-storage-username">${t("settings.documentStorageUsername")}</label>
      <input class="form-input" type="text" id="document-storage-username" name="username" autocomplete="off" />
      <span class="form-hint" data-env-hint="username" hidden>${t("settings.documentStorageEnvHint")}</span>
    </div>
    <div class="form-group">
      <label class="form-label" for="document-storage-password">${t("settings.documentStoragePassword")}</label>
      <div class="settings-webdav-pw-wrap">
        <input class="form-input" type="password" id="document-storage-password" name="password"
          autocomplete="current-password" placeholder="${t("settings.documentStoragePasswordPlaceholder")}" />
        <button type="button" class="btn btn--icon btn--ghost settings-webdav-reveal-btn"
          data-reveal-target="document-storage-password" aria-label="${t("common.togglePasswordVisibility")}">
          <i data-lucide="eye" aria-hidden="true"></i>
        </button>
      </div>
      <span class="form-hint" data-env-hint="password" hidden>${t("settings.documentStorageEnvHint")}</span>
    </div>
    <div class="form-group">
      <label class="form-label" for="document-storage-path">${t("settings.documentStoragePath")}</label>
      <input class="form-input" type="text" id="document-storage-path" name="path" />
      <span class="form-hint" data-env-hint="path" hidden>${t("settings.documentStorageEnvHint")}</span>
    </div>
    <div class="form-hint" data-env-hint="enabled" hidden>${t("settings.documentStorageEnvHint")}</div>
    <p class="settings-document-storage-warning" id="document-storage-backup-warning" hidden>
      <i data-lucide="triangle-alert" aria-hidden="true"></i>
      <span>${t("settings.documentStorageBackupWarning")}</span>
    </p>
    <div id="document-storage-test-result" class="form-hint" hidden></div>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--secondary" id="document-storage-test-btn">
        <i data-lucide="plug-zap" aria-hidden="true"></i>
        ${t("settings.documentStorageTest")}
      </button>
      <button type="submit" class="btn btn--primary" id="document-storage-save-btn">
        ${t("settings.documentStorageSave")}
      </button>
    </div>
  `
  );
  return form;
}

function renderPage(container) {
  container.replaceChildren();
  container.insertAdjacentHTML(
    "beforeend",
    `
    <section class="settings-section">
      <h2 class="settings-section__title">${t("settings.documentStorageTitle")}</h2>
      <div class="settings-card" id="document-storage-card">
        <div id="document-storage-banner"></div>
        <p class="settings-card-description">${t("settings.documentStorageDescription")}</p>
        <div id="document-storage-status-host"></div>
        <div class="settings-providers" id="document-storage-providers-host"></div>
        <div id="document-storage-destination-host"></div>
      </div>
    </section>
  `
  );
}

function applyConfigToForm(form, data) {
  const envControlled = data.env_controlled ?? data.envControlled ?? {};
  const basePath = data.base_path ?? data.basePath ?? "";
  form._documentStorageConfig = {
    ...data,
    base_path: basePath,
    env_controlled: envControlled
  };

  form.querySelector("#document-storage-enabled").checked = Boolean(data.enabled);
  syncBackupWarning(Boolean(data.enabled));
  form.querySelector("#document-storage-url").value = data.url ?? "";
  form.querySelector("#document-storage-username").value = data.username ?? "";
  const passwordInput = form.querySelector("#document-storage-password");
  passwordInput.value = "";
  passwordInput.placeholder = data.password_configured ? "****" : t("settings.documentStoragePasswordPlaceholder");
  form.querySelector("#document-storage-path").value = basePath;

  const fieldIds = {
    enabled: "document-storage-enabled",
    url: "document-storage-url",
    username: "document-storage-username",
    password: "document-storage-password",
    path: "document-storage-path"
  };
  for (const [field, id] of Object.entries(fieldIds)) {
    const input = form.querySelector(`#${id}`);
    const controlled = Boolean(envControlled[field]);
    if (input) input.disabled = controlled;
    const hint = form.querySelector(`[data-env-hint="${field}"]`);
    if (hint) hint.hidden = !controlled;
  }
}

function documentStoragePayload(form) {
  const envControlled = form._documentStorageConfig?.env_controlled ?? {};
  const payload = {};
  if (!envControlled.enabled) {
    payload.enabled = form.querySelector("#document-storage-enabled")?.checked ?? false;
  }
  if (!envControlled.url) {
    payload.url = form.querySelector("#document-storage-url")?.value?.trim() ?? "";
  }
  if (!envControlled.username) {
    payload.username = form.querySelector("#document-storage-username")?.value?.trim() ?? "";
  }
  if (!envControlled.path) {
    payload.path = form.querySelector("#document-storage-path")?.value?.trim() ?? "";
  }
  const password = form.querySelector("#document-storage-password")?.value;
  if (!envControlled.password && password && password !== "****") payload.password = password;
  return payload;
}

function hasProtectedDocumentStorageChange(form, payload) {
  const current = form._documentStorageConfig ?? {};
  if (Number(current.webdav_document_count ?? 0) < 1) return false;
  const envControlled = current.env_controlled ?? {};
  if (Object.hasOwn(payload, "url") && payload.url !== (current.url ?? "")) return true;
  if (Object.hasOwn(payload, "username") && payload.username !== (current.username ?? "")) return true;
  if (Object.hasOwn(payload, "path") && payload.path !== (current.base_path ?? "")) return true;
  return !envControlled.password && Object.hasOwn(payload, "password");
}

// Die Backup-Warnung betrifft nur WebDAV-Ziele; bei "Lokal" ist sie falsch
// beunruhigend (Audit A2-25c). Sichtbarkeit folgt dem Aktiviert-Zustand.
function syncBackupWarning(enabled) {
  const warning = document.getElementById("document-storage-backup-warning");
  if (warning) warning.hidden = !enabled;
}

function bindConnectionForm(container, form, reload) {
  form.querySelector("#document-storage-enabled")?.addEventListener("change", (event) => {
    syncBackupWarning(event.currentTarget.checked);
  });

  form.querySelector("[data-reveal-target]")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    const input = form.querySelector(`#${button.dataset.revealTarget}`);
    if (!input) return;
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    const icon = button.querySelector("[data-lucide]");
    if (icon) icon.dataset.lucide = reveal ? "eye-off" : "eye";
    window.lucide?.createIcons({ el: button });
  });

  const testBtn = form.querySelector("#document-storage-test-btn");
  const result = form.querySelector("#document-storage-test-result");
  testBtn?.addEventListener("click", async () => {
    testBtn.disabled = true;
    if (result) {
      result.hidden = false;
      result.textContent = t("settings.documentStorageTesting");
      result.className = "form-hint";
    }
    try {
      await api.post("/documents/storage/test", documentStoragePayload(form));
      if (result) {
        result.textContent = t("settings.documentStorageTestSuccess");
        result.className = "form-hint settings-document-storage-success";
      }
      await reload();
    } catch (err) {
      if (result) {
        result.textContent = t("settings.documentStorageTestFailed", { error: err.message });
        result.className = "form-hint settings-document-storage-error";
      }
    } finally {
      testBtn.disabled = false;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saveBtn = form.querySelector("#document-storage-save-btn");
    const payload = documentStoragePayload(form);
    if (hasProtectedDocumentStorageChange(form, payload)) {
      const confirmed = await confirmModal(t("settings.documentStorageConfirmExisting"), {
        confirmLabel: t("common.confirm")
      });
      if (!confirmed) return;
      payload.confirm_existing_access = true;
    }
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = t("common.saving");
    }
    try {
      await api.put("/documents/storage/config", payload);
      showToast(t("settings.documentStorageSaved"), "success");
      await reload();
    } catch (err) {
      showToast(err.message ?? t("common.errorGeneric"), "danger");
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = t("settings.documentStorageSave");
      }
    }
  });
}

function buildDestinationForm(data, reload) {
  const form = document.createElement("form");
  form.className = "settings-form settings-form--compact";
  form.id = "document-storage-destination-form";

  const select = document.createElement("select");
  select.className = "form-input";
  select.id = "document-storage-destination";

  const availableBackends = new Set(["local"]);
  if (data.enabled && data.configured) availableBackends.add("webdav");
  const drive = data.google_drive ?? {};
  if (drive.configured && drive.connected) availableBackends.add("google_drive");

  for (const backend of ["local", "webdav", "google_drive"]) {
    const option = document.createElement("option");
    option.value = backend;
    option.textContent = backendLabel(backend);
    option.disabled = !availableBackends.has(backend);
    select.appendChild(option);
  }
  select.value = data.selected_upload_backend ?? (data.enabled ? "webdav" : "local");
  form.appendChild(
    createSettingRow({
      label: t("settings.documentStorageDestination"),
      description: t("settings.documentStorageDestinationHint"),
      control: select
    })
  );

  const actions = document.createElement("div");
  actions.className = "settings-form-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "btn btn--primary";
  save.textContent = t("common.save");
  actions.appendChild(save);
  form.appendChild(actions);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await api.put("/documents/storage/config", { selected_upload_backend: select.value });
      showToast(t("settings.documentStorageSaved"), "success");
      await reload();
    } catch (error) {
      showToast(error.message ?? t("common.errorGeneric"), "danger");
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

// Genau einen Anbieter offen zeigen: den, der als Nächstes Aufmerksamkeit
// braucht. Reihenfolge: Drive-Creds gesetzt aber noch nicht verbunden (der
// OAuth-Klick fehlt) > der aktive externe Anbieter (Status offen halten) > gar
// kein externes Ziel eingerichtet → Drive als beworbenes Standard-Ziel offen.
// WebDAV klappt nur auf, wenn es das aktive Ziel ist; sonst bleibt alles zu.
function pickExpandedProvider(data) {
  const drive = data.google_drive ?? {};
  const activeBackend = data.active_upload_backend ?? data.selected_upload_backend;
  if (drive.configured && !drive.connected) return "drive";
  if (activeBackend === "google_drive") return "drive";
  if (activeBackend === "webdav") return "webdav";
  const webdavReady = Boolean(data.enabled && data.configured);
  if (!drive.connected && !webdavReady) return "drive";
  return null;
}

function providerIcon(name) {
  const icon = document.createElement("i");
  icon.dataset.lucide = name;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

// Echte Warnung (amber): der Sachverhalt kann zu Datenverlust führen.
function buildProviderWarning(text) {
  const warning = document.createElement("p");
  warning.className = "settings-document-storage-warning";
  const label = document.createElement("span");
  label.textContent = text;
  warning.append(providerIcon("triangle-alert"), label);
  return warning;
}

// Information, kein Alarm: ruhiger Ton, damit nicht zwei Warnboxen stapeln.
function buildProviderNote(text, { icon = "info", hint = false } = {}) {
  const note = document.createElement("p");
  note.className = hint ? "settings-provider-note settings-provider-note--hint" : "settings-provider-note";
  const label = document.createElement("span");
  label.textContent = text;
  note.append(providerIcon(icon), label);
  return note;
}

// Führung, wenn die OAuth-Zugangsdaten fehlen: der Verbinden-Button ist dann
// inaktiv - ohne diese Zeile bliebe unklar, wie man ihn aktiviert.
function buildDriveSetupHint() {
  const hint = buildProviderNote(t("settings.documentStorageGoogleDriveSetupHint") + " ", {
    icon: "key-round",
    hint: true
  });
  const link = document.createElement("a");
  link.href =
    "https://github.com/ulsklyc/yuvomi/blob/main/docs/installation.md#google-drive-document-storage-optional";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = t("settings.documentStorageGoogleDriveSetupLink");
  hint.querySelector("span")?.appendChild(link);
  return hint;
}

function buildGoogleDriveProvider(data, reload) {
  const drive = data.google_drive ?? {};
  const provider = document.createElement("section");
  provider.className = "settings-provider";

  // Statuszeile statt wiederholter Überschrift: die Disclosure benennt bereits
  // "Google Drive". Nur "Verbunden" trägt einen Success-Ton; die übrigen Zustände
  // bleiben neutral - "noch nicht verbunden" ist kein Fehler.
  const status = document.createElement("div");
  status.className = "settings-provider__status";
  const badge = document.createElement("span");
  badge.className = drive.connected
    ? "settings-provider__badge settings-provider__badge--connected"
    : "settings-provider__badge";
  badge.textContent = drive.connected
    ? t("settings.connected")
    : drive.configured
      ? t("settings.notConnected")
      : t("settings.notConfigured");
  status.appendChild(badge);
  provider.appendChild(status);

  const description = document.createElement("p");
  description.className = "settings-card-description";
  description.textContent = t("settings.documentStorageGoogleDriveDescription");
  provider.appendChild(description);
  provider.appendChild(
    createInfoList([
      { label: t("settings.documentStorageGoogleDriveAccount"), value: drive.account_email || "–" },
      { label: t("settings.documentStorageGoogleDriveFolder"), value: drive.folder_name || "Yuvomi/Documents" },
      { label: t("settings.documentStorageGoogleDriveCount"), value: String(Number(drive.document_count ?? 0)) },
      {
        label: t("settings.documentStorageLastTest"),
        value: formatSyncTime(drive.last_test) ?? t("settings.documentStorageNeverTested")
      },
      drive.last_error
        ? { label: t("settings.documentStorageLastError"), value: drive.last_error, tone: "danger" }
        : null
    ])
  );

  // Backup-Hinweis bleibt eine echte Warnung (DB-Backups sichern Drive-Metadaten,
  // nicht die Binärdateien). Der Datenschutz-Hinweis ist Information, kein Alarm.
  provider.appendChild(buildProviderWarning(t("settings.documentStorageBackupWarning")));
  provider.appendChild(buildProviderNote(t("settings.documentStorageGoogleDrivePrivacy")));
  if (!drive.configured) provider.appendChild(buildDriveSetupHint());

  const actions = document.createElement("div");
  actions.className = "settings-form-actions";
  // Verbinden ist die Kernaktion, solange nichts verbunden ist → Primary
  // (Modul-Akzent). Nach Verbindung tritt "Neu verbinden" als Secondary zurück.
  const connect = document.createElement("a");
  connect.className = drive.connected ? "btn btn--secondary" : "btn btn--primary";
  connect.href = "/api/v1/documents/storage/google-drive/auth";
  connect.textContent = drive.connected
    ? t("settings.documentStorageGoogleDriveReconnect")
    : t("settings.documentStorageGoogleDriveConnect");
  if (!drive.configured) {
    connect.className = "btn btn--secondary";
    connect.removeAttribute("href");
    connect.setAttribute("aria-disabled", "true");
  }
  actions.appendChild(connect);

  if (drive.connected) {
    const testButton = document.createElement("button");
    testButton.type = "button";
    testButton.className = "btn btn--secondary";
    testButton.textContent = t("settings.documentStorageTest");
    testButton.addEventListener("click", async () => {
      testButton.disabled = true;
      try {
        await api.post("/documents/storage/google-drive/test", {});
        showToast(t("settings.documentStorageTestSuccess"), "success");
        await reload();
      } catch (error) {
        showToast(error.message ?? t("common.errorGeneric"), "danger");
      } finally {
        testButton.disabled = false;
      }
    });
    actions.appendChild(testButton);

    const disconnect = document.createElement("button");
    disconnect.type = "button";
    disconnect.className = "btn btn--danger";
    disconnect.textContent = t("settings.disconnect");
    disconnect.disabled = !drive.can_disconnect;
    if (!drive.can_disconnect) disconnect.title = t("settings.documentStorageGoogleDriveDisconnectBlocked");
    disconnect.addEventListener("click", async () => {
      const confirmed = await confirmModal(t("settings.documentStorageGoogleDriveDisconnectConfirm"), {
        confirmLabel: t("settings.disconnect")
      });
      if (!confirmed) return;
      disconnect.disabled = true;
      try {
        await api.delete("/documents/storage/google-drive/disconnect");
        showToast(
          t("settings.disconnectedToast", { provider: t("settings.documentStorageGoogleDriveTitle") }),
          "success"
        );
        await reload();
      } catch (error) {
        showToast(error.message ?? t("common.errorGeneric"), "danger");
        disconnect.disabled = false;
      }
    });
    actions.appendChild(disconnect);
  }
  provider.appendChild(actions);
  return provider;
}

function handleDriveOAuthCallback(container, query) {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams(query || "");
  const ok = params.get("drive_ok");
  const error = params.get("drive_error");
  if (!ok && !error) return;
  const banner = document.createElement("div");
  banner.className = `settings-banner ${ok ? "settings-banner--success" : "settings-banner--error"}`;
  banner.setAttribute("role", ok ? "status" : "alert");
  banner.textContent = ok
    ? t("settings.documentStorageGoogleDriveOAuthSuccess")
    : t("settings.documentStorageGoogleDriveOAuthError");
  container.querySelector("#document-storage-banner")?.replaceChildren(banner);
  try {
    const url = new URL(location.href);
    url.searchParams.delete("drive_ok");
    url.searchParams.delete("drive_error");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  } catch {
    // Ignore unavailable location state in restricted contexts.
  }
}

async function loadDocumentStorageConfig(container) {
  const statusHost = container.querySelector("#document-storage-status-host");
  const destinationHost = container.querySelector("#document-storage-destination-host");
  const providersHost = container.querySelector("#document-storage-providers-host");
  if (!statusHost || !destinationHost || !providersHost) return;

  const reload = () => loadDocumentStorageConfig(container);

  let data;
  try {
    const res = await api.get("/documents/storage/config");
    data = res.data ?? {};
  } catch (err) {
    statusHost.replaceChildren(
      createRetryState({
        message: err.message || t("common.errorGeneric"),
        onRetry: reload
      })
    );
    destinationHost.replaceChildren();
    providersHost.replaceChildren();
    return;
  }

  statusHost.replaceChildren(buildStatusSummary(data));

  // Anbieter-Einrichtung steht über der Ziel-Wahl: erst einrichten, dann wählen.
  // Der handlungsbedürftige Anbieter startet offen, der Rest bleibt eingeklappt.
  const expanded = pickExpandedProvider(data);
  const form = buildConnectionForm();
  const webdav = createDisclosure({
    id: "document-storage-connection",
    summary: t("settings.documentStorageWebdavTitle"),
    expanded: expanded === "webdav",
    content: form
  });
  const drive = createDisclosure({
    id: "document-storage-google-drive",
    summary: t("settings.documentStorageGoogleDriveTitle"),
    expanded: expanded === "drive",
    content: buildGoogleDriveProvider(data, reload)
  });
  providersHost.replaceChildren(webdav, drive);
  destinationHost.replaceChildren(buildDestinationForm(data, reload));

  applyConfigToForm(form, data);
  bindConnectionForm(container, form, reload);
  window.lucide?.createIcons({ el: container });
}

export async function render(container, { query } = {}) {
  renderPage(container);
  handleDriveOAuthCallback(container, query);
  await loadDocumentStorageConfig(container);
  window.lucide?.createIcons({ el: container });
}
