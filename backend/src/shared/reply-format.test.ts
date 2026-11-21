// La règle de typographie du propriétaire (pas de tirets longs), posée sur
// tous les chats par adaptChatBody.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adaptChatBody } from "../edge/_shared/llm-upstream.ts";
import { NO_LONG_DASH_RULE, stripLongDashes, withHouseStyle } from "../edge/_shared/reply-format.ts";

describe("pas de tirets longs", () => {
  it("la règle est ajoutée au message système, et ses tirets remplacés", () => {
    const out = withHouseStyle({ messages: [{ role: "system", content: "Tu es X — un agent." }, { role: "user", content: "a — b" }] });
    const [sys, user] = out.messages as Array<{ content: string }>;
    assert.ok(sys.content.startsWith("Tu es X, un agent."));
    assert.ok(sys.content.endsWith(NO_LONG_DASH_RULE));
    assert.equal(user.content, "a — b");
  });

  it("idempotent, et la règle ne s'abîme pas en repassant", () => {
    const once = withHouseStyle({ messages: [{ role: "system", content: "s" }] });
    const twice = withHouseStyle(once);
    assert.deepEqual(twice, once);
    assert.ok(!/[—–]/.test(NO_LONG_DASH_RULE));
  });

  it("sans message système, la règle passe en tête ; un message en parties aussi", () => {
    const a = withHouseStyle({ messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual((a.messages as unknown[])[0], { role: "system", content: NO_LONG_DASH_RULE });
    const b = withHouseStyle({ messages: [{ role: "system", content: [{ type: "text", text: "x – y" }] }] });
    const parts = (b.messages as Array<{ content: Array<{ text: string }> }>)[0].content;
    assert.equal(parts[0].text, "x, y");
    assert.ok(parts[1].text.includes("TYPOGRAPHIE"));
  });

  it("tout chat qui sort passe par la règle ; les embeddings non", () => {
    const chat = adaptChatBody("https://api.example.com/v1/chat/completions", { model: "m", messages: [{ role: "system", content: "s" }] });
    assert.ok(JSON.stringify(chat.messages).includes("TYPOGRAPHIE"));
    const emb = adaptChatBody("https://api.example.com/v1/embeddings", { model: "e", input: ["a"] });
    assert.equal("messages" in emb, false);
    assert.equal(stripLongDashes("Coût — 27 $"), "Coût, 27 $");
  });
});
