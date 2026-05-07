function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function normalizeEntityId(entity) {
  if (!entity) return null;
  const raw = entity.id ?? entity._id;
  if (raw == null) return null;
  return String(raw);
}

function normalizeEntity(entity) {
  if (!entity) return null;
  const id = normalizeEntityId(entity);
  if (!id) return null;
  const cloned = { ...entity, id };
  if (cloned._id == null) cloned._id = id;
  return cloned;
}

export function getEntityLastModifiedMs(entity) {
  return toMillis(entity?.updated_at) || toMillis(entity?.created_at);
}

function sortByCreatedAtAsc(list) {
  return [...list].sort((a, b) => {
    const createdDiff = toMillis(a?.created_at) - toMillis(b?.created_at);
    if (createdDiff !== 0) return createdDiff;
    return getEntityLastModifiedMs(a) - getEntityLastModifiedMs(b);
  });
}

export function reconcileTimestampedEntities(localItems = [], serverItems = []) {
  const localMap = new Map();
  const serverMap = new Map();

  for (const row of localItems || []) {
    const normalized = normalizeEntity(row);
    if (normalized) localMap.set(normalized.id, normalized);
  }
  for (const row of serverItems || []) {
    const normalized = normalizeEntity(row);
    if (normalized) serverMap.set(normalized.id, normalized);
  }

  const allIds = new Set([...localMap.keys(), ...serverMap.keys()]);
  const merged = [];

  for (const id of allIds) {
    const localRow = localMap.get(id);
    const serverRow = serverMap.get(id);
    if (localRow && serverRow) {
      const localMs = getEntityLastModifiedMs(localRow);
      const serverMs = getEntityLastModifiedMs(serverRow);
      merged.push(localMs >= serverMs ? localRow : serverRow);
    } else {
      merged.push(localRow || serverRow);
    }
  }

  return sortByCreatedAtAsc(merged);
}

export function mergeAnnotationsByTimestamp({
  localBookmarks = [],
  localNotes = [],
  serverBookmarks = [],
  serverNotes = [],
} = {}) {
  return {
    bookmarks: reconcileTimestampedEntities(localBookmarks, serverBookmarks),
    notes: reconcileTimestampedEntities(localNotes, serverNotes),
  };
}

export function applyLocalProgressToggle({
  completedIds = [],
  progressTouchedAt = {},
  itemId,
  completed,
  touchedAt = Date.now(),
}) {
  const nextSet = new Set((completedIds || []).map((id) => String(id)));
  const key = String(itemId);
  if (completed) nextSet.add(key);
  else nextSet.delete(key);
  return {
    completedIds: [...nextSet],
    progressTouchedAt: {
      ...(progressTouchedAt || {}),
      [key]: touchedAt,
    },
  };
}

export function reconcileGuideProgressState({
  localCompletedIds = [],
  localProgressTouchedAt = {},
  serverCompletedIds = [],
  serverFetchedAt = Date.now(),
}) {
  const localSet = new Set((localCompletedIds || []).map((id) => String(id)));
  const serverSet = new Set((serverCompletedIds || []).map((id) => String(id)));
  const touchMap = { ...(localProgressTouchedAt || {}) };
  const allIds = new Set([
    ...localSet,
    ...serverSet,
    ...Object.keys(touchMap),
  ]);

  const merged = new Set();
  for (const id of allIds) {
    const touchMs = toMillis(touchMap[id]);
    if (touchMs > serverFetchedAt) {
      if (localSet.has(id)) merged.add(id);
      continue;
    }
    if (serverSet.has(id)) merged.add(id);
    delete touchMap[id];
  }

  return {
    completedIds: [...merged],
    progressTouchedAt: touchMap,
  };
}
