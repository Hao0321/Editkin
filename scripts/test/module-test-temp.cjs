/** Test-only D-drive scratch roots and explicit finite group selection. */
const fs = require("node:fs");
const path = require("node:path");

function checkedTempParent(input = process.env.EDITKIN_MODULE_TEST_TMPDIR || process.env.TEMP || process.env.TMPDIR) {
  if (typeof input !== "string" || !path.isAbsolute(input) || !/^D:[\\/]/iu.test(input)) {
    throw Error("MODULE_TEST_TEMP_REQUIRED: set EDITKIN_MODULE_TEST_TMPDIR to an absolute controlled D-drive folder");
  }
  const target = path.resolve(input);
  if (target === path.parse(target).root) throw Error("MODULE_TEST_TEMP_ROOT_REFUSED");
  const ancestors = [];
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    ancestors.push(cursor);
    if (cursor === path.dirname(cursor)) break;
  }
  for (const cursor of ancestors.reverse()) {
    let info;
    try { info = fs.lstatSync(cursor); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error("MODULE_TEST_TEMP_LINK_OR_NON_DIRECTORY");
  }
  return target;
}

function createOwnedTestRoot(t, prefix) {
  if (!/^[a-z][a-z0-9-]*-$/u.test(prefix)) throw Error("MODULE_TEST_TEMP_PREFIX_INVALID");
  const parent = checkedTempParent();
  fs.mkdirSync(parent, { recursive: true });
  const canonicalParent = fs.realpathSync(parent);
  const root = fs.mkdtempSync(path.join(parent, prefix));
  const canonicalRoot = fs.realpathSync(root);
  const inside = target => {
    const relation = path.relative(canonicalParent, target);
    return relation !== "" && !path.isAbsolute(relation) && !relation.split(/[\\/]/u).includes("..");
  };
  if (!inside(canonicalRoot)) throw Error("MODULE_TEST_TEMP_ESCAPED_PARENT");
  t.after(() => {
    checkedTempParent(parent);
    if (fs.realpathSync(parent) !== canonicalParent || fs.realpathSync(root) !== canonicalRoot
      || fs.lstatSync(root).isSymbolicLink() || !inside(canonicalRoot)) throw Error("MODULE_TEST_TEMP_CLEANUP_BOUNDARY_CHANGED");
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function selectedTestGroups(names, input = process.env.EDITKIN_MODULE_TEST_GROUP) {
  const group = input === undefined ? "all" : input;
  if (group !== "all" && !names.includes(group)) throw Error(`MODULE_TEST_GROUP_INVALID:${group}`);
  return name => group === "all" || group === name;
}

module.exports = { checkedTempParent, createOwnedTestRoot, selectedTestGroups };
