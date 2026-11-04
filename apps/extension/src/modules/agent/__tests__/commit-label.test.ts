import { describe, it, expect } from "vitest";
import { labelCommits } from "../commit-label";

describe("labelCommits", () => {
  it.each([
    ["Place order", "en"],
    ["Buy now", "en"],
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
    ["Sipariş ver", "tr"],
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
    // A bare "buy" sits on the steps that lead to the order, not on the order.
    "Buy",
    "Purchase",
    "Comprar",
    "Kaufen",
    "购买",
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
