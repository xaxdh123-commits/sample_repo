const test = require("node:test");
const assert = require("node:assert/strict");
const { canTransition, sampleCode, packagingSampleCode, permissionGranted } = require("../src/domain");

test("status flow is forward-only and allows void before terminal", () => {
  assert.equal(canTransition("draft", "printed"), true);
  assert.equal(canTransition("printed", "claimed"), true);
  assert.equal(canTransition("printed", "sent"), true);
  assert.equal(canTransition("claimed", "sent"), true);
  assert.equal(canTransition("sent", "completed"), true);
  assert.equal(canTransition("claimed", "void"), true);
  assert.equal(canTransition("sent", "claimed"), false);
  assert.equal(canTransition("completed", "void"), false);
  assert.equal(canTransition("void", "draft"), false);
});

test("sample codes retain envelope prefixes", () => {
  assert.equal(sampleCode(1, "small"), "A0001");
  assert.equal(sampleCode(12, "large"), "B0012");
  assert.equal(sampleCode(10000, "none"), "C10000");
});

test("packaging sample codes use independent BZ prefix", () => {
  assert.equal(packagingSampleCode(1), "BZ0001");
  assert.equal(packagingSampleCode(123), "BZ0123");
});

test("permission hierarchy and wildcard", () => {
  assert.equal(permissionGranted(["sample:view"], "sample:view"), true);
  assert.equal(permissionGranted(["sample:edit"], "sample:view"), true);
  assert.equal(permissionGranted(["sample:admin"], "sample:edit"), true);
  assert.equal(permissionGranted(["*:*:*"], "sample:admin"), true);
  assert.equal(permissionGranted([], "sample:view"), false);
});
