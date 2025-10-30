let lastQuery = "";

export function setLastSearchQuery(value: string) {
  lastQuery = value;
}

export function getLastSearchQuery() {
  return lastQuery;
}

export function clearLastSearchQuery() {
  lastQuery = "";
}
