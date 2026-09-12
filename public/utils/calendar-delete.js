/**
 * Browser state for undoable calendar deletion.
 *
 * Pending removals are an overlay over the latest server response. The server
 * still owns the durable event, but the pending operation owns whether that
 * event may be rendered while the Undo toast is active.
 *
 * This deliberately mirrors the proven Documents folder-delete lifecycle.
 * It stays calendar-specific until both modules have enough shared invariants
 * to justify an abstraction instead of coupling two destructive workflows.
 */

const pendingByState = new WeakMap();

/**
 * Coordinate every request that may replace calendar events.
 *
 * Full range loads and event-only reconciliation share one generation lane:
 * either kind must invalidate the other. `invalidate()` also covers a quick
 * out-and-back navigation that can reuse an already loaded range without
 * starting another request.
 */
export function createCalendarLoadCoordinator() {
  let generation = 0;
  return {
    invalidate() {
      generation += 1;
    },
    async run(request, { apply, applyError = null, isCurrent = () => true }) {
      const current = ++generation;
      let result;
      try {
        result = await request();
      } catch (err) {
        if (current !== generation || !isCurrent()) return false;
        if (applyError) {
          await applyError(err);
          return true;
        }
        throw err;
      }
      if (current !== generation || !isCurrent()) return false;
      await apply(result);
      return true;
    },
  };
}

function eventKey(event) {
  return `${Number(event.id)}\u0000${event.start_datetime ?? ''}`;
}

function pendingState(state) {
  let pending = pendingByState.get(state);
  if (!pending) {
    pending = {
      eventOrder: state.events.map(eventKey),
      operations: new Set(),
      writeTails: new Map(),
    };
    pendingByState.set(state, pending);
  }
  return pending;
}

function reserveSeriesWrite(state, eventId) {
  const pending = pendingState(state);
  const key = Number(eventId);
  const previous = pending.writeTails.get(key) ?? Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  pending.writeTails.set(key, turn);
  let settled = false;

  const finish = () => {
    if (settled) return;
    settled = true;
    release();
    if (pending.writeTails.get(key) === turn) pending.writeTails.delete(key);
  };

  return {
    async run(task) {
      await previous;
      try {
        return await task();
      } finally {
        finish();
      }
    },
    cancel: finish,
  };
}

function overlayRecurrenceId(event) {
  for (const identity of [event.recurrence_id, event.recurrence_identity]) {
    if (typeof identity === 'string' && /^\d{4}-\d{2}-\d{2}/.test(identity)) {
      return identity.slice(0, 10);
    }
  }
  // Legacy expanded master rows predate explicit recurrence metadata. A linked
  // row always carries series_id + recurrence_id, so its moved display date
  // must never become the original-slot boundary.
  if (event.series_id != null) return null;
  return String(event.start_datetime ?? '').slice(0, 10);
}

function matchesDelete(event, {
  eventId,
  seriesId = eventId,
  scope,
  occurrenceDate,
  recurrenceId = occurrenceDate,
}) {
  if (scope === 'this') {
    return Number(event.id) === Number(eventId)
      && String(event.start_datetime ?? '').slice(0, 10) === occurrenceDate;
  }
  if (Number(event.series_id ?? event.id) !== Number(seriesId)) return false;
  if (scope === 'following') {
    const identity = overlayRecurrenceId(event);
    return identity !== null && identity >= recurrenceId;
  }
  return true;
}

function mergeInCanonicalOrder(current, restored, originalOrder) {
  const currentByKey = new Map(current.map((event) => [eventKey(event), event]));
  const restoredByKey = new Map(restored.map((event) => [eventKey(event), event]));
  const merged = [];
  for (const key of originalOrder) {
    const event = currentByKey.get(key) ?? restoredByKey.get(key);
    if (event) merged.push(event);
    currentByKey.delete(key);
    restoredByKey.delete(key);
  }
  merged.push(...currentByKey.values(), ...restoredByKey.values());
  return merged;
}

function eventsIncludingPendingSnapshots(state, pending) {
  const byKey = new Map();
  for (const event of state.events) byKey.set(eventKey(event), event);
  for (const operation of pending.operations) {
    for (const event of operation.removedEvents) {
      const key = eventKey(event);
      if (!byKey.has(key)) byKey.set(key, event);
    }
  }
  return [...byKey.values()];
}

/** Reapply pending removals after an optimistic change or a fresh range load. */
export function applyPendingCalendarDeleteOverlay(state, { freshEvents = false } = {}) {
  const pending = pendingByState.get(state);
  if (freshEvents && pending) {
    pending.eventOrder = state.events.map(eventKey);
    for (const operation of pending.operations) {
      operation.removedEvents = state.events.filter(operation.matches);
    }
  }
  if (!pending?.operations.size) return;
  state.events = state.events.filter((event) => {
    for (const operation of pending.operations) {
      if (operation.matches(event)) return false;
    }
    return true;
  });
}

/** Begin one optimistic removal and return its single-settlement lifecycle. */
export function beginOptimisticCalendarDelete(state, deleteScope) {
  const pending = pendingState(state);
  const candidates = eventsIncludingPendingSnapshots(state, pending);
  const operation = {
    matches: (event) => matchesDelete(event, deleteScope),
    removedEvents: candidates.filter((event) => matchesDelete(event, deleteScope)),
  };
  pending.operations.add(operation);
  applyPendingCalendarDeleteOverlay(state);

  let settled = false;
  const finish = () => {
    if (settled) return false;
    settled = true;
    pending.operations.delete(operation);
    return true;
  };

  return {
    restore() {
      if (!finish()) return false;
      state.events = mergeInCanonicalOrder(
        state.events,
        operation.removedEvents,
        pending.eventOrder,
      );
      applyPendingCalendarDeleteOverlay(state);
      if (!pending.operations.size) pendingByState.delete(state);
      return true;
    },
    commit() {
      if (!finish()) return false;
      // A committed overlapping tombstone is durable. Another pending Undo
      // must not restore rows that this operation has now removed on-server.
      for (const pendingOperation of pending.operations) {
        pendingOperation.removedEvents = pendingOperation.removedEvents
          .filter((event) => !operation.matches(event));
      }
      applyPendingCalendarDeleteOverlay(state);
      if (!pending.operations.size) pendingByState.delete(state);
      return true;
    },
  };
}

/** Wire one calendar transition to the shared delayed Undo scheduler. */
export function scheduleCalendarDeleteWithUndo({
  state,
  deleteScope,
  message,
  schedule,
  requestDelete,
  isViewActive,
  reloadEvents,
  handleError,
  render,
}) {
  const transition = beginOptimisticCalendarDelete(state, deleteScope);
  const write = reserveSeriesWrite(state, deleteScope.seriesId ?? deleteScope.eventId);
  render();
  schedule({
    message,
    commit: async ({ keepalive }) => {
      await write.run(() => requestDelete({ keepalive }));
      transition.commit();
      if (keepalive || !isViewActive()) return;
      await reloadEvents();
      render();
    },
    restore: (err) => {
      write.cancel();
      if (!transition.restore()) return;
      if (isViewActive()) render();
      if (err) void handleError(err);
    },
    restoreOnKeepaliveError: true,
  });
  return transition;
}
