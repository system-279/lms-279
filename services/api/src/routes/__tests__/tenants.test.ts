/**
 * POST /api/v2/tenants (routes/tenants.ts) の認証ガード統合テスト
 *
 * 確認対象:
 *   - Issue #294 / ADR-031: `verifyIdToken` 直接呼び出し経路への境界統一
 *     - checkRevoked=true で revoke 後のトークンを拒否
 *     - email_verified=true 必須（未検証メールでのテナント作成禁止）
 *     - sign_in_provider=google.com 必須（IdP 追加時のバイパス防止）
 *     - 不適合時は 403 を返し、成功経路（Firestore アクセス）に進まない
 *
 * スコープ外: テナント作成の正常系（Firestore トランザクション成功経路）は
 *             Firestore モックが広範になるため本テストでは扱わず、別 Issue で担保する。
 *
 * 補足: `verifyAuthToken` は POST `/` と GET `/mine` の両方で共通使用される。
 *       本テストは POST 経路で代表して検証し、GET `/mine` は同じ関数を通るため
 *       ガード効果は自動的に波及する。`verifyAuthToken` の分岐を変更する場合は
 *       `mine` 経路のテストを追加すること。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mockVerifyIdToken = vi.fn();
const throwFirestoreImpl = () => {
  throw new Error(
    "getFirestore should not be called in guard-rejection tests (reached Firestore after guard was supposed to 403)"
  );
};
const mockGetFirestore = vi.fn(throwFirestoreImpl);

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    verifyIdToken: mockVerifyIdToken,
  }),
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => mockGetFirestore(),
}));

function makeDecodedToken(overrides: Record<string, unknown> = {}) {
  return {
    uid: "uid-default",
    email: "owner@example.com",
    name: "Owner User",
    email_verified: true,
    firebase: { sign_in_provider: "google.com", identities: {} },
    ...overrides,
  };
}

async function buildApp() {
  const { tenantsRouter } = await import("../tenants.js");
  const app = express();
  app.use(express.json());
  app.use("/api/v2/tenants", tenantsRouter);
  return app;
}

describe("POST /api/v2/tenants — auth guards (Issue #294)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockVerifyIdToken.mockReset();
    // Firestore は guard で到達しないことを期待（throw に固定）
    mockGetFirestore.mockReset();
    mockGetFirestore.mockImplementation(throwFirestoreImpl);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Authorization ヘッダ欠落時は 401", async () => {
    const app = await buildApp();
    const res = await supertest(app)
      .post("/api/v2/tenants")
      .send({ name: "Test Org" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("verifyIdToken は checkRevoked=true で呼ばれる", async () => {
    // 正常系に進めないように email_verified=false で 403 に落とす。
    // 目的は "checkRevoked=true" で呼ばれたかだけを検証すること。
    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ email_verified: false })
    );
    const app = await buildApp();

    await supertest(app)
      .post("/api/v2/tenants")
      .set("authorization", "Bearer id-token-xyz")
      .send({ name: "Test Org" });

    expect(mockVerifyIdToken).toHaveBeenCalledWith("id-token-xyz", true);
  });

  it("email_verified=false なら 403 でテナント作成を拒否", async () => {
    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ email_verified: false })
    );
    const app = await buildApp();

    const res = await supertest(app)
      .post("/api/v2/tenants")
      .set("authorization", "Bearer dummy")
      .send({ name: "Test Org" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("unauthorized");
  });

  it("email_verified が undefined（欠落）なら 403", async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-missing",
      email: "owner@example.com",
      firebase: { sign_in_provider: "google.com", identities: {} },
      // email_verified フィールドなし
    });
    const app = await buildApp();

    const res = await supertest(app)
      .post("/api/v2/tenants")
      .set("authorization", "Bearer dummy")
      .send({ name: "Test Org" });

    expect(res.status).toBe(403);
  });

  it("sign_in_provider=password なら 403（Google 以外の provider を拒否）", async () => {
    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({
        firebase: { sign_in_provider: "password", identities: {} },
      })
    );
    const app = await buildApp();

    const res = await supertest(app)
      .post("/api/v2/tenants")
      .set("authorization", "Bearer dummy")
      .send({ name: "Test Org" });

    expect(res.status).toBe(403);
  });

  it("decodedToken.firebase が undefined でも 403（fail-closed, SDK 形状変化対策）", async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-no-firebase",
      email: "owner@example.com",
      email_verified: true,
      // firebase フィールドなし
    });
    const app = await buildApp();

    const res = await supertest(app)
      .post("/api/v2/tenants")
      .set("authorization", "Bearer dummy")
      .send({ name: "Test Org" });

    expect(res.status).toBe(403);
  });

  it("verifyIdToken が throw（トークン検証失敗）なら従来通り 401", async () => {
    mockVerifyIdToken.mockRejectedValue(
      Object.assign(new Error("token expired"), {
        code: "auth/id-token-expired",
      })
    );
    const app = await buildApp();

    const res = await supertest(app)
      .post("/api/v2/tenants")
      .set("authorization", "Bearer expired-token")
      .send({ name: "Test Org" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });
});

// =====================================================================
// GET /api/v2/tenants/mine — owner + invited 統合 (allowed_emails 横断)
// =====================================================================
//
// 設計上の確認 (services/api/src/routes/tenants.ts の /mine JSDoc 参照):
//   - owner ownerId クエリ + allowed_emails collectionGroup query を並列実行
//   - 重複排除キー = tenantId（owner と invited 両方該当時は 1 件のみ返却）
//   - tenant doc は getAll(...refs) で取得（chunk 不要）
//   - status filter は in-memory で適用
//   - decodedToken.email 欠落時は invited 検索を行わず owner のみ返す（fail-closed）
//
// 既知制約のテスト (AC-13): /mine は GCIP UID 揺り戻しによる偽陽性を含み得る。
// 一覧返却ロジック自体は CAS と独立のため、ここでは「invited として allowed_emails
// に登録されていれば、users コレクションに既存 user / firebaseUid 紐付けがあろうと
// なかろうと一覧に出る」ことを回帰テストとして固定する。

type AllowedEmailDocSpec = { tenantId: string; email: string };
type TenantDocSpec = {
  id: string;
  name: string;
  ownerEmail: string;
  ownerId: string;
  status: "active" | "suspended";
  /** ISO string。null は欠落扱い */
  createdAt: string | null;
};

/**
 * /mine 用 Firestore モックを構築する。
 *
 * - `db.collection("tenants").where("ownerId","==",uid).get()` →
 *   `tenants` のうち `ownerId === uid` を返す。
 * - `db.collectionGroup("allowed_emails").where("email","==",email).get()` →
 *   `allowedEmails` のうち `email === email` を返す。各 doc の
 *   `ref.parent.parent` は `tenants/{tenantId}` の DocumentReference を指す。
 * - `db.getAll(...refs)` → 渡された ref id に対応する tenant doc を返す
 *   （存在しない id は `{ exists: false }` の DocumentSnapshot を返す）。
 */
function makeMineFirestoreMock(opts: {
  tenants: TenantDocSpec[];
  allowedEmails: AllowedEmailDocSpec[];
}) {
  const tenantById = new Map<string, TenantDocSpec>();
  for (const t of opts.tenants) tenantById.set(t.id, t);

  const toTenantSnapshot = (id: string) => {
    const t = tenantById.get(id);
    if (!t) {
      return { id, exists: false, data: () => undefined };
    }
    const data = {
      ...t,
      // tenants.ts は createdAt?.toDate?.()?.toISOString() を呼ぶ。
      // null なら toDate を呼ばないので undefined のままで良い。
      createdAt:
        t.createdAt === null
          ? null
          : { toDate: () => new Date(t.createdAt as string) },
    };
    return { id, exists: true, data: () => data };
  };

  const makeTenantRef = (tenantId: string) => ({
    id: tenantId,
    // allowedDoc.ref.parent.parent.id でも参照される
  });

  const makeAllowedDoc = (spec: AllowedEmailDocSpec, idx: number) => ({
    id: `allowed-${idx}`,
    ref: {
      parent: {
        parent: makeTenantRef(spec.tenantId),
      },
    },
    data: () => ({ email: spec.email }),
  });

  type OwnerFilters = { ownerId?: unknown; status?: unknown };
  // owner query は `where("ownerId").where("status")` のように chain される。
  // 各 where 呼び出しごとに新しい builder を返し、累積した filter で get() する。
  const makeOwnerQuery = (filters: OwnerFilters) => ({
    where(field: string, op: string, value: unknown) {
      if (op !== "==") {
        throw new Error(`Unexpected where op: ${op}`);
      }
      if (field === "ownerId") {
        return makeOwnerQuery({ ...filters, ownerId: value });
      }
      if (field === "status") {
        return makeOwnerQuery({ ...filters, status: value });
      }
      throw new Error(`Unexpected where field: ${field}`);
    },
    async get() {
      let matched = opts.tenants;
      if (filters.ownerId !== undefined) {
        matched = matched.filter((t) => t.ownerId === filters.ownerId);
      }
      if (filters.status !== undefined) {
        matched = matched.filter((t) => t.status === filters.status);
      }
      return {
        docs: matched.map((t) => toTenantSnapshot(t.id)),
      };
    },
  });

  return {
    collection(name: string) {
      if (name !== "tenants") {
        throw new Error(`Unexpected collection: ${name}`);
      }
      return makeOwnerQuery({});
    },
    collectionGroup(name: string) {
      if (name !== "allowed_emails") {
        throw new Error(`Unexpected collectionGroup: ${name}`);
      }
      return {
        where(field: string, op: string, value: unknown) {
          if (field !== "email" || op !== "==") {
            throw new Error(`Unexpected where: ${field} ${op}`);
          }
          return {
            async get() {
              const matched = opts.allowedEmails.filter(
                (a) => a.email === value
              );
              return {
                docs: matched.map((a, i) => makeAllowedDoc(a, i)),
              };
            },
          };
        },
      };
    },
    async getAll(...refs: { id: string }[]) {
      return refs.map((r) => toTenantSnapshot(r.id));
    },
  };
}

describe("GET /api/v2/tenants/mine — owner + invited 統合", () => {
  beforeEach(() => {
    vi.resetModules();
    mockVerifyIdToken.mockReset();
    mockGetFirestore.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function setMine(opts: {
    tenants: TenantDocSpec[];
    allowedEmails: AllowedEmailDocSpec[];
  }) {
    mockGetFirestore.mockReturnValue(makeMineFirestoreMock(opts) as never);
  }

  function decoded(uid: string, email: string | undefined) {
    return makeDecodedToken({ uid, email });
  }

  // -------------------------------------------------------------------
  // AC-1: owner=user, invited 0 件 → 当該 1 件返却
  // -------------------------------------------------------------------
  it("[AC-1] owner のみ: ownerId 一致テナント 1 件を返す", async () => {
    mockVerifyIdToken.mockResolvedValue(decoded("uid-1", "owner@example.com"));
    setMine({
      tenants: [
        {
          id: "t-own",
          name: "Owner Tenant",
          ownerEmail: "owner@example.com",
          ownerId: "uid-1",
          status: "active",
          createdAt: "2026-04-20T00:00:00.000Z",
        },
      ],
      allowedEmails: [],
    });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(1);
    expect(res.body.tenants[0].id).toBe("t-own");
  });

  // -------------------------------------------------------------------
  // AC-2: owner 0 件 + allowed_emails に email 登録のテナント 1 件
  //       → 招待テナントが 1 件返る
  // -------------------------------------------------------------------
  it("[AC-2] invited のみ: allowed_emails 経由で 1 件返る", async () => {
    mockVerifyIdToken.mockResolvedValue(
      decoded("uid-invited", "guest@example.com")
    );
    setMine({
      tenants: [
        {
          id: "t-inv",
          name: "Invited Tenant",
          ownerEmail: "owner@example.com",
          ownerId: "uid-other",
          status: "active",
          createdAt: "2026-04-19T00:00:00.000Z",
        },
      ],
      allowedEmails: [{ tenantId: "t-inv", email: "guest@example.com" }],
    });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(1);
    expect(res.body.tenants[0].id).toBe("t-inv");
  });

  // -------------------------------------------------------------------
  // AC-3: owner 1 + 別テナントに invited 1 → 2 件、重複なし
  // -------------------------------------------------------------------
  it("[AC-3] owner + 別テナントの invited → 2 件返る (重複なし)", async () => {
    mockVerifyIdToken.mockResolvedValue(
      decoded("uid-mixed", "user@example.com")
    );
    setMine({
      tenants: [
        {
          id: "t-own",
          name: "Owner Tenant",
          ownerEmail: "user@example.com",
          ownerId: "uid-mixed",
          status: "active",
          createdAt: "2026-04-20T00:00:00.000Z",
        },
        {
          id: "t-inv",
          name: "Invited Tenant",
          ownerEmail: "another@example.com",
          ownerId: "uid-other",
          status: "active",
          createdAt: "2026-04-18T00:00:00.000Z",
        },
      ],
      allowedEmails: [{ tenantId: "t-inv", email: "user@example.com" }],
    });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    const ids = res.body.tenants.map((t: { id: string }) => t.id).sort();
    expect(ids).toEqual(["t-inv", "t-own"]);
  });

  // -------------------------------------------------------------------
  // AC-4: 同一テナントで owner かつ invited → 1 件のみ (重複排除)
  // -------------------------------------------------------------------
  it("[AC-4] 同一テナントで owner かつ invited → 1 件のみ (重複排除)", async () => {
    mockVerifyIdToken.mockResolvedValue(decoded("uid-dup", "dup@example.com"));
    setMine({
      tenants: [
        {
          id: "t-dup",
          name: "Dup Tenant",
          ownerEmail: "dup@example.com",
          ownerId: "uid-dup",
          status: "active",
          createdAt: "2026-04-20T00:00:00.000Z",
        },
      ],
      // owner 自身も allowed_emails に登録されている (テナント作成時に自動追加される)
      allowedEmails: [{ tenantId: "t-dup", email: "dup@example.com" }],
    });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(1);
    expect(res.body.tenants[0].id).toBe("t-dup");
  });

  // -------------------------------------------------------------------
  // AC-5: ?status=active で suspended owner tenant を除外
  // -------------------------------------------------------------------
  it("[AC-5] status=active で suspended owner tenant を除外", async () => {
    mockVerifyIdToken.mockResolvedValue(decoded("uid-1", "owner@example.com"));
    setMine({
      tenants: [
        {
          id: "t-active",
          name: "A",
          ownerEmail: "owner@example.com",
          ownerId: "uid-1",
          status: "active",
          createdAt: "2026-04-20T00:00:00.000Z",
        },
        {
          id: "t-susp",
          name: "S",
          ownerEmail: "owner@example.com",
          ownerId: "uid-1",
          status: "suspended",
          createdAt: "2026-04-19T00:00:00.000Z",
        },
      ],
      allowedEmails: [],
    });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine?status=active")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(1);
    expect(res.body.tenants[0].id).toBe("t-active");
  });

  // -------------------------------------------------------------------
  // AC-6: ?status=active で suspended invited tenant も除外
  // -------------------------------------------------------------------
  it("[AC-6] status=active で suspended invited tenant も除外", async () => {
    mockVerifyIdToken.mockResolvedValue(
      decoded("uid-g", "guest@example.com")
    );
    setMine({
      tenants: [
        {
          id: "t-inv-susp",
          name: "Invited Suspended",
          ownerEmail: "o@example.com",
          ownerId: "uid-other",
          status: "suspended",
          createdAt: "2026-04-19T00:00:00.000Z",
        },
      ],
      allowedEmails: [{ tenantId: "t-inv-susp", email: "guest@example.com" }],
    });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine?status=active")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // AC-7: email_verified=false → 403 (verifyAuthToken の guard 維持)
  // -------------------------------------------------------------------
  it("[AC-7] email_verified=false → 403", async () => {
    mockVerifyIdToken.mockResolvedValue(
      makeDecodedToken({ email_verified: false })
    );
    // Firestore に到達しないことを期待
    mockGetFirestore.mockImplementation(throwFirestoreImpl);
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------
  // AC-8: tenants 1 件 → FE は自動 redirect (FE 既存ロジックの責務として
  //       本テストでは API が 1 件返すことを保証)
  // -------------------------------------------------------------------
  it("[AC-8] 単一テナント返却で FE 自動 redirect 条件を満たす", async () => {
    mockVerifyIdToken.mockResolvedValue(decoded("uid-1", "u@example.com"));
    setMine({
      tenants: [
        {
          id: "t-only",
          name: "Only",
          ownerEmail: "u@example.com",
          ownerId: "uid-1",
          status: "active",
          createdAt: "2026-04-20T00:00:00.000Z",
        },
      ],
      allowedEmails: [],
    });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine?status=active")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // AC-9: tenants 0 件 → 「所属なし」表示の根拠として空配列を返す
  // -------------------------------------------------------------------
  it("[AC-9] owner も invited もなければ空配列", async () => {
    mockVerifyIdToken.mockResolvedValue(decoded("uid-no", "no@example.com"));
    setMine({ tenants: [], allowedEmails: [] });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toEqual([]);
  });

  // -------------------------------------------------------------------
  // AC-10: invited tenant に users 未作成でも一覧に出る
  //        (allowed_emails が discovery の正本である設計の確認)
  // -------------------------------------------------------------------
  it("[AC-10] invited tenant に users 未作成でも返る", async () => {
    mockVerifyIdToken.mockResolvedValue(decoded("uid-new", "new@example.com"));
    setMine({
      tenants: [
        {
          id: "t-no-user",
          name: "No User Yet",
          ownerEmail: "o@example.com",
          ownerId: "uid-other",
          status: "active",
          createdAt: "2026-04-20T00:00:00.000Z",
        },
      ],
      allowedEmails: [{ tenantId: "t-no-user", email: "new@example.com" }],
    });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(1);
    expect(res.body.tenants[0].id).toBe("t-no-user");
  });

  // -------------------------------------------------------------------
  // AC-11: allowed_email はあるが tenant doc 削除済み → 無視 (fail-closed)
  // -------------------------------------------------------------------
  it("[AC-11] allowed_email はあるが tenant doc 不在 → 無視", async () => {
    mockVerifyIdToken.mockResolvedValue(
      decoded("uid-orphan", "orphan@example.com")
    );
    setMine({
      tenants: [], // tenant doc は存在しない
      allowedEmails: [
        { tenantId: "t-deleted", email: "orphan@example.com" },
      ],
    });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toEqual([]);
  });

  // -------------------------------------------------------------------
  // AC-12: decodedToken.email 欠落時は invited 検索をスキップし
  //        owner のみ返す (fail-closed: 任意 email を allowlist 横断検索しない)
  // -------------------------------------------------------------------
  it("[AC-12] decodedToken.email 欠落 → invited 検索スキップ、owner のみ返す", async () => {
    mockVerifyIdToken.mockResolvedValue(decoded("uid-no-email", undefined));
    setMine({
      tenants: [
        {
          id: "t-own",
          name: "Owner",
          ownerEmail: "o@example.com",
          ownerId: "uid-no-email",
          status: "active",
          createdAt: "2026-04-20T00:00:00.000Z",
        },
        {
          id: "t-invited-others",
          name: "Should Not Appear",
          ownerEmail: "x@example.com",
          ownerId: "uid-other",
          status: "active",
          createdAt: "2026-04-19T00:00:00.000Z",
        },
      ],
      // この allowed_emails は collectionGroup query 自体が走らないため無視される
      allowedEmails: [
        { tenantId: "t-invited-others", email: "leak@example.com" },
      ],
    });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(1);
    expect(res.body.tenants[0].id).toBe("t-own");
  });

  // -------------------------------------------------------------------
  // AC-13: GCIP UID conflict 等で users 既存・firebaseUid 不一致でも
  //        /mine は allowed_emails ベースで invited 一覧に出す。
  //        実アクセス時の 403 は別レイヤー (tenant-auth) の責務 (既知制約)。
  // -------------------------------------------------------------------
  it("[AC-13] users 既存・firebaseUid 不一致でも allowed_emails があれば返る (回帰、既知制約)", async () => {
    mockVerifyIdToken.mockResolvedValue(
      decoded("uid-new-after-gcip", "g@example.com")
    );
    // /mine は users コレクションに依存しない。allowed_emails のみで判定する。
    setMine({
      tenants: [
        {
          id: "t-gcip",
          name: "GCIP Tenant",
          ownerEmail: "o@example.com",
          ownerId: "uid-other",
          status: "active",
          createdAt: "2026-04-20T00:00:00.000Z",
        },
      ],
      allowedEmails: [{ tenantId: "t-gcip", email: "g@example.com" }],
    });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(1);
    expect(res.body.tenants[0].id).toBe("t-gcip");
  });

  // -------------------------------------------------------------------
  // AC-14: 同一 email が 30 件超のテナントに招待 → getAll で chunk 不要
  //        (in クエリの 30 値上限の影響なし)
  // -------------------------------------------------------------------
  it("[AC-14] 30 件超の invited tenant でも全件返る (getAll で chunk 不要)", async () => {
    mockVerifyIdToken.mockResolvedValue(decoded("uid-many", "m@example.com"));
    const N = 35;
    const tenantSpecs: TenantDocSpec[] = [];
    const allowedSpecs: AllowedEmailDocSpec[] = [];
    for (let i = 0; i < N; i++) {
      const id = `t-${String(i).padStart(2, "0")}`;
      tenantSpecs.push({
        id,
        name: `Tenant ${i}`,
        ownerEmail: "o@example.com",
        ownerId: "uid-other",
        status: "active",
        // createdAt を異なる秒にして sort 安定化
        createdAt: `2026-04-20T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
      allowedSpecs.push({ tenantId: id, email: "m@example.com" });
    }
    setMine({ tenants: tenantSpecs, allowedEmails: allowedSpecs });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(N);
  });

  // -------------------------------------------------------------------
  // AC-15: ?status=invalid → 400 invalid_status
  //        Firestore に到達する前に hard fail する（"active"/"suspended" 以外）。
  // -------------------------------------------------------------------
  it("[AC-15] ?status=invalid → 400 invalid_status (Firestore 呼び出し前に拒否)", async () => {
    mockVerifyIdToken.mockResolvedValue(decoded("uid-1", "u@example.com"));
    setMine({ tenants: [], allowedEmails: [] });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine?status=pending")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_status");
  });

  // -------------------------------------------------------------------
  // AC-16: createdAt: null を含むテナント群の sort 末尾配置
  //        ISO 文字列は降順、null は最後尾に寄せる。
  // -------------------------------------------------------------------
  it("[AC-16] createdAt:null は sort 末尾に寄る (降順 + null last)", async () => {
    mockVerifyIdToken.mockResolvedValue(decoded("uid-owner", "o@example.com"));
    setMine({
      tenants: [
        {
          id: "t-old",
          name: "Old",
          ownerEmail: "o@example.com",
          ownerId: "uid-owner",
          status: "active",
          createdAt: "2026-04-18T00:00:00.000Z",
        },
        {
          id: "t-null",
          name: "Null Created",
          ownerEmail: "o@example.com",
          ownerId: "uid-owner",
          status: "active",
          createdAt: null,
        },
        {
          id: "t-new",
          name: "New",
          ownerEmail: "o@example.com",
          ownerId: "uid-owner",
          status: "active",
          createdAt: "2026-04-20T00:00:00.000Z",
        },
      ],
      allowedEmails: [],
    });
    const app = await buildApp();

    const res = await supertest(app)
      .get("/api/v2/tenants/mine")
      .set("authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.tenants.map((t: { id: string }) => t.id)).toEqual([
      "t-new",
      "t-old",
      "t-null",
    ]);
  });
});
