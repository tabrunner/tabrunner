import { describe, it, expect } from "vitest";
import { labelCommits } from "../commit-label";

describe("labelCommits", () => {
  it.each([
    ["Place order", "en"],
    ["Pay now", "en"],
    ["Delete account", "en"],
    ["Finalizar compra", "pt-BR"],
    ["Excluir", "pt-BR"],
    ["Confirmar pago", "es"],
    ["ENVIAR", "es"],
    ["Passer la commande", "fr"],
    ["Jetzt kaufen", "de"],
    ["Bestellung abschließen", "de"],
    ["Löschen", "de"],
    ["Conferma ordine", "it"],
    ["Bestelling plaatsen", "nl"],
    ["Zapłać", "pl"],
    ["Satın al", "tr"],
    ["Bayar sekarang", "id"],
    ["Оформить заказ", "ru"],
    ["Надіслати", "uk"],
    ["إرسال", "ar"],
    ["שלח", "he"],
    ["注文を確定する", "ja"],
    ["立即购买", "zh"],
    ["결제하기", "ko"],
  ])("flags %s (%s)", (label) => {
    expect(labelCommits(label)).toBe(true);
  });

  it("ignores accents a page drops or adds", () => {
    expect(labelCommits("Reservar")).toBe(true);
    expect(labelCommits("Reservér")).toBe(true);
    expect(labelCommits("Veröffentlichen")).toBe(true);
    expect(labelCommits("Veroffentlichen")).toBe(true);
  });

  it.each([
    "Search",
    "Next",
    "Add to cart",
    "Adicionar ao carrinho",
    "Proceed to checkout",
    "Postal code",
    "Payment history",
    "Posts",
    "Sent",
    "Continuar",
    "Suivant",
    "Weiter",
    "Siguiente",
    "検索",
    "次へ",
    "",
  ])("lets %j through", (label) => {
    expect(labelCommits(label)).toBe(false);
  });
});
