import assert from "node:assert/strict";
import test from "node:test";
import { buildQuotedUserMessage, parseQuotedUserMessage, webSearchUrl } from "./quoted-message.js";

test("builds a quoted user message with the selection at the start", () => {
  const text = buildQuotedUserMessage("第三节是物理", "改成英语");
  assert.equal(text.startsWith("引用内容：\n第三节是物理\n\n"), true);
  assert.equal(text.endsWith("改成英语"), true);
});

test("round-trips quoted messages", () => {
  const original = buildQuotedUserMessage("选中的句子\n第二行", "请解释");
  assert.deepEqual(parseQuotedUserMessage(original), { quote: "选中的句子\n第二行", body: "请解释" });
});

test("leaves unquoted messages unchanged", () => {
  assert.deepEqual(parseQuotedUserMessage("普通提问"), { body: "普通提问" });
});

test("builds a Bing search URL", () => {
  assert.equal(webSearchUrl("牛顿第一定律"), "https://cn.bing.com/search?q=%E7%89%9B%E9%A1%BF%E7%AC%AC%E4%B8%80%E5%AE%9A%E5%BE%8B");
});
