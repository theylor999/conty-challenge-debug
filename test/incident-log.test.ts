import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { seedIncident } from "../src/seed.ts";

type App = ReturnType<typeof createApp>;

function postJson(app: App, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function ledgerOf(app: App, missionId: string) {
  const res = await app.request(`/missions/${missionId}`);
  return ((await res.json()) as { ledger: Array<{ amount_brl: number }> }).ledger;
}

describe("casos do incidente que a suíte original não nomeava", () => {
  let app: App;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    seedIncident(db);
    app = createApp(db);
  });

  it("aceita o último instante do dia do prazo em São Paulo e recusa o seguinte", async () => {
    const last = await postJson(app, "/approvals", {
      mission_id: "msn_1842",
      approved_at: "2026-03-13T02:59:59.999Z",
      idempotency_key: "pay_last",
    });
    expect(last.status).toBe(201);

    const next = await postJson(app, "/approvals", {
      mission_id: "msn_1842",
      approved_at: "2026-03-13T03:00:00.000Z",
      idempotency_key: "pay_next",
    });
    expect(next.status).toBe(409);
  });

  it("credita R$ 80,00 na missão de 8000 centavos (msn_2044)", async () => {
    const res = await postJson(app, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_7c1",
    });
    expect(res.status).toBe(201);
    expect(await ledgerOf(app, "msn_2044")).toMatchObject([{ amount_brl: 80 }]);
  });

  it("trata a chave com espaço de largura zero como a mesma chave (msn_2044)", async () => {
    const payload = {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
    };
    expect((await postJson(app, "/approvals", { ...payload, idempotency_key: "pay_7c1" })).status).toBe(201);
    const retry = await postJson(app, "/approvals", { ...payload, idempotency_key: "pay_7c1\u200b" });
    expect(retry.status).toBe(200);
    expect(await ledgerOf(app, "msn_2044")).toHaveLength(1);
  });

  it("grava a chave sem caracteres invisíveis, espaços e maiúsculas", async () => {
    const res = await postJson(app, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: " PAY_7c1\u200b ",
    });
    const { ledger } = (await res.json()) as { ledger: { idempotency_key: string } };
    expect(ledger.idempotency_key).toBe("pay_7c1");
  });

  it("recusa chave que só tem caracteres invisíveis", async () => {
    const res = await postJson(app, "/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: " \u200b\ufeff",
    });
    expect(res.status).toBe(400);
  });

  it("não credita duas vezes a mesma missão com chaves diferentes", async () => {
    const payload = { mission_id: "msn_1900", approved_at: "2026-03-12T18:11:00.000Z" };
    expect((await postJson(app, "/approvals", { ...payload, idempotency_key: "pay_a" })).status).toBe(201);
    expect((await postJson(app, "/approvals", { ...payload, idempotency_key: "pay_b" })).status).toBe(200);
    expect(await ledgerOf(app, "msn_1900")).toHaveLength(1);
  });

  it("a mesma chave em outra missão não esconde o crédito dela", async () => {
    const at = "2026-03-12T18:11:00.000Z";
    await postJson(app, "/approvals", { mission_id: "msn_1900", approved_at: at, idempotency_key: "pay_shared" });
    const other = await postJson(app, "/approvals", {
      mission_id: "msn_2044",
      approved_at: at,
      idempotency_key: "pay_shared",
    });
    expect(other.status).toBe(201);
    expect(await ledgerOf(app, "msn_2044")).toHaveLength(1);
  });

  it("mantém PENDING pendente e grava o status do provedor", async () => {
    const approval = await postJson(app, "/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_22a",
    });
    const { payout } = (await approval.json()) as { payout: { id: string } };
    await postJson(app, `/payouts/${payout.id}/provider`, { provider_status: "PENDING" });
    const mission = (await (await app.request("/missions/msn_1900")).json()) as {
      payout: { status: string; provider_status: string };
    };
    expect(mission.payout).toMatchObject({ status: "pending", provider_status: "PENDING" });
  });

  it("quita o repasse quando o provedor manda CONFIRMED", async () => {
    const approval = await postJson(app, "/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: "pay_22a",
    });
    const { payout } = (await approval.json()) as { payout: { id: string } };
    const res = await postJson(app, `/payouts/${payout.id}/provider`, { provider_status: "CONFIRMED" });
    expect(((await res.json()) as { status: string }).status).toBe("paid");
  });
});
