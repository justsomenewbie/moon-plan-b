import test from "node:test";
import assert from "node:assert/strict";
import { savedLocale, translate, vietnamese } from "../lib/i18n.ts";

test("English is the default; only an explicit Vietnamese preference changes it", () => {
  for (const value of [null, "", "en", "vi-VN", "VI", "<script>"]) assert.equal(savedLocale(value), "en");
  assert.equal(savedLocale("vi"), "vi");
});

test("messages translate at display time and preserve supplied values and unknown diagnostics", () => {
  const message = { text: "Loaded {count} observation windows.", values: { count: 0 } };
  assert.equal(translate("en", message), "Loaded 0 observation windows.");
  assert.equal(translate("vi", message), "Đã tải 0 khoảng thời gian quan trắc.");
  for (const text of ["2026-11-14T06:00:15.125Z", "Original producer explanation: <data>", "toString", "constructor"]) assert.equal(translate("vi", text), text);
  assert.equal(translate("vi", "{constructor}", {}), "{constructor}");
  assert.equal(translate("vi", "Import rejected: {reason} The previous dataset has not changed.", { reason: "$& <raw diagnostic>" }), "Không thể nhập: $& <raw diagnostic> Bộ dữ liệu trước đó không thay đổi.");
});

test("every Vietnamese translation retains the English message parameters", () => {
  const parameters = (text: string) => [...text.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort();
  for (const [english, vietnameseText] of Object.entries(vietnamese)) {
    assert.ok(vietnameseText.trim(), english);
    assert.deepEqual(parameters(vietnameseText), parameters(english), english);
  }
});
