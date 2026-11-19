import { describe, expect, it } from "vitest";
import { maskFields, maskText } from "../src/core/mask";

describe("maskText", () => {
  it("masks emails", () => {
    expect(maskText("contact me at jane.doe+bug@example.co.kr please")).toEqual({
      text: "contact me at [email] please",
      redactions: 1,
    });
  });

  it("masks Korean mobile and landline numbers", () => {
    expect(maskText("010-1234-5678 / 02-123-4567 / 01012345678").text).toBe("[phone] / [phone] / [phone]");
  });

  it("masks mobile numbers glued together or to other text", () => {
    expect(maskText("01012345678010123456780101234567801012345678").text).toBe("[phone][phone][phone][phone]");
    expect(maskText("연락처01012345678입니다").text).toBe("연락처[phone]입니다");
  });

  it("masks international phone numbers", () => {
    expect(maskText("call +82 10-1234-5678").text).toBe("call [phone]");
  });

  it("masks Korean resident registration numbers", () => {
    expect(maskText("주민번호 900101-1234567").text).toBe("주민번호 [id-number]");
  });

  it("masks card numbers only when they pass the Luhn check", () => {
    expect(maskText("card 4111 1111 1111 1111").text).toBe("card [card]");
    expect(maskText("order 1234 5678 9012 3456").text).toBe("order 1234 5678 9012 3456");
  });

  it("masks secrets pasted from logs", () => {
    const text = "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and sk-ant-api03-abcdefghijklmnopqrstuv";
    expect(maskText(text).text).toBe("token [secret] and [secret]");
  });

  it("masks IPv4 addresses", () => {
    expect(maskText("server 192.168.0.12 timed out").text).toBe("server [ip] timed out");
  });

  it("leaves ordinary bug report text alone", () => {
    const text = "Clicking Save on v1.2.3 does nothing. Steps: 1. open 2. click";
    expect(maskText(text)).toEqual({ text, redactions: 0 });
  });
});

describe("maskFields", () => {
  it("masks every field and sums redactions", () => {
    const result = maskFields({ a: "a@b.com", b: "010-1111-2222 and c@d.io" });
    expect(result.fields).toEqual({ a: "[email]", b: "[phone] and [email]" });
    expect(result.redactions).toBe(3);
  });
});
