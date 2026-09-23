// Update metadata has an explicit size bound; SemVer itself imposes none.
export const MAX_UPDATE_VERSION_LENGTH = 256;

function invalidVersion(label) {
  return new Error(`${label} must be a strict SemVer 2.0 string of 1-${MAX_UPDATE_VERSION_LENGTH} ASCII characters`);
}

function isNumeric(identifier) {
  return !/[^0-9]/u.test(identifier);
}

function identifiers(text, numericLeadingZeroForbidden, label) {
  const values = text.split(".");
  for (const value of values) {
    if (!value || /[^0-9A-Za-z-]/u.test(value)
      || (numericLeadingZeroForbidden && isNumeric(value) && value.length > 1 && value[0] === "0")) {
      throw invalidVersion(label);
    }
  }
  return values;
}

export function parseUpdateVersion(value, label = "Update version") {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_UPDATE_VERSION_LENGTH
    || /[^0-9A-Za-z.+-]/u.test(value)) throw invalidVersion(label);
  const sections = value.split("+");
  if (sections.length > 2) throw invalidVersion(label);
  const main = sections[0];
  const separator = main.indexOf("-");
  const coreText = separator < 0 ? main : main.slice(0, separator);
  const core = coreText.split(".");
  if (core.length !== 3 || core.some((part) => !part || !isNumeric(part)
    || (part.length > 1 && part[0] === "0"))) throw invalidVersion(label);
  return {
    core,
    prerelease: separator < 0 ? [] : identifiers(main.slice(separator + 1), true, label),
    build: sections.length === 1 ? [] : identifiers(sections[1], false, label),
  };
}

function compareNumeric(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareUpdateVersions(left, right) {
  const a = parseUpdateVersion(left, "Left update version");
  const b = parseUpdateVersion(right, "Right update version");
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumeric(a.core[index], b.core[index]);
    if (order !== 0) return order;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftId = a.prerelease[index];
    const rightId = b.prerelease[index];
    if (leftId === rightId) continue;
    const leftNumeric = isNumeric(leftId);
    const rightNumeric = isNumeric(rightId);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftNumeric ? compareNumeric(leftId, rightId) : leftId < rightId ? -1 : 1;
  }
  return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length < b.prerelease.length ? -1 : 1;
}
